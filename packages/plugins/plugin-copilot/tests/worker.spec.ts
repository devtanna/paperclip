import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { REINDEX_JOB_KEY } from "../src/manifest.js";
import { MEMORY_TOOL_NAMES } from "../src/memory/service.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const harness = createTestHarness({ manifest, config: {} });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("copilot memory worker", () => {
  it("declares a tool for every registered memory tool and the context capability", () => {
    expect(manifest.tools?.map((tool) => tool.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    expect(manifest.capabilities).toContain("agent.context.contribute");
    expect(manifest.jobs?.map((job) => job.jobKey)).toEqual([REINDEX_JOB_KEY]);
  });

  it("answers memory_search from the plugin database, scoped to company and agent", async () => {
    const harness = await setup();
    const result = await harness.executeTool<{ content?: string; error?: string }>(
      "memory_search",
      { query: "launch date" },
      { companyId: COMPANY_ID, agentId: AGENT_ID, runId: "run-1" },
    );
    expect(result.error).toBeUndefined();
    expect(result.content).toBe("No memory matches.");
    const search = harness.dbQueries.find((query) => query.sql.includes("ts_rank_cd"));
    expect(search?.params?.[0]).toBe(COMPANY_ID);
    expect(JSON.parse(String(search?.params?.[2]))).toEqual([`company:${COMPANY_ID}`, `agent:${AGENT_ID}`]);
  });

  it("rejects personal scopes from agent tools", async () => {
    const harness = await setup();
    const result = await harness.executeTool<{ error?: string }>(
      "memory_note",
      { text: "hello", scope: "user" },
      { companyId: COMPANY_ID, agentId: AGENT_ID, runId: "run-1" },
    );
    expect(result.error).toMatch(/scope must be/);
  });

  it("contributes no run context when there is no memory yet", async () => {
    await setup();
    const result = await plugin.definition.onContributeRunContext!({
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      runId: "run-1",
      wakeReason: "heartbeat_timer",
      invocationSource: "timer",
      issueId: null,
      conversationMode: false,
      maxChars: 12_000,
    });
    expect(result.markdown).toBe("");
  });
});
