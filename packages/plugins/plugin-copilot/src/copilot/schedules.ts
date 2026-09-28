import { isValidTimezone, minimumCronIntervalMinutes, nextCronRun, parseCron } from "./cron.js";
import type { Schedule, ScheduleWrite } from "./store.js";

/** Guardrails that keep schedules from becoming a runaway loop. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_ACTIVE_SCHEDULES = 50;
export const MAX_FIRES_PER_TICK = 20;
/** A run later than this (e.g. the server was down) is skipped, not fired late. */
export const MISSED_GRACE_MS = 2 * 60 * 60 * 1000;

export interface ScheduleInput {
  name?: unknown;
  message?: unknown;
  at?: unknown;
  everyMinutes?: unknown;
  cron?: unknown;
  timezone?: unknown;
  targetAgentId?: unknown;
  enabled?: unknown;
  deleteAfterRun?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validates a create or update request and computes the next run. `existing`
 * supplies unchanged fields on update; exactly one of at, everyMinutes, cron
 * defines the timing.
 */
export function normalizeSchedule(
  input: ScheduleInput,
  options: { now: Date; defaultTimezone: string; defaultTargetAgentId: string | null; existing?: Schedule | null },
): ScheduleWrite {
  const existing = options.existing ?? null;
  const timingKeys = [input.at, input.everyMinutes, input.cron].filter((value) => value !== undefined && value !== null && value !== "");
  if (timingKeys.length > 1) throw new Error("Give only one of at, everyMinutes, or cron");

  let kind: Schedule["kind"];
  let runAt: Date | null = null;
  let everyMinutes: number | null = null;
  let cronExpr: string | null = null;
  if (input.at !== undefined && input.at !== null && input.at !== "") {
    kind = "at";
    runAt = new Date(String(input.at));
  } else if (input.everyMinutes !== undefined && input.everyMinutes !== null && input.everyMinutes !== "") {
    kind = "every";
    everyMinutes = Number(input.everyMinutes);
  } else if (text(input.cron)) {
    kind = "cron";
    cronExpr = text(input.cron);
  } else if (existing) {
    kind = existing.kind;
    runAt = existing.runAt ? new Date(existing.runAt) : null;
    everyMinutes = existing.everyMinutes;
    cronExpr = existing.cronExpr;
  } else {
    throw new Error("A schedule needs at (ISO time), everyMinutes, or cron");
  }

  const timezone = text(input.timezone) ?? existing?.timezone ?? options.defaultTimezone;
  if (!isValidTimezone(timezone)) throw new Error(`Unknown timezone: ${timezone}`);
  const name = (text(input.name) ?? existing?.name ?? "").slice(0, 120);
  if (!name) throw new Error("name is required");
  const message = text(input.message) ?? existing?.message ?? null;
  if (!message) throw new Error("message is required");
  if (message.length > 4000) throw new Error("message must be at most 4000 characters");
  const enabled = typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? true;
  const deleteAfterRun =
    typeof input.deleteAfterRun === "boolean" ? input.deleteAfterRun : existing?.deleteAfterRun ?? kind === "at";
  const targetAgentId = text(input.targetAgentId) ?? existing?.targetAgentId ?? options.defaultTargetAgentId;

  let nextRunAt: Date | null;
  if (kind === "at") {
    if (!runAt || Number.isNaN(runAt.getTime())) throw new Error("at must be an ISO date-time");
    if (runAt.getTime() > options.now.getTime() + 366 * 86_400_000) throw new Error("at must be within a year");
    nextRunAt = runAt.getTime() <= options.now.getTime() ? null : runAt;
    if (!nextRunAt && enabled) throw new Error("at must be in the future");
  } else if (kind === "every") {
    if (!Number.isInteger(everyMinutes) || everyMinutes! < MIN_INTERVAL_MINUTES || everyMinutes! > MAX_INTERVAL_MINUTES) {
      throw new Error(`everyMinutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`);
    }
    nextRunAt = new Date(options.now.getTime() + everyMinutes! * 60_000);
  } else {
    const spec = parseCron(cronExpr!);
    if (minimumCronIntervalMinutes(spec, timezone, options.now) < MIN_INTERVAL_MINUTES) {
      throw new Error(`cron schedules may run at most every ${MIN_INTERVAL_MINUTES} minutes`);
    }
    nextRunAt = nextCronRun(spec, options.now, timezone);
    if (!nextRunAt) throw new Error("cron expression never matches");
  }

  return {
    name,
    kind,
    runAt,
    everyMinutes,
    cronExpr,
    timezone,
    message,
    targetAgentId,
    enabled,
    deleteAfterRun,
    nextRunAt: enabled ? nextRunAt : null,
  };
}

/** The run after this one, or null when the schedule is finished. */
export function followingRun(schedule: Schedule, firedAt: Date): Date | null {
  if (schedule.kind === "at") return null;
  if (schedule.kind === "every") {
    const previous = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : firedAt.getTime();
    const step = (schedule.everyMinutes ?? MIN_INTERVAL_MINUTES) * 60_000;
    let next = previous + step;
    if (next <= firedAt.getTime()) next = firedAt.getTime() + step;
    return new Date(next);
  }
  return nextCronRun(parseCron(schedule.cronExpr ?? "* * * * *"), firedAt, schedule.timezone);
}

export function isMissed(schedule: Schedule, now: Date): boolean {
  return Boolean(schedule.nextRunAt && now.getTime() - new Date(schedule.nextRunAt).getTime() > MISSED_GRACE_MS);
}

export function describeTiming(schedule: Pick<Schedule, "kind" | "runAt" | "everyMinutes" | "cronExpr" | "timezone">): string {
  if (schedule.kind === "at") return `once at ${schedule.runAt}`;
  if (schedule.kind === "every") return `every ${schedule.everyMinutes} min`;
  return `cron "${schedule.cronExpr}" (${schedule.timezone})`;
}
