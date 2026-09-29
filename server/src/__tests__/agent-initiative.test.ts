import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  AGENT_INITIATIVE_WAKE_REASON,
  agentInitiativeLevelFromRuntimeConfig,
} from "@paperclipai/shared";
import {
  buildInitiativePrompt,
  evaluateInitiative,
  initiativeSpacingMs,
  type InitiativeUsage,
} from "../services/agent-initiative.js";
import { parseHeartbeatActiveHours } from "../services/heartbeat-active-hours.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-09-29T12:00:00Z");
const longAgo = new Date("2026-09-01T00:00:00Z");
const idle: InitiativeUsage = { runsLast24h: 0, lastRunAt: null, costCentsLast24h: 0, costCentsThisMonth: 0 };

describe("agent initiative level", () => {
  it("defaults to balanced and ignores unknown values", () => {
    expect(agentInitiativeLevelFromRuntimeConfig(undefined)).toBe("balanced");
    expect(agentInitiativeLevelFromRuntimeConfig({ heartbeat: {} })).toBe("balanced");
    expect(agentInitiativeLevelFromRuntimeConfig({ heartbeat: { initiative: "wild" } })).toBe("balanced");
    expect(agentInitiativeLevelFromRuntimeConfig({ heartbeat: { initiative: "off" } })).toBe("off");
  });
});

describe("evaluateInitiative", () => {
  const base = { level: "balanced" as const, now, agentCreatedAt: longAgo, activeHours: null, budgetMonthlyCents: 0 };

  it("is due for an idle agent and never for off", () => {
    expect(evaluateInitiative({ ...base, usage: idle })).toEqual({ due: true });
    expect(evaluateInitiative({ ...base, level: "off", usage: idle })).toEqual({ due: false, reason: "off" });
  });

  it("lets a newly hired agent settle in first", () => {
    const decision = evaluateInitiative({ ...base, agentCreatedAt: new Date(now.getTime() - 10 * 60 * 1000), usage: idle });
    expect(decision).toEqual({ due: false, reason: "settling_in" });
  });

  it("spreads runs across the active window", () => {
    // Balanced: 4 runs over 24h -> 6h apart; over a 12h window -> 3h apart.
    expect(initiativeSpacingMs({ maxRunsPerDay: 4 } as never, null)).toBe(6 * HOUR);
    const window = parseHeartbeatActiveHours({ start: "08:00", end: "20:00" });
    expect(initiativeSpacingMs({ maxRunsPerDay: 4 } as never, window)).toBe(3 * HOUR);
    const recent = { ...idle, runsLast24h: 1, lastRunAt: new Date(now.getTime() - 2 * HOUR) };
    expect(evaluateInitiative({ ...base, usage: recent })).toEqual({ due: false, reason: "spacing" });
    expect(evaluateInitiative({ ...base, activeHours: window, usage: { ...recent, lastRunAt: new Date(now.getTime() - 4 * HOUR) } })).toEqual({ due: true });
  });

  it("stops at the daily run limit", () => {
    const usage = { ...idle, runsLast24h: 4, lastRunAt: new Date(now.getTime() - 7 * HOUR) };
    expect(evaluateInitiative({ ...base, usage })).toEqual({ due: false, reason: "daily_run_limit" });
  });

  it("caps spend at the budget share, or a daily amount without a budget", () => {
    // $100/month budget, balanced share 20% -> $20.
    expect(evaluateInitiative({ ...base, budgetMonthlyCents: 10_000, usage: { ...idle, costCentsThisMonth: 1_999 } })).toEqual({ due: true });
    expect(evaluateInitiative({ ...base, budgetMonthlyCents: 10_000, usage: { ...idle, costCentsThisMonth: 2_000 } })).toEqual({ due: false, reason: "budget_share" });
    expect(evaluateInitiative({ ...base, usage: { ...idle, costCentsLast24h: 200 } })).toEqual({ due: false, reason: "daily_cost_limit" });
  });
});

describe("buildInitiativePrompt", () => {
  it("grounds the run in the agent's role and the company goals and asks for approval on external steps", () => {
    const prompt = buildInitiativePrompt({
      agent: { name: "Sam", role: "cmo", title: "Head of Growth", capabilities: "Owns acquisition and brand." },
      company: { name: "Acme", description: "Accounting for freelancers." },
      goals: [{ title: "Reach 1,000 paying users", description: null, level: "company", ownedByThisAgent: true }],
      level: "balanced",
      runsLeftToday: 3,
    });
    expect(prompt).toContain("Sam (Head of Growth, role: cmo)");
    expect(prompt).toContain("Reach 1,000 paying users (you own this)");
    expect(prompt).toContain("request_confirmation");
    expect(prompt).toContain("Idea: <short summary>");
    expect(prompt).toContain("HEARTBEAT_OK");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tickInitiative", () => {
  // Run rows get real creation times, so the ticks use the real clock too.
  const now = new Date();
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-initiative-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Woken runs start executing in the background and leave rows behind, so
    // retire each test's company instead of deleting it.
    await db.update(companies).set({ status: "archived" });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Initiative Co",
      status: "active",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertAgent(companyId: string, heartbeat: Record<string, unknown> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 4)}`,
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat },
      permissions: {},
      createdAt: longAgo,
    });
    return agentId;
  }

  async function initiativeRuns(agentId: string) {
    const rows = await db.select().from(heartbeatRuns);
    return rows.filter(
      (row) => row.agentId === agentId && row.contextSnapshot?.wakeReason === AGENT_INITIATIVE_WAKE_REASON,
    );
  }

  async function finishRuns() {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: now });
  }

  it("wakes agents by default with the initiative brief, one per company per tick", async () => {
    const companyId = await insertCompany();
    await db.insert(goals).values({ companyId, title: "Win the SMB market", status: "active", level: "company" });
    const first = await insertAgent(companyId);
    const second = await insertAgent(companyId);
    const heartbeat = heartbeatService(db);

    const tick = await heartbeat.tickInitiative(now);
    expect(tick.enqueued).toBe(1);
    const [run] = [...(await initiativeRuns(first)), ...(await initiativeRuns(second))];
    expect(run?.invocationSource).toBe("automation");
    const message = run?.contextSnapshot?.paperclipAgentMessage as { text?: string } | undefined;
    expect(message?.text).toContain("Win the SMB market");

    const next = await heartbeat.tickInitiative(new Date(now.getTime() + 60_000));
    expect(next.enqueued).toBe(1);
    expect((await initiativeRuns(first)).length + (await initiativeRuns(second)).length).toBe(2);
  });

  it("skips agents set to off and waits out the spacing between runs", async () => {
    const companyId = await insertCompany();
    const off = await insertAgent(companyId, { initiative: "off" });
    const low = await insertAgent(companyId, { initiative: "low" });
    const heartbeat = heartbeatService(db);

    expect((await heartbeat.tickInitiative(now)).enqueued).toBe(1);
    expect(await initiativeRuns(off)).toHaveLength(0);
    expect(await initiativeRuns(low)).toHaveLength(1);

    await finishRuns();
    // Low allows one run per 24h.
    expect((await heartbeat.tickInitiative(new Date(now.getTime() + 2 * HOUR))).enqueued).toBe(0);
  });

  it("does not stack on an agent that is already working", async () => {
    const companyId = await insertCompany();
    const agentId = await insertAgent(companyId);
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "assignment" });
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.tickInitiative(now)).enqueued).toBe(0);
  });
});
