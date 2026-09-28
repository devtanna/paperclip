import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { activeMemberIds, notifyPeople } from "./engine.js";
import { gatherPulse } from "./pulse.js";
import { describeTiming, MAX_ACTIVE_SCHEDULES, normalizeSchedule } from "./schedules.js";
import {
  countActiveSchedules,
  createCommitment,
  deleteSchedule,
  getSchedule,
  getSettings,
  insertSchedule,
  listCommitments,
  listSchedules,
  setCommitmentStatus,
  updateSchedule,
  type Schedule,
} from "./store.js";

type ToolParams = Record<string, unknown>;

export { COPILOT_TOOL_NAMES } from "../tool-names.js";
import { COPILOT_TOOL_NAMES } from "../tool-names.js";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireText(value: unknown, name: string): string {
  const result = text(value);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function formatSchedule(schedule: Schedule): string {
  const state = schedule.enabled ? `next ${schedule.nextRunAt ?? "—"}` : "disabled";
  return `[${schedule.id}] ${schedule.name}: ${describeTiming(schedule)}, ${state}${schedule.systemKey ? " (built-in)" : ""}`;
}

/** Only the company's Copilot may message people. */
async function requireCopilot(ctx: PluginContext, run: ToolRunContext) {
  const settings = await getSettings(ctx.db, run.companyId);
  if (!settings.agentId || settings.agentId !== run.agentId) {
    throw new Error("Only the company Copilot can do this");
  }
  return settings;
}

async function scheduleOwnedBy(ctx: PluginContext, run: ToolRunContext, id: string): Promise<Schedule> {
  const schedule = await getSchedule(ctx.db, run.companyId, id);
  if (!schedule) throw new Error(`No schedule ${id}`);
  const settings = await getSettings(ctx.db, run.companyId);
  const isCopilot = settings.agentId === run.agentId;
  if (!isCopilot && schedule.createdById !== run.agentId && schedule.targetAgentId !== run.agentId) {
    throw new Error("You can only change your own schedules");
  }
  return schedule;
}

export function registerCopilotTools(ctx: PluginContext): void {
  const register = (
    name: (typeof COPILOT_TOOL_NAMES)[number],
    displayName: string,
    fn: (params: ToolParams, run: ToolRunContext) => Promise<ToolResult>,
  ) => {
    const declared = ctx.manifest.tools?.find((tool) => tool.name === name);
    ctx.tools.register(
      name,
      {
        displayName,
        description: declared?.description ?? name,
        parametersSchema: declared?.parametersSchema ?? { type: "object" },
      },
      async (params, run) => {
        try {
          return await fn((params ?? {}) as ToolParams, run);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    );
  };

  register("company_pulse", "Company Pulse", async (_params, run) => {
    const settings = await getSettings(ctx.db, run.companyId);
    const pulse = await gatherPulse(ctx, settings, new Date());
    return {
      content: pulse.markdown || "The pulse is quiet: nothing stale, blocked, or waiting.",
      data: { counts: pulse.counts, itemCount: pulse.items.length },
    };
  });

  register("team_members", "Team Members", async (_params, run) => {
    const members = await ctx.access.members.list({ companyId: run.companyId });
    const people = members.filter((member) => member.principalType === "user" && member.status === "active");
    return {
      content: people.map((member) => `${member.principalId} (${member.membershipRole ?? "member"})`).join("\n") || "No members.",
      data: { members: people.map((member) => ({ userId: member.principalId, role: member.membershipRole })) },
    };
  });

  register("copilot_notify", "Message A Person", async (params, run) => {
    const settings = await requireCopilot(ctx, run);
    const message = requireText(params.message, "message");
    if (message.length > 4000) throw new Error("message must be at most 4000 characters");
    const target = requireText(params.userId, "userId");
    const userIds = target === "all" ? await activeMemberIds(ctx, run.companyId) : [target];
    const result = await notifyPeople(ctx, settings, {
      userIds,
      message,
      urgency: params.urgency === "urgent" ? "urgent" : "normal",
    });
    const skipped = result.skipped.map((entry) => `${entry.userId}: ${entry.reason}`);
    return {
      content: `Sent to ${result.sent.length} of ${userIds.length}.${skipped.length ? ` Not sent: ${skipped.join("; ")}` : ""}`,
      data: result,
    };
  });

  register("commitment_create", "Record Commitment", async (params, run) => {
    const ownerUserId = text(params.ownerUserId);
    const ownerAgentId = text(params.ownerAgentId);
    const dueAt = text(params.dueAt) ? new Date(String(params.dueAt)) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error("dueAt must be an ISO date-time");
    const commitment = await createCommitment(ctx.db, {
      companyId: run.companyId,
      ownerKind: ownerUserId ? "user" : ownerAgentId ? "agent" : "company",
      ownerId: ownerUserId ?? ownerAgentId ?? null,
      text: requireText(params.text, "text"),
      dueAt,
      sourceIssueId: text(params.issueId),
      createdByKind: "agent",
      createdById: run.agentId,
    });
    return { content: `Recorded commitment ${commitment.id}.`, data: { commitment } };
  });

  register("commitment_list", "List Commitments", async (params, run) => {
    const status = ["open", "done", "cancelled", "all"].includes(String(params.status)) ? (params.status as "open") : "open";
    const commitments = await listCommitments(ctx.db, run.companyId, { status, limit: 100 });
    return {
      content: commitments.length
        ? commitments
            .map((c) => `[${c.id}] ${c.status} · ${c.ownerKind} ${c.ownerId ?? ""}: ${c.text}${c.dueAt ? ` (due ${c.dueAt})` : ""}`)
            .join("\n")
        : "No commitments.",
      data: { commitments },
    };
  });

  register("commitment_complete", "Complete Commitment", async (params, run) => {
    const status = params.status === "cancelled" ? "cancelled" : "done";
    const ok = await setCommitmentStatus(ctx.db, run.companyId, requireText(params.id, "id"), status);
    if (!ok) throw new Error("No such commitment");
    return { content: `Commitment marked ${status}.` };
  });

  register("schedule_create", "Create Schedule", async (params, run) => {
    if ((await countActiveSchedules(ctx.db, run.companyId)) >= MAX_ACTIVE_SCHEDULES) {
      throw new Error(`This company already has ${MAX_ACTIVE_SCHEDULES} active schedules; delete some first`);
    }
    const settings = await getSettings(ctx.db, run.companyId);
    const write = normalizeSchedule(
      { ...params, targetAgentId: text(params.targetAgentId) ?? run.agentId },
      { now: new Date(), defaultTimezone: settings.timezone, defaultTargetAgentId: run.agentId },
    );
    if (write.targetAgentId && write.targetAgentId !== run.agentId) {
      const target = await ctx.agents.get(write.targetAgentId, run.companyId);
      if (!target) throw new Error("targetAgentId is not an agent in this company");
    }
    const schedule = await insertSchedule(ctx.db, run.companyId, write, { createdByKind: "agent", createdById: run.agentId });
    return { content: `Created ${formatSchedule(schedule)}`, data: { schedule } };
  });

  register("schedule_list", "List Schedules", async (_params, run) => {
    const schedules = await listSchedules(ctx.db, run.companyId);
    return { content: schedules.map(formatSchedule).join("\n") || "No schedules.", data: { schedules } };
  });

  register("schedule_update", "Update Schedule", async (params, run) => {
    const existing = await scheduleOwnedBy(ctx, run, requireText(params.id, "id"));
    const settings = await getSettings(ctx.db, run.companyId);
    const write = normalizeSchedule(params, {
      now: new Date(),
      defaultTimezone: settings.timezone,
      defaultTargetAgentId: existing.targetAgentId,
      existing,
    });
    const schedule = await updateSchedule(ctx.db, run.companyId, existing.id, write);
    return { content: `Updated ${schedule ? formatSchedule(schedule) : existing.id}`, data: { schedule } };
  });

  register("schedule_delete", "Delete Schedule", async (params, run) => {
    const existing = await scheduleOwnedBy(ctx, run, requireText(params.id, "id"));
    if (existing.systemKey) throw new Error("Built-in schedules can be disabled (schedule_update enabled=false) but not deleted");
    await deleteSchedule(ctx.db, run.companyId, existing.id);
    return { content: `Deleted schedule ${existing.name}.` };
  });
}
