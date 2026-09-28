import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

function table(db: PluginDatabaseClient, name: string): string {
  return `${db.namespace}.${name}`;
}

/** Timestamps come back as epoch milliseconds to avoid driver text formats. */
function ms(column: string, alias = column): string {
  return `(date_part('epoch', ${column}) * 1000)::float8 AS ${alias}`;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CopilotSettings {
  companyId: string;
  enabled: boolean;
  agentId: string | null;
  pulseIntervalMinutes: number;
  activeStart: string;
  activeEnd: string;
  timezone: string;
  maxWakesPerHour: number;
  maxNotificationsPerUserPerDay: number;
  staleAfterHours: number;
  lastPulseAt: string | null;
  lastPulseHash: string | null;
  lastPruneAt: string | null;
}

export const DEFAULT_SETTINGS: Omit<CopilotSettings, "companyId"> = {
  enabled: false,
  agentId: null,
  pulseIntervalMinutes: 30,
  activeStart: "08:00",
  activeEnd: "22:00",
  timezone: "UTC",
  maxWakesPerHour: 4,
  maxNotificationsPerUserPerDay: 6,
  staleAfterHours: 24,
  lastPulseAt: null,
  lastPulseHash: null,
  lastPruneAt: null,
};

const SETTINGS_COLUMNS = `company_id, enabled, agent_id, pulse_interval_minutes, active_start, active_end,
  timezone, max_wakes_per_hour, max_notifications_per_user_per_day, stale_after_hours, last_pulse_hash,
  ${ms("last_pulse_at")}, ${ms("last_prune_at")}`;

function toSettings(row: Record<string, unknown>): CopilotSettings {
  return {
    companyId: String(row.company_id),
    enabled: row.enabled === true,
    agentId: (row.agent_id as string | null) ?? null,
    pulseIntervalMinutes: Number(row.pulse_interval_minutes),
    activeStart: String(row.active_start),
    activeEnd: String(row.active_end),
    timezone: String(row.timezone),
    maxWakesPerHour: Number(row.max_wakes_per_hour),
    maxNotificationsPerUserPerDay: Number(row.max_notifications_per_user_per_day),
    staleAfterHours: Number(row.stale_after_hours),
    lastPulseAt: toIso(row.last_pulse_at),
    lastPulseHash: (row.last_pulse_hash as string | null) ?? null,
    lastPruneAt: toIso(row.last_prune_at),
  };
}

export async function getSettings(db: PluginDatabaseClient, companyId: string): Promise<CopilotSettings> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SETTINGS_COLUMNS} FROM ${table(db, "copilot_settings")} WHERE company_id = $1`,
    [companyId],
  );
  return rows[0] ? toSettings(rows[0]) : { companyId, ...DEFAULT_SETTINGS };
}

export async function listEnabledSettings(db: PluginDatabaseClient): Promise<CopilotSettings[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SETTINGS_COLUMNS} FROM ${table(db, "copilot_settings")} WHERE enabled`,
  );
  return rows.map(toSettings);
}

export type SettingsPatch = Partial<
  Pick<
    CopilotSettings,
    | "enabled"
    | "agentId"
    | "pulseIntervalMinutes"
    | "activeStart"
    | "activeEnd"
    | "timezone"
    | "maxWakesPerHour"
    | "maxNotificationsPerUserPerDay"
    | "staleAfterHours"
  >
>;

export async function saveSettings(
  db: PluginDatabaseClient,
  companyId: string,
  patch: SettingsPatch,
): Promise<CopilotSettings> {
  const next = { ...(await getSettings(db, companyId)), ...patch };
  await db.execute(
    `INSERT INTO ${table(db, "copilot_settings")}
       (company_id, enabled, agent_id, pulse_interval_minutes, active_start, active_end, timezone,
        max_wakes_per_hour, max_notifications_per_user_per_day, stale_after_hours, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (company_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       agent_id = EXCLUDED.agent_id,
       pulse_interval_minutes = EXCLUDED.pulse_interval_minutes,
       active_start = EXCLUDED.active_start,
       active_end = EXCLUDED.active_end,
       timezone = EXCLUDED.timezone,
       max_wakes_per_hour = EXCLUDED.max_wakes_per_hour,
       max_notifications_per_user_per_day = EXCLUDED.max_notifications_per_user_per_day,
       stale_after_hours = EXCLUDED.stale_after_hours,
       updated_at = now()`,
    [
      companyId,
      next.enabled,
      next.agentId,
      next.pulseIntervalMinutes,
      next.activeStart,
      next.activeEnd,
      next.timezone,
      next.maxWakesPerHour,
      next.maxNotificationsPerUserPerDay,
      next.staleAfterHours,
    ],
  );
  return getSettings(db, companyId);
}

