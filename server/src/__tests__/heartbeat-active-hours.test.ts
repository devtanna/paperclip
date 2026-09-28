import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  isWithinHeartbeatActiveHours,
  parseHeartbeatActiveHours,
} from "../services/heartbeat-active-hours.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

describe("parseHeartbeatActiveHours", () => {
  it("parses a window and defaults the timezone to UTC", () => {
    expect(parseHeartbeatActiveHours({ start: "08:00", end: "22:30" })).toEqual({
      startMinute: 480,
      endMinute: 1350,
      timezone: "UTC",
    });
  });

  it("treats missing, malformed, zero-width, and bad-timezone windows as unrestricted", () => {
    expect(parseHeartbeatActiveHours(undefined)).toBeNull();
    expect(parseHeartbeatActiveHours({ start: "8am", end: "22:00" })).toBeNull();
    expect(parseHeartbeatActiveHours({ start: "24:00", end: "22:00" })).toBeNull();
    expect(parseHeartbeatActiveHours({ start: "09:00", end: "09:00" })).toBeNull();
    expect(parseHeartbeatActiveHours({ start: "09:00", end: "17:00", timezone: "Mars/Olympus" })).toBeNull();
  });
});

describe("isWithinHeartbeatActiveHours", () => {
  const daytime = parseHeartbeatActiveHours({ start: "08:00", end: "22:00", timezone: "Asia/Dubai" })!;

  it("evaluates the window in the configured timezone", () => {
    // 04:30 UTC is 08:30 in Dubai (UTC+4).
    expect(isWithinHeartbeatActiveHours(daytime, new Date("2026-09-28T04:30:00Z"))).toBe(true);
    // 02:00 UTC is 06:00 in Dubai.
    expect(isWithinHeartbeatActiveHours(daytime, new Date("2026-09-28T02:00:00Z"))).toBe(false);
  });

  it("includes the start and excludes the end", () => {
    const utc = parseHeartbeatActiveHours({ start: "08:00", end: "22:00" })!;
    expect(isWithinHeartbeatActiveHours(utc, new Date("2026-09-28T08:00:00Z"))).toBe(true);
    expect(isWithinHeartbeatActiveHours(utc, new Date("2026-09-28T22:00:00Z"))).toBe(false);
  });

  it("supports windows that span midnight", () => {
    const overnight = parseHeartbeatActiveHours({ start: "22:00", end: "06:00" })!;
    expect(isWithinHeartbeatActiveHours(overnight, new Date("2026-09-28T23:30:00Z"))).toBe(true);
    expect(isWithinHeartbeatActiveHours(overnight, new Date("2026-09-28T05:59:00Z"))).toBe(true);
    expect(isWithinHeartbeatActiveHours(overnight, new Date("2026-09-28T12:00:00Z"))).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tickTimers active hours", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-active-hours-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(activeHours: Record<string, string>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Active Hours Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Copilot",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, activeHours },
      },
      permissions: {},
      createdAt: new Date("2026-09-28T00:00:00Z"),
    });
    return agentId;
  }

  async function timerRunCount(agentId: string) {
    const rows = await db.select().from(heartbeatRuns);
    return rows.filter((row) => row.agentId === agentId).length;
  }

  it("skips timer wakes outside the window and fires inside it", async () => {
    const agentId = await insertAgent({ start: "08:00", end: "22:00", timezone: "UTC" });
    const heartbeat = heartbeatService(db);

    const night = await heartbeat.tickTimers(new Date("2026-09-28T03:00:00Z"));
    expect(night.enqueued).toBe(0);
    expect(await timerRunCount(agentId)).toBe(0);

    const morning = await heartbeat.tickTimers(new Date("2026-09-28T08:05:00Z"));
    expect(morning.enqueued).toBe(1);
    expect(await timerRunCount(agentId)).toBe(1);
  });
});
