import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { isValidTimezone, parseClock } from "./cron.js";
import { evaluatePulse, pulseProblem, turnOff, turnOn } from "./engine.js";
import { gatherPulse } from "./pulse.js";
import { MAX_ACTIVE_SCHEDULES, normalizeSchedule } from "./schedules.js";
import {
  countActiveSchedules,
  deleteSchedule,
  getSchedule,
  getSettings,
  insertSchedule,
  listCommitments,
  listSchedules,
  recentNotifications,
  recentScheduleRuns,
  recentWakes,
  saveSettings,
  setCommitmentStatus,
  updateSchedule,
  type SettingsPatch,
} from "./store.js";

export const COPILOT_ROUTE_KEYS = new Set([
  "copilot",
  "copilot-enable",
  "copilot-disable",
  "copilot-settings",
  "copilot-pulse",
  "copilot-check-in",
  "schedules",
  "create-schedule",
  "update-schedule",
  "delete-schedule",
  "run-schedule",
  "commitments",
  "update-commitment",
]);

function badRequest(message: string): PluginApiResponse {
  return { status: 400, body: { error: message } };
}

function body(input: PluginApiRequestInput): Record<string, unknown> {
  return input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
}

function integerIn(value: unknown, min: number, max: number, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function parseSettingsPatch(raw: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (raw.pulseIntervalMinutes !== undefined) patch.pulseIntervalMinutes = integerIn(raw.pulseIntervalMinutes, 5, 1440, "pulseIntervalMinutes");
  if (raw.maxWakesPerHour !== undefined) patch.maxWakesPerHour = integerIn(raw.maxWakesPerHour, 1, 30, "maxWakesPerHour");
  if (raw.maxNotificationsPerUserPerDay !== undefined) {
    patch.maxNotificationsPerUserPerDay = integerIn(raw.maxNotificationsPerUserPerDay, 1, 50, "maxNotificationsPerUserPerDay");
  }
  if (raw.staleAfterHours !== undefined) patch.staleAfterHours = integerIn(raw.staleAfterHours, 1, 720, "staleAfterHours");
  for (const key of ["activeStart", "activeEnd"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || parseClock(raw[key] as string) === null) throw new Error(`${key} must be HH:MM`);
    patch[key] = raw[key] as string;
  }
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string" || !isValidTimezone(raw.timezone)) throw new Error("Unknown timezone");
    patch.timezone = raw.timezone;
  }
  return patch;
}

async function overview(ctx: PluginContext, companyId: string) {
  const settings = await getSettings(ctx.db, companyId);
  const agent = settings.agentId ? await ctx.agents.get(settings.agentId, companyId).catch(() => null) : null;
  const [wakes, notifications, scheduleRuns, schedules, commitments] = await Promise.all([
    recentWakes(ctx.db, companyId, 25),
    recentNotifications(ctx.db, companyId, 25),
    recentScheduleRuns(ctx.db, companyId, 25),
    listSchedules(ctx.db, companyId),
    listCommitments(ctx.db, companyId, { status: "open", limit: 100 }),
  ]);
  return {
    settings,
    agent: agent
      ? { id: agent.id, name: agent.name, status: agent.status, adapterType: agent.adapterType, urlKey: (agent as { urlKey?: string }).urlKey ?? null }
      : null,
    wakes,
    notifications,
    scheduleRuns,
    nextSchedule: schedules.find((schedule) => schedule.enabled && schedule.nextRunAt) ?? null,
    openCommitments: commitments.length,
    problem: pulseProblem(companyId),
  };
}