export async function recordPulse(
  db: PluginDatabaseClient,
  companyId: string,
  input: { at: Date; hash: string | null },
): Promise<void> {
  await db.execute(
    `UPDATE ${table(db, "copilot_settings")}
        SET last_pulse_at = $2, last_pulse_hash = coalesce($3, last_pulse_hash)
      WHERE company_id = $1`,
    [companyId, input.at.toISOString(), input.hash],
  );
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface Signal {
  id: string;
  kind: string;
  urgent: boolean;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  createdAt: string;
}

export async function addSignal(
  db: PluginDatabaseClient,
  input: {
    companyId: string;
    kind: string;
    urgent?: boolean;
    entityType?: string | null;
    entityId?: string | null;
    summary: string;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${table(db, "copilot_signals")} (id, company_id, kind, urgent, entity_type, entity_id, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.companyId,
      input.kind,
      input.urgent === true,
      input.entityType ?? null,
      input.entityId ?? null,
      input.summary.slice(0, 500),
    ],
  );
}

/** Oldest first, capped so a burst of events cannot bloat one pulse. */
export async function pendingSignals(db: PluginDatabaseClient, companyId: string, limit = 50): Promise<Signal[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, kind, urgent, entity_type, entity_id, summary, ${ms("created_at")}
       FROM ${table(db, "copilot_signals")}
      WHERE company_id = $1 AND consumed_at IS NULL
      ORDER BY created_at
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    urgent: row.urgent === true,
    entityType: (row.entity_type as string | null) ?? null,
    entityId: (row.entity_id as string | null) ?? null,
    summary: String(row.summary),
    createdAt: toIso(row.created_at) ?? "",
  }));
}

export async function hasUrgentSignal(db: PluginDatabaseClient, companyId: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(db, "copilot_signals")}
      WHERE company_id = $1 AND consumed_at IS NULL AND urgent`,
    [companyId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function consumeSignals(db: PluginDatabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(
    `UPDATE ${table(db, "copilot_signals")} SET consumed_at = now()
      WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    [JSON.stringify(ids)],
  );
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export interface Commitment {
  id: string;
  ownerKind: "user" | "agent" | "company";
  ownerId: string | null;
  text: string;
  dueAt: string | null;
  sourceIssueId: string | null;
  status: "open" | "done" | "cancelled";
  createdByKind: string | null;
  createdById: string | null;
  lastRemindedAt: string | null;
  createdAt: string;
}

const COMMITMENT_COLUMNS = `id, owner_kind, owner_id, text, source_issue_id, status, created_by_kind, created_by_id,
  ${ms("due_at")}, ${ms("last_reminded_at")}, ${ms("created_at")}`;

function toCommitment(row: Record<string, unknown>): Commitment {
  return {
    id: String(row.id),
    ownerKind: row.owner_kind as Commitment["ownerKind"],
    ownerId: (row.owner_id as string | null) ?? null,
    text: String(row.text),
    dueAt: toIso(row.due_at),
    sourceIssueId: (row.source_issue_id as string | null) ?? null,
    status: row.status as Commitment["status"],
    createdByKind: (row.created_by_kind as string | null) ?? null,
    createdById: (row.created_by_id as string | null) ?? null,
    lastRemindedAt: toIso(row.last_reminded_at),
    createdAt: toIso(row.created_at) ?? "",
  };
}

export const MAX_OPEN_COMMITMENTS = 200;

