import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Every run reports the same provider session, so the session only changes
// when Paperclip rotates it.
const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "session-1" },
    sessionDisplayId: "session-1",
    summary: "memory flush test run",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not finish`);
}

describeEmbeddedPostgres("memory flush before session compaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-memory-flush-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db)).catch(() => undefined);
    await tempDb?.cleanup();
  });

  async function runSequence(memoryFlush: boolean) {
    adapterExecute.mockClear();
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Flush Co",
      status: "active",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Flusher",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: false, wakeOnDemand: true, sessionCompaction: { maxSessionRuns: 1 }, memoryFlush },
      },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const contexts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      const finished = await waitForRun(heartbeat, run!.id);
      expect(finished?.status).toBe("succeeded");
      const call = adapterExecute.mock.calls.at(-1) as unknown as [
        { context: Record<string, unknown>; runtime: { sessionId: string | null } },
      ];
      contexts.push({ ...call[0].context, resumedSessionId: call[0].runtime.sessionId });
    }
    return contexts;
  }

  it("asks the agent to save memory on the old session once, then rotates", async () => {
    const [first, second, third, fourth] = await runSequence(true);
    expect(first!.paperclipMemoryFlushNote).toBeUndefined();
    expect(second!.paperclipMemoryFlushNote).toBeUndefined();

    // Rotation is due: the flush run keeps the old session and carries the note.
    expect(third!.paperclipMemoryFlushNote).toMatch(/about to be compacted/);
    expect(third!.resumedSessionId).toBe("session-1");
    expect(third!.paperclipSessionRotationReason).toBeUndefined();

    // The next run rotates as usual, without a second flush.
    expect(fourth!.paperclipMemoryFlushNote).toBeUndefined();
    expect(fourth!.paperclipSessionRotationReason).toMatch(/exceeded 1 runs/);
    expect(fourth!.resumedSessionId).toBeNull();
  });

  it("rotates immediately when memory flush is off", async () => {
    const [, , third] = await runSequence(false);
    expect(third!.paperclipMemoryFlushNote).toBeUndefined();
    expect(third!.paperclipSessionRotationReason).toMatch(/exceeded 1 runs/);
  });
});
