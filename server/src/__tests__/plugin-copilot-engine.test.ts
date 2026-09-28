import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, plugins } from "@paperclipai/db";
import copilotManifest from "../../../packages/plugins/plugin-copilot/src/manifest.js";
import {
  evaluatePulse,
  notifyPeople,
  pulseProblem,
  runCopilotTick,
  turnOff,
  turnOn,
} from "../../../packages/plugins/plugin-copilot/src/copilot/engine.js";
import {
  addSignal,
  getSettings,
  insertSchedule,
  listSchedules,
  pruneHistory,
  recentScheduleRuns,
  saveSettings,
} from "../../../packages/plugins/plugin-copilot/src/copilot/store.js";
import { normalizeSchedule } from "../../../packages/plugins/plugin-copilot/src/copilot/schedules.js";
import { recordSignalFromEvent } from "../../../packages/plugins/plugin-copilot/src/copilot/signals.js";
import { pendingSignals } from "../../../packages/plugins/plugin-copilot/src/copilot/store.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { derivePluginDatabaseNamespace, pluginDatabaseService } from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COPILOT_ID = "00000000-0000-4000-8000-00000000c0b1";

describeEmbeddedPostgres("copilot engine (real Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginDb!: { namespace: string; query: any; execute: any };
  let companyId!: string;

  // Fakes for the Paperclip host; the plugin database is real.
  const state = {
    agentStatus: "idle",
    issues: [] as Array<Record<string, unknown>>,
    members: [
      { principalType: "user", principalId: "alice", status: "active", membershipRole: "owner" },
      { principalType: "user", principalId: "bob", status: "active", membershipRole: "operator" },
    ],
  };
  const invoke = vi.fn(async () => ({ runId: randomUUID() }));
  const createComment = vi.fn(async () => ({ id: randomUUID() }));
  const conversationIds = new Map<string, string>();
  const ensureConversation = vi.fn(async (input: { userId: string }) => {
    if (!conversationIds.has(input.userId)) conversationIds.set(input.userId, randomUUID());
    return { id: conversationIds.get(input.userId)! };
  });
  const pause = vi.fn(async () => ({ id: COPILOT_ID, status: "paused" }));

  function ctx() {
    return {
      db: pluginDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      activity: { log: vi.fn(async () => undefined) },
      agents: {
        get: vi.fn(async (id: string) => (id === COPILOT_ID ? { id, name: "Copilot", status: state.agentStatus } : { id, name: "Eng", status: "idle" })),
        list: vi.fn(async () => [{ id: "agent-eng", name: "Eng" }]),
        invoke,
        pause,
        resume: vi.fn(async (id: string) => ({ id, status: "idle" })),
        managed: {
          reconcile: vi.fn(async () => ({
            agentId: COPILOT_ID,
            agent: { id: COPILOT_ID, name: "Copilot", status: "paused" },
            status: "created",
          })),
        },
      },
      issues: {
        list: vi.fn(async (input: { status: string }) => state.issues.filter((issue) => issue.status === input.status)),
        get: vi.fn(async () => null),
        ensureConversation,
        createComment,
      },
      approvals: { list: vi.fn(async () => []) },
      companies: { get: vi.fn(async () => ({ budgetMonthlyCents: 0, spentMonthlyCents: 0 })) },
      access: { members: { list: vi.fn(async () => state.members) } },
    } as any;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-copilot-engine-");
    db = createDb(tempDb.connectionString);
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: copilotManifest.id,
      packageName: "@paperclipai/plugin-copilot",
      version: copilotManifest.version,
      apiVersion: copilotManifest.apiVersion,
      categories: copilotManifest.categories,
      manifestJson: copilotManifest,
      status: "installed",
      installOrder: 1,
    });
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const service = pluginDatabaseService(db);
    await service.applyMigrations(pluginId, copilotManifest, path.join(repoRoot, "packages", "plugins", "plugin-copilot"));
    pluginDb = {
      namespace: derivePluginDatabaseNamespace(copilotManifest.id, copilotManifest.database?.namespaceSlug),
      query: (statement: string, params?: unknown[]) => service.query(pluginId, statement, params),
      execute: (statement: string, params?: unknown[]) => service.execute(pluginId, statement, params),
    };
  }, 30_000);

  beforeEach(async () => {
    for (const name of ["copilot_signals", "copilot_wakes", "copilot_notifications", "copilot_schedules", "copilot_commitments", "copilot_settings"]) {
      await db.execute(sql.raw(`DELETE FROM ${pluginDb.namespace}.${name}`));
    }
    invoke.mockClear();
    createComment.mockClear();
    ensureConversation.mockClear();
    pause.mockClear();
    state.agentStatus = "idle";
    state.issues = [];
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Engine Co",
      status: "active",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const staleTask = (id: string, updatedAt = hoursAgo(48)) => ({
    id,
    identifier: `ENG-${id}`,
    title: `Task ${id}`,
    status: "in_progress",
    priority: "high",
    updatedAt,
    assigneeAgentId: "agent-eng",
    assigneeUserId: null,
  });

  async function onAllDay() {
    await turnOn(ctx(), companyId);
    return saveSettings(pluginDb, companyId, { activeStart: "00:00", activeEnd: "00:00" });
  }

  it("turns on: resumes the managed agent and creates the built-in schedules once", async () => {
    const result = await turnOn(ctx(), companyId);
    await turnOn(ctx(), companyId);
    expect(result.settings).toMatchObject({ enabled: true, agentId: COPILOT_ID });
    const schedules = await listSchedules(pluginDb, companyId);
    expect(schedules.map((schedule) => schedule.systemKey).sort()).toEqual([
      "morning-brief",
      "nightly-consolidation",
      "weekly-review",
    ]);
    expect(schedules.every((schedule) => schedule.nextRunAt && new Date(schedule.nextRunAt) > new Date())).toBe(true);
  });

  it("wakes only when the pulse has items and changed, and respects the hourly cap", async () => {
    let settings = await onAllDay();
    const now = new Date();

    expect((await evaluatePulse(ctx(), settings, now)).outcome).toBe("quiet");
    expect(invoke).not.toHaveBeenCalled();

    state.issues = [staleTask("1")];
    settings = await getSettings(pluginDb, companyId);
    expect((await evaluatePulse(ctx(), settings, now)).outcome).toBe("not_due");

    const later = new Date(now.getTime() + 31 * 60_000);
    expect((await evaluatePulse(ctx(), settings, later)).outcome).toBe("woke");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke.mock.calls[0] as any)[2].prompt).toContain("ENG-1");

    // Same state half an hour later: no second wake.
    settings = await getSettings(pluginDb, companyId);
    expect((await evaluatePulse(ctx(), settings, new Date(later.getTime() + 31 * 60_000))).outcome).toBe("unchanged");
    expect(invoke).toHaveBeenCalledTimes(1);

    // An urgent signal skips the interval; the hourly cap still applies.
    await saveSettings(pluginDb, companyId, { maxWakesPerHour: 1 });
    await addSignal(pluginDb, { companyId, kind: "run_failed", urgent: true, summary: "Run failed" });
    settings = await getSettings(pluginDb, companyId);
    expect((await evaluatePulse(ctx(), settings, new Date(later.getTime() + 60_000))).outcome).toBe("rate_limited");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not wake outside active hours or while the Copilot is busy", async () => {
    await turnOn(ctx(), companyId);
    state.issues = [staleTask("1")];
    const now = new Date();
    const hour = now.getUTCHours();
    // A one-hour window that excludes the current hour.
    const start = `${String((hour + 2) % 24).padStart(2, "0")}:00`;
    const end = `${String((hour + 3) % 24).padStart(2, "0")}:00`;
    let settings = await saveSettings(pluginDb, companyId, { activeStart: start, activeEnd: end });
    expect((await evaluatePulse(ctx(), settings, now)).outcome).toBe("outside_active_hours");

    settings = await saveSettings(pluginDb, companyId, { activeStart: "00:00", activeEnd: "00:00" });
    state.agentStatus = "running";
    expect((await evaluatePulse(ctx(), settings, now)).outcome).toBe("copilot_busy");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns people's task comments and failed runs into signals, but never private chats or the Copilot's own actions", async () => {
    await onAllDay();
    const issues: Record<string, Record<string, unknown>> = {
      task: { id: "task", identifier: "ENG-1", title: "Ship", priority: "high", conversationAgentId: null },
      dm: { id: "dm", identifier: "ENG-2", title: "Chat with Eng", priority: "medium", conversationAgentId: "agent-eng" },
    };
    const c = ctx();
    c.issues.get = vi.fn(async (id: string) => issues[id] ?? null);
    const event = (overrides: Record<string, unknown>) =>
      ({ eventId: randomUUID(), occurredAt: new Date().toISOString(), companyId, ...overrides }) as any;

    expect(await recordSignalFromEvent(c, event({ eventType: "issue.comment.created", actorType: "user", actorId: "alice", entityType: "issue", entityId: "task", payload: { bodySnippet: "can we ship friday?" } }))).toBe(true);
    expect(await recordSignalFromEvent(c, event({ eventType: "issue.comment.created", actorType: "user", actorId: "alice", entityType: "issue", entityId: "dm", payload: { bodySnippet: "private" } }))).toBe(false);
    expect(await recordSignalFromEvent(c, event({ eventType: "issue.comment.created", actorType: "agent", actorId: "agent-eng", entityType: "issue", entityId: "task", payload: {} }))).toBe(false);
    expect(await recordSignalFromEvent(c, event({ eventType: "agent.run.failed", actorType: "agent", actorId: COPILOT_ID, payload: { agentId: COPILOT_ID } }))).toBe(false);
    expect(await recordSignalFromEvent(c, event({ eventType: "agent.run.failed", actorType: "system", payload: { agentId: "agent-eng", issueId: "task", error: "boom" } }))).toBe(true);

    const signals = await pendingSignals(pluginDb, companyId);
    expect(signals.map((signal) => [signal.kind, signal.urgent])).toEqual([
      ["human_comment", false],
      ["run_failed", true],
    ]);
    expect(signals.some((signal) => signal.summary.includes("private"))).toBe(false);
  });

  it("reports pulse data sources that fail instead of silently dropping them", async () => {
    const settings = await onAllDay();
    const failing = ctx();
    failing.approvals.list = vi.fn(async () => {
      throw new Error("company context is required");
    });
    state.issues = [staleTask("1")];
    const later = new Date(Date.now() + 31 * 60_000);
    expect((await evaluatePulse(failing, settings, later)).outcome).toBe("woke");
    expect(pulseProblem(companyId)?.message).toMatch(/approvals: company context is required/);

    // A clean pulse clears the problem.
    await evaluatePulse(ctx(), await getSettings(pluginDb, companyId), new Date(later.getTime() + 31 * 60_000));
    expect(pulseProblem(companyId)).toBeNull();
  });

  it("fires due schedules once, advances them, and skips runs missed during downtime", async () => {
    const settings = await onAllDay();
    const now = new Date();
    const write = (name: string, nextRunAt: Date) => ({
      ...normalizeSchedule({ name, message: `do ${name}`, everyMinutes: 10 }, { now, defaultTimezone: "UTC", defaultTargetAgentId: COPILOT_ID }),
      nextRunAt,
    });
    await insertSchedule(pluginDb, companyId, write("due", new Date(now.getTime() - 60_000)), { createdByKind: "user", createdById: "alice" });
    await insertSchedule(pluginDb, companyId, write("missed", new Date(now.getTime() - 3 * 3_600_000)), { createdByKind: "user", createdById: "alice" });

    await runCopilotTick(ctx(), now);
    await runCopilotTick(ctx(), now);

    const prompts = invoke.mock.calls.map((call: any) => call[2].prompt as string);
    expect(prompts.filter((prompt) => prompt.includes("do due"))).toHaveLength(1);
    expect(prompts.some((prompt) => prompt.includes("do missed"))).toBe(false);
    const runs = await recentScheduleRuns(pluginDb, companyId);
    expect(runs.map((run) => `${run.scheduleName}:${run.status}`).sort()).toEqual(["due:fired", "missed:skipped"]);
    const due = (await listSchedules(pluginDb, companyId)).find((schedule) => schedule.name === "due")!;
    expect(new Date(due.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(settings.enabled).toBe(true);
  });

  it("caps messages per person per day", async () => {
    await turnOn(ctx(), companyId);
    const settings = await saveSettings(pluginDb, companyId, { maxNotificationsPerUserPerDay: 2 });
    for (let i = 0; i < 2; i += 1) {
      expect((await notifyPeople(ctx(), settings, { userIds: ["alice"], message: `m${i}`, urgency: "normal" })).sent).toEqual(["alice"]);
    }
    const third = await notifyPeople(ctx(), settings, { userIds: ["alice", "bob"], message: "m3", urgency: "urgent" });
    expect(third.sent).toEqual(["bob"]);
    expect(third.skipped[0]).toMatchObject({ userId: "alice" });
    expect(createComment).toHaveBeenCalledTimes(3);
    expect((createComment.mock.calls[2] as any)[1]).toMatch(/^\*\*Urgent\.\*\*/);
  });

  it("prunes old history and keeps recent rows", async () => {
    await turnOn(ctx(), companyId);
    await addSignal(pluginDb, { companyId, kind: "x", summary: "old" });
    await addSignal(pluginDb, { companyId, kind: "x", summary: "new" });
    await db.execute(
      sql.raw(`UPDATE ${pluginDb.namespace}.copilot_signals SET created_at = now() - interval '10 days' WHERE summary = 'old'`),
    );
    const removed = await pruneHistory(pluginDb, companyId, new Date());
    expect(removed.signals).toBe(1);
  });

  it("the kill switch stops schedules and pauses the agent", async () => {
    await onAllDay();
    await insertSchedule(
      pluginDb,
      companyId,
      {
        ...normalizeSchedule({ name: "ping", message: "ping", everyMinutes: 10 }, { now: new Date(), defaultTimezone: "UTC", defaultTargetAgentId: COPILOT_ID }),
        nextRunAt: new Date(Date.now() - 60_000),
      },
      { createdByKind: "user", createdById: "alice" },
    );
    await turnOff(ctx(), companyId);
    expect(pause).toHaveBeenCalledWith(COPILOT_ID, companyId);
    state.issues = [staleTask("1")];
    await runCopilotTick(ctx(), new Date());
    expect(invoke).not.toHaveBeenCalled();
    expect((await getSettings(pluginDb, companyId)).enabled).toBe(false);
  });
});