export async function createCommitment(
  db: PluginDatabaseClient,
  input: {
    companyId: string;
    ownerKind: Commitment["ownerKind"];
    ownerId: string | null;
    text: string;
    dueAt: Date | null;
    sourceIssueId: string | null;
    createdByKind: string;
    createdById: string | null;
  },
): Promise<Commitment> {
  const open = await listCommitments(db, input.companyId, { status: "open", limit: MAX_OPEN_COMMITMENTS + 1 });
  if (open.length >= MAX_OPEN_COMMITMENTS) {
    throw new Error(`There are already ${MAX_OPEN_COMMITMENTS} open commitments; complete or cancel some first`);
  }
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ${table(db, "copilot_commitments")}
       (id, company_id, owner_kind, owner_id, text, due_at, source_issue_id, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.companyId,
      input.ownerKind,
      input.ownerId,
      input.text.slice(0, 2000),
      input.dueAt ? input.dueAt.toISOString() : null,
      input.sourceIssueId,
      input.createdByKind,
      input.createdById,
    ],
  );
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${COMMITMENT_COLUMNS} FROM ${table(db, "copilot_commitments")} WHERE id = $1`,
    [id],
  );
  return toCommitment(rows[0]!);
}

export async function listCommitments(
  db: PluginDatabaseClient,
  companyId: string,
  options: { status?: "open" | "done" | "cancelled" | "all"; limit?: number } = {},
): Promise<Commitment[]> {
  const status = options.status ?? "open";
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${COMMITMENT_COLUMNS} FROM ${table(db, "copilot_commitments")}
      WHERE company_id = $1 AND ($2 = 'all' OR status = $2)
      ORDER BY (status = 'open') DESC, due_at NULLS LAST, created_at DESC
      LIMIT $3`,
    [companyId, status, Math.min(options.limit ?? 100, 500)],
  );
  return rows.map(toCommitment);
}

/** Open commitments due within `withinHours` that were not reminded in the last `quietHours`. */
export async function commitmentsNeedingAttention(
  db: PluginDatabaseClient,
  companyId: string,
  now: Date,
  options: { withinHours?: number; quietHours?: number } = {},
): Promise<Commitment[]> {
  const horizon = new Date(now.getTime() + (options.withinHours ?? 24) * 3_600_000);
  const quietSince = new Date(now.getTime() - (options.quietHours ?? 12) * 3_600_000);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${COMMITMENT_COLUMNS} FROM ${table(db, "copilot_commitments")}
      WHERE company_id = $1 AND status = 'open' AND due_at IS NOT NULL AND due_at <= $2
        AND (last_reminded_at IS NULL OR last_reminded_at < $3)
      ORDER BY due_at
      LIMIT 20`,
    [companyId, horizon.toISOString(), quietSince.toISOString()],
  );
  return rows.map(toCommitment);
}

export async function markCommitmentsReminded(db: PluginDatabaseClient, ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(
    `UPDATE ${table(db, "copilot_commitments")} SET last_reminded_at = $2
      WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    [JSON.stringify(ids), at.toISOString()],
  );
}

export async function setCommitmentStatus(
  db: PluginDatabaseClient,
  companyId: string,
  id: string,
  status: "open" | "done" | "cancelled",
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${table(db, "copilot_commitments")}
        SET status = $3, completed_at = CASE WHEN $3 = 'open' THEN NULL ELSE now() END, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [companyId, id, status],
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface Schedule {
  id: string;
  companyId: string;
  name: string;
  kind: "at" | "every" | "cron";
  runAt: string | null;
  everyMinutes: number | null;
  cronExpr: string | null;
  timezone: string;
  message: string;
  targetAgentId: string | null;
  systemKey: string | null;
  enabled: boolean;
  deleteAfterRun: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
  createdByKind: string | null;
  createdById: string | null;
}

const SCHEDULE_COLUMNS = `id, company_id, name, kind, every_minutes, cron_expr, timezone, message, target_agent_id,
  system_key, enabled, delete_after_run, last_status, last_error, run_count, created_by_kind, created_by_id,
  ${ms("run_at")}, ${ms("next_run_at")}, ${ms("last_run_at")}`;

function toSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    kind: row.kind as Schedule["kind"],
    runAt: toIso(row.run_at),
    everyMinutes: row.every_minutes === null ? null : Number(row.every_minutes),
    cronExpr: (row.cron_expr as string | null) ?? null,
    timezone: String(row.timezone),
    message: String(row.message),
    targetAgentId: (row.target_agent_id as string | null) ?? null,
    systemKey: (row.system_key as string | null) ?? null,
    enabled: row.enabled === true,
    deleteAfterRun: row.delete_after_run === true,
    nextRunAt: toIso(row.next_run_at),
    lastRunAt: toIso(row.last_run_at),
    lastStatus: (row.last_status as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    runCount: Number(row.run_count ?? 0),
    createdByKind: (row.created_by_kind as string | null) ?? null,
    createdById: (row.created_by_id as string | null) ?? null,
  };
}

