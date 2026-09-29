import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isWithinWindow } from "./cron.js";
import { gatherPulse } from "./pulse.js";
import { manualWakePrompt, pulseWakePrompt, scheduleWakePrompt, SYSTEM_SCHEDULES } from "./prompts.js";
import { followingRun, isMissed, MAX_FIRES_PER_TICK, normalizeSchedule } from "./schedules.js";
import {
  claimScheduleRun,
  consumeSignals,
  deleteSchedule,
  dueSchedules,
  getSettings,
  hasUrgentSignal,
  insertSchedule,
  listCommitments,
  listEnabledSettings,
  listSchedules,
  markCommitmentsReminded,
  markPruned,
  notificationsSince,
  pruneEmbeddingCache,
  pruneHistory,
  recordNotification,
  recordPulse,
  recordScheduleResult,
  recordWake,
  saveSettings,
  updateSchedule,
  wakesSince,
  type CopilotSettings,
  type Schedule,
} from "./store.js";

export const COPILOT_AGENT_KEY = "copilot";

/**
 * Last pulse problem per company (host calls that failed, or a wake that could
 * not be delivered), shown on the Copilot page. Kept in worker memory: it
 * describes the current state, not history.
 */
const lastPulseProblem = new Map<string, { at: string; message: string }>();

export function pulseProblem(companyId: string): { at: string; message: string } | null {
  return lastPulseProblem.get(companyId) ?? null;
}

