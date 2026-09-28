import { describe, expect, it, vi } from "vitest";
import { collectPluginRunContext } from "../services/plugin-run-context.js";

const INPUT = {
  companyId: "company-1",
  agentId: "agent-1",
  runId: "run-1",
  wakeReason: "heartbeat_timer",
  invocationSource: "timer",
  issueId: null,
  conversationMode: false,
};

function pluginRow(id: string, capabilities: string[], displayName = id) {
  return { id, pluginKey: `key.${id}`, manifestJson: { displayName, capabilities } };
}

function createDb(rows: ReturnType<typeof pluginRow>[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as any;
}

function createWorkerManager(handlers: Record<string, (params: any) => Promise<unknown>>) {
  return {
    isRunning: (id: string) => id in handlers,
    call: vi.fn((id: string, _method: string, params: unknown) => handlers[id]!(params)),
  } as any;
}

describe("collectPluginRunContext", () => {
  it("returns nothing without a worker manager", async () => {
    const result = await collectPluginRunContext(createDb([]), undefined, INPUT);
    expect(result).toEqual({ markdown: "", sources: [] });
  });

  it("only asks running plugins that declare the capability", async () => {
    const manager = createWorkerManager({
      memory: async () => ({ markdown: "Remember the launch date." }),
      other: async () => ({ markdown: "should not appear" }),
    });
    const db = createDb([
      pluginRow("memory", ["agent.context.contribute"], "Copilot Memory"),
      pluginRow("other", ["agent.tools.register"]),
      pluginRow("stopped", ["agent.context.contribute"]),
    ]);

    const result = await collectPluginRunContext(db, manager, INPUT);

    expect(manager.call).toHaveBeenCalledTimes(1);
    expect(manager.call.mock.calls[0]![1]).toBe("contributeRunContext");
    expect(manager.call.mock.calls[0]![2]).toMatchObject({ runId: "run-1", maxChars: 24_000 });
    expect(result.markdown).toBe("## Copilot Memory\n\nRemember the launch date.");
    expect(result.sources).toEqual([{ pluginKey: "key.memory", chars: 25, truncated: false }]);
  });

  it("drops failing and slow plugins without failing the run", async () => {
    const manager = createWorkerManager({
      broken: async () => {
        throw new Error("boom");
      },
      slow: () => new Promise((resolve) => setTimeout(() => resolve({ markdown: "late" }), 200)),
      fine: async () => ({ markdown: "ok" }),
    });
    const db = createDb([
      pluginRow("broken", ["agent.context.contribute"]),
      pluginRow("slow", ["agent.context.contribute"]),
      pluginRow("fine", ["agent.context.contribute"]),
    ]);

    const result = await collectPluginRunContext(db, manager, INPUT, { timeoutMs: 20 });

    expect(result.markdown).toBe("## fine\n\nok");
    expect(result.sources.find((s) => s.pluginKey === "key.broken")?.error).toBe("boom");
    expect(result.sources.find((s) => s.pluginKey === "key.slow")?.error).toMatch(/timed out/);
  });

  it("splits the character budget and truncates oversized markdown", async () => {
    const manager = createWorkerManager({
      a: async () => ({ markdown: "x".repeat(500) }),
      b: async () => ({ markdown: "short" }),
    });
    const db = createDb([
      pluginRow("a", ["agent.context.contribute"]),
      pluginRow("b", ["agent.context.contribute"]),
    ]);

    const result = await collectPluginRunContext(db, manager, INPUT, { maxChars: 200 });

    const a = result.sources.find((s) => s.pluginKey === "key.a")!;
    expect(a.truncated).toBe(true);
    expect(a.chars).toBeLessThanOrEqual(100);
    expect(result.markdown).toContain("…(truncated)");
    expect(result.markdown).toContain("## b\n\nshort");
  });
});