export interface ScheduleWrite {
  name: string;
  kind: Schedule["kind"];
  runAt: Date | null;
  everyMinutes: number | null;
  cronExpr: string | null;
  timezone: string;
  message: string;
  targetAgentId: string | null;
  enabled: boolean;
  deleteAfterRun: boolean;
  nextRunAt: Date | null;
}

export async function getSchedule(db: PluginDatabaseClient, companyId: string, id: string): Promise<Schedule | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SCHEDULE_COLUMNS} FROM ${table(db, "copilot_schedules")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  return rows[0] ? toSchedule(rows[0]) : null;
}

export async function listSchedules(db: PluginDatabaseClient, companyId: string): Promise<Schedule[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SCHEDULE_COLUMNS} FROM ${table(db, "copilot_schedules")}
      WHERE company_id = $1
      ORDER BY enabled DESC, next_run_at NULLS LAST, name`,
    [companyId],
  );
  return rows.map(toSchedule);
}

export async function countActiveSchedules(db: PluginDatabaseClient, companyId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(db, "copilot_schedules")} WHERE company_id = $1 AND enabled`,
    [companyId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function insertSchedule(
  db: PluginDatabaseClient,
  companyId: string,
  write: ScheduleWrite,
  meta: { systemKey?: string | null; createdByKind: string; createdById: string | null },
): Promise<Schedule> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ${table(db, "copilot_schedules")}
       (id, company_id, name, kind, run_at, every_minutes, cron_expr, timezone, message, target_agent_id,
        system_key, enabled, delete_after_run, next_run_at, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (company_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
    [
      id,
      companyId,
      write.name,
      write.kind,
      write.runAt ? write.runAt.toISOString() : null,
      write.everyMinutes,
      write.cronExpr,
      write.timezone,
      write.message,
      write.targetAgentId,
      meta.systemKey ?? null,
      write.enabled,
      write.deleteAfterRun,
      write.nextRunAt ? write.nextRunAt.toISOString() : null,
      meta.createdByKind,
      meta.createdById,
    ],
  );
  const created = await getSchedule(db, companyId, id);
  if (created) return created;
  const existing = await db.query<Record<string, unknown>>(
    `SELECT ${SCHEDULE_COLUMNS} FROM ${table(db, "copilot_schedules")} WHERE company_id = $1 AND system_key = $2`,
    [companyId, meta.systemKey ?? ""],
  );
  if (!existing[0]) throw new Error("Schedule could not be created");
  return toSchedule(existing[0]);
}

export async function updateSchedule(
  db: PluginDatabaseClient,
  companyId: string,
  id: string,
  write: ScheduleWrite,
): Promise<Schedule | null> {
  await db.execute(
    `UPDATE ${table(db, "copilot_schedules")}
        SET name = $3, kind = $4, run_at = $5, every_minutes = $6, cron_expr = $7, timezone = $8,
            message = $9, target_agent_id = $10, enabled = $11, delete_after_run = $12, next_run_at = $13,
            updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      id,
      write.name,
      write.kind,
      write.runAt ? write.runAt.toISOString() : null,
      write.everyMinutes,
      write.cronExpr,
      write.timezone,
      write.message,
      write.targetAgentId,
      write.enabled,
      write.deleteAfterRun,
      write.nextRunAt ? write.nextRunAt.toISOString() : null,
    ],
  );
  return getSchedule(db, companyId, id);
}

export async function deleteSchedule(db: PluginDatabaseClient, companyId: string, id: string): Promise<boolean> {
  const result = await db.execute(
    `DELETE FROM ${table(db, "copilot_schedules")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  return result.rowCount > 0;
}

export async function dueSchedules(db: PluginDatabaseClient, companyId: string, now: Date, limit: number): Promise<Schedule[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SCHEDULE_COLUMNS} FROM ${table(db, "copilot_schedules")}
      WHERE company_id = $1 AND enabled AND next_run_at IS NOT NULL AND next_run_at <= $2
      ORDER BY next_run_at
      LIMIT $3`,
    [companyId, now.toISOString(), limit],
  );
  return rows.map(toSchedule);
}

/**
 * Claims a due schedule by moving its next run forward; returns false when a
 * concurrent tick already claimed it (the stored next_run_at no longer matches).
 */
export async function claimScheduleRun(
  db: PluginDatabaseClient,
  schedule: Schedule,
  input: { firedAt: Date; nextRunAt: Date | null; disable: boolean },
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${table(db, "copilot_schedules")}
        SET next_run_at = $3, last_run_at = $4, run_count = run_count + 1,
            enabled = CASE WHEN $5 THEN false ELSE enabled END, updated_at = now()
      WHERE id = $1 AND next_run_at = $2`,
    [schedule.id, schedule.nextRunAt, input.nextRunAt ? input.nextRunAt.toISOString() : null, input.firedAt.toISOString(), input.disable],
  );
  return result.rowCount === 1;
}

export async function recordScheduleResult(
  db: PluginDatabaseClient,
  schedule: Schedule,
  input: { status: "fired" | "failed" | "skipped"; runId: string | null; error: string | null },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${table(db, "copilot_schedule_runs")} (id, schedule_id, company_id, status, run_id, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), schedule.id, schedule.companyId, input.status, input.runId, input.error],
  );
  await db.execute(
    `UPDATE ${table(db, "copilot_schedules")} SET last_status = $2, last_error = $3 WHERE id = $1`,
    [schedule.id, input.status, input.error],
  );
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  firedAt: string;
  status: string;
  runId: string | null;
  error: string | null;
}