export async function handleCopilotRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const companyId = input.companyId;
  const userId = input.actor.userId ?? null;
  try {
    switch (input.routeKey) {
      case "copilot":
        return { body: await overview(ctx, companyId) };

      case "copilot-enable": {
        const result = await turnOn(ctx, companyId);
        await ctx.activity
          .log({ companyId, message: "Turned the Copilot on", entityType: "agent", entityId: result.agentId ?? undefined, metadata: { userId } })
          .catch(() => undefined);
        return { body: result };
      }

      case "copilot-disable": {
        const settings = await turnOff(ctx, companyId);
        await ctx.activity
          .log({ companyId, message: "Turned the Copilot off (kill switch)", entityType: "agent", entityId: settings.agentId ?? undefined, metadata: { userId } })
          .catch(() => undefined);
        return { body: { settings } };
      }

      case "copilot-settings": {
        const settings = await saveSettings(ctx.db, companyId, parseSettingsPatch(body(input)));
        return { body: { settings } };
      }

      case "copilot-pulse": {
        const pulse = await gatherPulse(ctx, await getSettings(ctx.db, companyId), new Date());
        return { body: { markdown: pulse.markdown, counts: pulse.counts, itemCount: pulse.items.length } };
      }

      case "copilot-check-in": {
        const settings = await getSettings(ctx.db, companyId);
        if (!settings.enabled) return badRequest("Turn the Copilot on first");
        return { body: await evaluatePulse(ctx, settings, new Date(), { force: true }) };
      }

      case "schedules":
        return { body: { schedules: await listSchedules(ctx.db, companyId) } };

      case "create-schedule": {
        if ((await countActiveSchedules(ctx.db, companyId)) >= MAX_ACTIVE_SCHEDULES) {
          return badRequest(`This company already has ${MAX_ACTIVE_SCHEDULES} active schedules`);
        }
        const settings = await getSettings(ctx.db, companyId);
        const write = normalizeSchedule(body(input), {
          now: new Date(),
          defaultTimezone: settings.timezone,
          defaultTargetAgentId: settings.agentId,
        });
        if (write.targetAgentId && !(await ctx.agents.get(write.targetAgentId, companyId))) {
          return badRequest("targetAgentId is not an agent in this company");
        }
        const schedule = await insertSchedule(ctx.db, companyId, write, { createdByKind: "user", createdById: userId });
        return { status: 201, body: { schedule } };
      }

      case "update-schedule": {
        const existing = await getSchedule(ctx.db, companyId, input.params.id ?? "");
        if (!existing) return { status: 404, body: { error: "Schedule not found" } };
        const settings = await getSettings(ctx.db, companyId);
        const write = normalizeSchedule(body(input), {
          now: new Date(),
          defaultTimezone: settings.timezone,
          defaultTargetAgentId: existing.targetAgentId,
          existing,
        });
        return { body: { schedule: await updateSchedule(ctx.db, companyId, existing.id, write) } };
      }

      case "delete-schedule": {
        const existing = await getSchedule(ctx.db, companyId, input.params.id ?? "");
        if (!existing) return { status: 404, body: { error: "Schedule not found" } };
        if (existing.systemKey) return badRequest("Built-in schedules can be disabled but not deleted");
        await deleteSchedule(ctx.db, companyId, existing.id);
        return { body: { deleted: true } };
      }

      case "run-schedule": {
        const existing = await getSchedule(ctx.db, companyId, input.params.id ?? "");
        if (!existing) return { status: 404, body: { error: "Schedule not found" } };
        const settings = await getSettings(ctx.db, companyId);
        const target = existing.targetAgentId ?? settings.agentId;
        if (!target) return badRequest("This schedule has no agent to wake");
        const { runId } = await ctx.agents.invoke(target, companyId, {
          prompt: `Scheduled (run now by a teammate): ${existing.name}\n\n${existing.message}`,
          reason: "copilot_schedule_manual",
        });
        return { body: { runId } };
      }

      case "commitments": {
        const status = String(input.query.status ?? "open");
        const commitments = await listCommitments(ctx.db, companyId, {
          status: ["open", "done", "cancelled", "all"].includes(status) ? (status as "open") : "open",
          limit: 200,
        });
        return { body: { commitments } };
      }

      case "update-commitment": {
        const status = body(input).status;
        if (status !== "open" && status !== "done" && status !== "cancelled") return badRequest("status must be open, done, or cancelled");
        const ok = await setCommitmentStatus(ctx.db, companyId, input.params.id ?? "", status);
        return ok ? { body: { updated: true } } : { status: 404, body: { error: "Commitment not found" } };
      }
    }
    return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}