function notePulseProblem(ctx: PluginContext, companyId: string, message: string | null, now: Date) {
  if (!message) {
    lastPulseProblem.delete(companyId);
    return;
  }
  const previous = lastPulseProblem.get(companyId);
  if (previous?.message !== message) ctx.logger.warn("copilot pulse problem", { companyId, message });
  lastPulseProblem.set(companyId, { at: now.toISOString(), message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Agents that cannot take a wake right now; a running agent is retried next tick. */
type Wakeability = "ready" | "busy" | "unavailable";

async function copilotWakeability(ctx: PluginContext, settings: CopilotSettings): Promise<Wakeability> {
  if (!settings.agentId) return "unavailable";
  const agent = await ctx.agents.get(settings.agentId, settings.companyId);
  if (!agent) return "unavailable";
  if (agent.status === "running") return "busy";
  if (["paused", "terminated", "pending_approval", "error"].includes(agent.status)) return "unavailable";
  return "ready";
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

async function scheduleContext(ctx: PluginContext, schedule: Schedule, now: Date): Promise<string | null> {
  if (schedule.systemKey !== "morning-brief") return null;
  const [members, commitments] = await Promise.all([
    ctx.access.members.list({ companyId: schedule.companyId }).catch(() => []),
    listCommitments(ctx.db, schedule.companyId, { status: "open", limit: 50 }),
  ]);
  const people = members
    .filter((member) => member.principalType === "user" && member.status === "active")
    .map((member) => `- userId ${member.principalId} (${member.membershipRole ?? "member"})`);
  const settings = await getSettings(ctx.db, schedule.companyId);
  const [pulse, ideas] = await Promise.all([
    gatherPulse(ctx, settings, now).catch(() => null),
    recentAgentIdeas(ctx, schedule.companyId, now),
  ]);
  return [
    `People:\n${people.join("\n") || "- (none)"}`,
    `Open commitments:\n${commitments.map((c) => `- [${c.id.slice(0, 8)}] ${c.ownerKind} ${c.ownerId ?? ""}: ${c.text}${c.dueAt ? ` (due ${c.dueAt})` : ""}`).join("\n") || "- (none)"}`,
    `Ideas agents raised on their own since yesterday (merge duplicates; tell each person which ones wait for their approval):\n${ideas.join("\n") || "- (none)"}`,
    `Current pulse:\n${pulse?.markdown || "(quiet)"}`,
  ].join("\n\n");
}

const IDEA_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const IDEA_STATUSES = ["in_review", "todo", "in_progress", "backlog", "blocked"] as const;

/** Issues agents opened in initiative runs ("Idea: …" titles), newest first. */
async function recentAgentIdeas(ctx: PluginContext, companyId: string, now: Date): Promise<string[]> {
  const since = now.getTime() - IDEA_LOOKBACK_MS;
  const lists = await Promise.all(
    IDEA_STATUSES.map((status) => ctx.issues.list({ companyId, status, limit: 200 }).catch(() => [])),
  );
  return lists
    .flat()
    .filter((issue) => /^idea:/i.test(issue.title.trim()) && new Date(issue.createdAt).getTime() >= since)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20)
    .map((issue) => `- ${issue.identifier ?? issue.id.slice(0, 8)} [${issue.status}] ${issue.title.trim()}`);
}

async function fireSchedule(ctx: PluginContext, schedule: Schedule, settings: CopilotSettings, now: Date): Promise<void> {
  const missed = isMissed(schedule, now);
  const next = followingRun(schedule, now);
  const finished = next === null;
  const claimed = await claimScheduleRun(ctx.db, schedule, { firedAt: now, nextRunAt: next, disable: finished });
  if (!claimed) return;

  const targetAgentId = schedule.targetAgentId ?? settings.agentId;
  let status: "fired" | "failed" | "skipped" = "fired";
  let runId: string | null = null;
  let error: string | null = null;
  if (missed) {
    status = "skipped";
    error = "Missed its time by more than 2 hours (server offline?); skipped instead of firing late.";
  } else if (!targetAgentId) {
    status = "failed";
    error = "No target agent";
  } else {
    try {
      const context = await scheduleContext(ctx, schedule, now);
      runId = (
        await ctx.agents.invoke(targetAgentId, schedule.companyId, {
          prompt: scheduleWakePrompt({ name: schedule.name, message: schedule.message, context }),
          reason: "copilot_schedule",
        })
      ).runId;
    } catch (caught) {
      status = "failed";
      error = errorMessage(caught);
    }
  }
  await recordScheduleResult(ctx.db, schedule, { status, runId, error });
  if (targetAgentId && targetAgentId === settings.agentId && status === "fired") {
    await recordWake(ctx.db, {
      companyId: schedule.companyId,
      reason: `schedule:${schedule.systemKey ?? schedule.name}`,
      summary: schedule.name,
      itemCount: 0,
      runId,
      error: null,
    });
  }
  if (finished && schedule.deleteAfterRun && status !== "failed") {
    await deleteSchedule(ctx.db, schedule.companyId, schedule.id);
  }
}

async function fireDueSchedules(ctx: PluginContext, settings: CopilotSettings, now: Date): Promise<number> {
  const due = await dueSchedules(ctx.db, settings.companyId, now, MAX_FIRES_PER_TICK);
  for (const schedule of due) {
    await fireSchedule(ctx, schedule, settings, now).catch((error) =>
      ctx.logger.warn("copilot schedule failed", { scheduleId: schedule.id, error: errorMessage(error) }),
    );
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

export type PulseOutcome =
  | "not_due"
  | "outside_active_hours"
  | "quiet"
  | "unchanged"
  | "rate_limited"
  | "copilot_busy"
  | "copilot_unavailable"
  | "woke";

export async function evaluatePulse(
  ctx: PluginContext,
  settings: CopilotSettings,
  now: Date,
  options: { force?: boolean } = {},
): Promise<{ outcome: PulseOutcome; runId?: string }> {
  const urgent = await hasUrgentSignal(ctx.db, settings.companyId);
  const intervalMs = settings.pulseIntervalMinutes * 60_000;
  const due = !settings.lastPulseAt || now.getTime() - new Date(settings.lastPulseAt).getTime() >= intervalMs;
  if (!options.force && !due && !urgent) return { outcome: "not_due" };
  if (!options.force && !isWithinWindow(now, settings.activeStart, settings.activeEnd, settings.timezone)) {
    return { outcome: "outside_active_hours" };
  }

  const pulse = await gatherPulse(ctx, settings, now);
  notePulseProblem(ctx, settings.companyId, pulse.errors.length ? `Pulse data incomplete: ${pulse.errors.join("; ")}` : null, now);
  if (!options.force && pulse.items.length === 0) {
    await consumeSignals(ctx.db, pulse.signalIds);
    await recordPulse(ctx.db, settings.companyId, { at: now, hash: pulse.hash });
    return { outcome: "quiet" };
  }
  if (!options.force && pulse.hash === settings.lastPulseHash) {
    await recordPulse(ctx.db, settings.companyId, { at: now, hash: null });
    return { outcome: "unchanged" };
  }
  if (!options.force) {
    const recent = await wakesSince(ctx.db, settings.companyId, new Date(now.getTime() - 3_600_000));
    if (recent >= settings.maxWakesPerHour) {
      // Keep the old hash so this pulse is offered again once the hour frees up.
      await recordPulse(ctx.db, settings.companyId, { at: now, hash: null });
      return { outcome: "rate_limited" };
    }
  }
  let wakeability: Wakeability;
  try {
    wakeability = await copilotWakeability(ctx, settings);
  } catch (error) {
    notePulseProblem(ctx, settings.companyId, `Could not read the Copilot agent: ${errorMessage(error)}`, now);
    wakeability = "unavailable";
  }
  if (wakeability === "busy") return { outcome: "copilot_busy" };
  if (wakeability === "unavailable") {
    await recordPulse(ctx.db, settings.companyId, { at: now, hash: null });
    return { outcome: "copilot_unavailable" };
  }

  let runId: string | null = null;
  let error: string | null = null;
  try {
    runId = (
      await ctx.agents.invoke(settings.agentId!, settings.companyId, {
        prompt: options.force ? manualWakePrompt(pulse.markdown) : pulseWakePrompt(pulse.markdown, now),
        reason: options.force ? "copilot_manual_check_in" : "copilot_pulse",
      })
    ).runId;
  } catch (caught) {
    error = errorMessage(caught);
  }
  await recordWake(ctx.db, {
    companyId: settings.companyId,
    reason: options.force ? "manual" : "pulse",
    summary: pulse.items.slice(0, 5).map((item) => item.text).join("; ") || "quiet pulse",
    itemCount: pulse.items.length,
    runId,
    error,
  });
  if (error) {
    await recordPulse(ctx.db, settings.companyId, { at: now, hash: null });
    return { outcome: "copilot_unavailable" };
  }
  await consumeSignals(ctx.db, pulse.signalIds);
  await markCommitmentsReminded(ctx.db, pulse.commitmentIds, now);
  await recordPulse(ctx.db, settings.companyId, { at: now, hash: pulse.hash });
  return { outcome: "woke", runId: runId ?? undefined };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function tickCompany(ctx: PluginContext, settings: CopilotSettings, now: Date): Promise<void> {
  await fireDueSchedules(ctx, settings, now);
  const fresh = await getSettings(ctx.db, settings.companyId);
  if (fresh.enabled) {
    const { outcome } = await evaluatePulse(ctx, fresh, now);
    if (outcome === "woke") ctx.logger.info("copilot woke on pulse", { companyId: settings.companyId });
  }
  if (!fresh.lastPruneAt || now.getTime() - new Date(fresh.lastPruneAt).getTime() >= PRUNE_INTERVAL_MS) {
    const removed = await pruneHistory(ctx.db, settings.companyId, now);
    await markPruned(ctx.db, settings.companyId, now);
    ctx.logger.info("copilot pruned history", { companyId: settings.companyId, removed });
  }
}

let tickInFlight = false;
let lastCachePruneAt = 0;

/**
 * One pass over every company with the Copilot turned on. Never overlaps
 * itself; each company is isolated so one failure cannot stop the others.
 */
export async function runCopilotTick(ctx: PluginContext, now = new Date()): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    for (const settings of await listEnabledSettings(ctx.db)) {
      await tickCompany(ctx, settings, now).catch((error) =>
        ctx.logger.warn("copilot tick failed for company", { companyId: settings.companyId, error: errorMessage(error) }),
      );
    }
    if (now.getTime() - lastCachePruneAt >= PRUNE_INTERVAL_MS) {
      lastCachePruneAt = now.getTime();
      const removed = await pruneEmbeddingCache(ctx.db, 30, now);
      if (removed > 0) ctx.logger.info("pruned unused embeddings", { removed });
    }
  } finally {
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Turn on / off
// ---------------------------------------------------------------------------

export interface TurnOnResult {
  settings: CopilotSettings;
  agentId: string | null;
  agentStatus: string | null;
  needsApproval: boolean;
}

export async function turnOn(ctx: PluginContext, companyId: string, now = new Date()): Promise<TurnOnResult> {
  const resolution = await ctx.agents.managed.reconcile(COPILOT_AGENT_KEY, companyId);
  const agentId = resolution.agentId;
  if (!agentId) throw new Error("The Copilot agent could not be created");
  let agent = resolution.agent ?? (await ctx.agents.get(agentId, companyId));
  if (agent?.status === "pending_approval") {
    const settings = await saveSettings(ctx.db, companyId, { agentId, enabled: false });
    return { settings, agentId, agentStatus: agent.status, needsApproval: true };
  }
  if (agent?.status === "paused") agent = await ctx.agents.resume(agentId, companyId);

  const settings = await saveSettings(ctx.db, companyId, { agentId, enabled: true });
  await ensureSystemSchedules(ctx, settings, now);
  await skipMissedRuns(ctx, companyId, now);
  return { settings, agentId, agentStatus: agent?.status ?? null, needsApproval: false };
}

/** The kill switch: stop the pulse and every schedule, and pause the agent mid-run. */
export async function turnOff(ctx: PluginContext, companyId: string): Promise<CopilotSettings> {
  const settings = await saveSettings(ctx.db, companyId, { enabled: false });
  if (settings.agentId) {
    await ctx.agents.pause(settings.agentId, companyId).catch((error) =>
      ctx.logger.warn("could not pause copilot agent", { companyId, error: errorMessage(error) }),
    );
  }
  return settings;
}

export async function ensureSystemSchedules(ctx: PluginContext, settings: CopilotSettings, now: Date): Promise<void> {
  const existing = new Set((await listSchedules(ctx.db, settings.companyId)).map((schedule) => schedule.systemKey));
  for (const system of SYSTEM_SCHEDULES) {
    if (existing.has(system.systemKey)) continue;
    const write = normalizeSchedule(
      { name: system.name, message: system.message, cron: system.cron, timezone: settings.timezone },
      { now, defaultTimezone: settings.timezone, defaultTargetAgentId: settings.agentId },
    );
    await insertSchedule(ctx.db, settings.companyId, write, {
      systemKey: system.systemKey,
      createdByKind: "system",
      createdById: null,
    });
  }
}

/** After downtime or a pause, move overdue schedules to their next future run instead of firing a backlog. */
export async function skipMissedRuns(ctx: PluginContext, companyId: string, now: Date): Promise<void> {
  for (const schedule of await listSchedules(ctx.db, companyId)) {
    if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) continue;
    if (schedule.kind === "at") continue;
    const next = followingRun(schedule, now);
    await updateSchedule(ctx.db, companyId, schedule.id, {
      name: schedule.name,
      kind: schedule.kind,
      runAt: schedule.runAt ? new Date(schedule.runAt) : null,
      everyMinutes: schedule.everyMinutes,
      cronExpr: schedule.cronExpr,
      timezone: schedule.timezone,
      message: schedule.message,
      targetAgentId: schedule.targetAgentId,
      enabled: schedule.enabled,
      deleteAfterRun: schedule.deleteAfterRun,
      nextRunAt: next,
    });
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotifyResult {
  sent: string[];
  skipped: Array<{ userId: string; reason: string }>;
}

/** Posts a message into each person's Agent Chat with the Copilot, within the daily cap. */
export async function notifyPeople(
  ctx: PluginContext,
  settings: CopilotSettings,
  input: { userIds: string[]; message: string; urgency: "normal" | "urgent" },
  now = new Date(),
): Promise<NotifyResult> {
  if (!settings.agentId) throw new Error("The Copilot is not set up for this company");
  const result: NotifyResult = { sent: [], skipped: [] };
  const body = input.urgency === "urgent" ? `**Urgent.** ${input.message}` : input.message;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  for (const userId of [...new Set(input.userIds)]) {
    const sentToday = await notificationsSince(ctx.db, settings.companyId, userId, since);
    if (sentToday >= settings.maxNotificationsPerUserPerDay) {
      result.skipped.push({ userId, reason: `daily limit of ${settings.maxNotificationsPerUserPerDay} messages reached` });
      continue;
    }
    try {
      const conversation = await ctx.issues.ensureConversation({
        companyId: settings.companyId,
        agentId: settings.agentId,
        userId,
      });
      await ctx.issues.createComment(conversation.id, body, settings.companyId, { authorAgentId: settings.agentId });
      result.sent.push(userId);
      // The message is out; a bookkeeping failure must not report it as unsent.
      await recordNotification(ctx.db, {
        companyId: settings.companyId,
        userId,
        issueId: conversation.id,
        urgency: input.urgency,
        excerpt: input.message,
      }).catch((error) =>
        ctx.logger.warn("could not record copilot notification", { userId, error: errorMessage(error) }),
      );
    } catch (error) {
      result.skipped.push({ userId, reason: errorMessage(error) });
    }
  }
  return result;
}

export async function activeMemberIds(ctx: PluginContext, companyId: string): Promise<string[]> {
  const members = await ctx.access.members.list({ companyId });
  return members
    .filter((member) => member.principalType === "user" && member.status === "active")
    .map((member) => member.principalId);
}