export async function recentScheduleRuns(db: PluginDatabaseClient, companyId: string, limit = 30): Promise<ScheduleRun[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.schedule_id, s.name, r.status, r.run_id, r.error, ${ms("r.fired_at", "fired_at")}
       FROM ${table(db, "copilot_schedule_runs")} r
       JOIN ${table(db, "copilot_schedules")} s ON s.id = r.schedule_id
      WHERE r.company_id = $1
      ORDER BY r.fired_at DESC
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    scheduleName: String(row.name),
    firedAt: toIso(row.fired_at) ?? "",
    status: String(row.status),
    runId: (row.run_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Wakes and notifications
// ---------------------------------------------------------------------------

export async function recordWake(
  db: PluginDatabaseClient,
  input: { companyId: string; reason: string; summary: string; itemCount: number; runId: string | null; error: string | null },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${table(db, "copilot_wakes")} (id, company_id, reason, summary, item_count, run_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.companyId, input.reason, input.summary.slice(0, 1000), input.itemCount, input.runId, input.error],
  );
}

export async function wakesSince(db: PluginDatabaseClient, companyId: string, since: Date): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(db, "copilot_wakes")}
      WHERE company_id = $1 AND created_at >= $2 AND error IS NULL`,
    [companyId, since.toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface WakeRecord {
  id: string;
  reason: string;
  summary: string;
  itemCount: number;
  runId: string | null;
  error: string | null;
  createdAt: string;
}

export async function recentWakes(db: PluginDatabaseClient, companyId: string, limit = 30): Promise<WakeRecord[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, reason, summary, item_count, run_id, error, ${ms("created_at")}
       FROM ${table(db, "copilot_wakes")}
      WHERE company_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    reason: String(row.reason),
    summary: String(row.summary),
    itemCount: Number(row.item_count),
    runId: (row.run_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: toIso(row.created_at) ?? "",
  }));
}

export async function notificationsSince(
  db: PluginDatabaseClient,
  companyId: string,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(db, "copilot_notifications")}
      WHERE company_id = $1 AND user_id = $2 AND created_at >= $3`,
    [companyId, userId, since.toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function recordNotification(
  db: PluginDatabaseClient,
  input: { companyId: string; userId: string; issueId: string | null; urgency: string; excerpt: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${table(db, "copilot_notifications")} (id, company_id, user_id, issue_id, urgency, excerpt)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), input.companyId, input.userId, input.issueId, input.urgency, input.excerpt.slice(0, 300)],
  );
}

export interface NotificationRecord {
  id: string;
  userId: string;
  issueId: string | null;
  urgency: string;
  excerpt: string;
  createdAt: string;
}

export async function recentNotifications(db: PluginDatabaseClient, companyId: string, limit = 30): Promise<NotificationRecord[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, user_id, issue_id, urgency, excerpt, ${ms("created_at")}
       FROM ${table(db, "copilot_notifications")}
      WHERE company_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [companyId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    issueId: (row.issue_id as string | null) ?? null,
    urgency: String(row.urgency),
    excerpt: String(row.excerpt),
    createdAt: toIso(row.created_at) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  signalDays: number;
  historyDays: number;
  revisionDays: number;
  revisionsKept: number;
  closedCommitmentDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  signalDays: 7,
  historyDays: 30,
  revisionDays: 90,
  revisionsKept: 20,
  closedCommitmentDays: 90,
};

/** Deletes old operational history so every table stays bounded. Returns rows removed per table. */
export async function pruneHistory(
  db: PluginDatabaseClient,
  companyId: string,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<Record<string, number>> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const removed: Record<string, number> = {};
  const run = async (key: string, statement: string, params: unknown[]) => {
    removed[key] = (await db.execute(statement, params)).rowCount;
  };
  await run(
    "signals",
    `DELETE FROM ${table(db, "copilot_signals")} WHERE company_id = $1 AND created_at < $2`,
    [companyId, before(policy.signalDays)],
  );
  await run(
    "wakes",
    `DELETE FROM ${table(db, "copilot_wakes")} WHERE company_id = $1 AND created_at < $2`,
    [companyId, before(policy.historyDays)],
  );
  await run(
    "notifications",
    `DELETE FROM ${table(db, "copilot_notifications")} WHERE company_id = $1 AND created_at < $2`,
    [companyId, before(policy.historyDays)],
  );
  await run(
    "scheduleRuns",
    `DELETE FROM ${table(db, "copilot_schedule_runs")} WHERE company_id = $1 AND fired_at < $2`,
    [companyId, before(policy.historyDays)],
  );
  await run(
    "commitments",
    `DELETE FROM ${table(db, "copilot_commitments")}
      WHERE company_id = $1 AND status <> 'open' AND completed_at < $2`,
    [companyId, before(policy.closedCommitmentDays)],
  );
  // Keep the newest revisions of every memory document; drop old ones beyond that.
  await run(
    "revisions",
    `DELETE FROM ${table(db, "memory_document_revisions")} r
      WHERE r.company_id = $1 AND r.created_at < $2
        AND r.id NOT IN (
          SELECT keep.id FROM ${table(db, "memory_document_revisions")} keep
           WHERE keep.document_id = r.document_id
           ORDER BY keep.created_at DESC
           LIMIT $3
        )`,
    [companyId, before(policy.revisionDays), policy.revisionsKept],
  );
  return removed;
}

/** Embeddings no chunk uses any more; instance-wide because the cache is keyed by content, not company. */
export async function pruneEmbeddingCache(db: PluginDatabaseClient, olderThanDays = 30, now = new Date()): Promise<number> {
  const result = await db.execute(
    `DELETE FROM ${table(db, "embedding_cache")} e
      WHERE e.created_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM ${table(db, "memory_chunks")} c
           WHERE c.content_hash = e.content_hash AND c.embedding_model = e.model
        )`,
    [new Date(now.getTime() - olderThanDays * 86_400_000).toISOString()],
  );
  return result.rowCount;
}

export async function markPruned(db: PluginDatabaseClient, companyId: string, at: Date): Promise<void> {
  await db.execute(
    `UPDATE ${table(db, "copilot_settings")} SET last_prune_at = $2 WHERE company_id = $1`,
    [companyId, at.toISOString()],
  );
}
