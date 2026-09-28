import { describe, expect, it, vi } from "vitest";
import { chunkMarkdown } from "../src/memory/chunker.js";
import { assembleContext, MEMORY_TOOLS_HINT, recallQueryForRun } from "../src/memory/context.js";
import { batchTexts, createEmbeddingsClient } from "../src/memory/embeddings.js";
import { dailyLogPath, normalizeMemoryPath, noteDateFromPath } from "../src/memory/paths.js";
import {
  cosineSimilarity,
  mergeHybrid,
  mmrSelect,
  recencyDecay,
  snippet,
  type MemoryCandidate,
} from "../src/memory/ranking.js";

function candidate(id: string, text: string, noteDate: string | null = null): MemoryCandidate {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    path: noteDate ? `memory/${noteDate}.md` : "MEMORY.md",
    scopeKind: "company",
    scopeId: "c1",
    noteDate,
    startLine: 1,
    endLine: 1,
    text,
  };
}

describe("paths", () => {
  it("normalizes safe markdown paths", () => {
    expect(normalizeMemoryPath("/memory/2026-09-28.md")).toBe("memory/2026-09-28.md");
    expect(normalizeMemoryPath("MEMORY.md")).toBe("MEMORY.md");
  });

  it("rejects traversal, non-markdown, and deep paths", () => {
    expect(() => normalizeMemoryPath("../secrets.md")).toThrow();
    expect(() => normalizeMemoryPath("memory/.hidden.md")).toThrow();
    expect(() => normalizeMemoryPath("notes.txt")).toThrow(/markdown/);
    expect(() => normalizeMemoryPath("a/b/c/d/e.md")).toThrow(/levels/);
  });

  it("detects dated notes, including slugged ones, and rejects impossible dates", () => {
    expect(noteDateFromPath("memory/2026-09-28.md")).toBe("2026-09-28");
    expect(noteDateFromPath("memory/2026-09-28-standup.md")).toBe("2026-09-28");
    expect(noteDateFromPath("MEMORY.md")).toBeNull();
    expect(noteDateFromPath("memory/2026-02-30.md")).toBeNull();
    expect(dailyLogPath(new Date("2026-09-28T23:59:00Z"))).toBe("memory/2026-09-28.md");
  });
});

describe("chunkMarkdown", () => {
  it("keeps short documents in one chunk with line numbers", () => {
    expect(chunkMarkdown("# A\n\nline two\n")).toEqual([
      { index: 0, startLine: 1, endLine: 4, text: "# A\n\nline two\n" },
    ]);
  });

  it("splits long documents with overlap and never exceeds the budget", () => {
    const body = Array.from({ length: 60 }, (_, i) => `- fact number ${i} about the company`).join("\n");
    const chunks = chunkMarkdown(body, { maxChars: 400, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(400);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine);
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
    }
    expect(chunks.at(-1)!.endLine).toBe(60);
  });

  it("hard-splits a single overlong line", () => {
    const chunks = chunkMarkdown("x".repeat(1_000), { maxChars: 300, overlapChars: 50 });
    expect(chunks.every((chunk) => chunk.text.length <= 300)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain("x".repeat(300));
  });

  it("skips blank-only documents", () => {
    expect(chunkMarkdown("\n\n\n")).toEqual([]);
  });
});

describe("ranking", () => {
  const now = new Date("2026-09-28T00:00:00Z");

  it("halves dated notes every 30 days and leaves evergreen files alone", () => {
    expect(recencyDecay(null, now)).toBe(1);
    expect(recencyDecay("2026-09-28", now)).toBe(1);
    expect(recencyDecay("2026-08-29", now)).toBeCloseTo(0.5, 5);
  });

  it("weights vector 0.7 and keyword 0.3 when vectors are on", () => {
    const merged = mergeHybrid(
      [{ ...candidate("a", "alpha"), vectorScore: 1 }],
      [{ ...candidate("a", "alpha"), textScore: 1 }, { ...candidate("b", "beta"), textScore: 1 }],
      { vectorEnabled: true, now },
    );
    expect(merged.find((c) => c.chunkId === "a")!.score).toBeCloseTo(1);
    expect(merged.find((c) => c.chunkId === "b")!.score).toBeCloseTo(0.3);
  });

  it("gives keyword the full weight without vectors", () => {
    const merged = mergeHybrid([], [{ ...candidate("a", "alpha"), textScore: 0.8 }], { vectorEnabled: false, now });
    expect(merged[0]!.score).toBeCloseTo(0.8);
  });

  it("drops near-duplicates with MMR", () => {
    const scored = mergeHybrid(
      [],
      [
        { ...candidate("a", "launch date is october 14 for the new plan"), textScore: 1 },
        { ...candidate("b", "launch date is october 14 for the new plan too"), textScore: 0.95 },
        { ...candidate("c", "hiring a designer next quarter"), textScore: 0.6 },
      ],
      { vectorEnabled: false, now },
    );
    expect(mmrSelect(scored, 2).map((c) => c.chunkId)).toEqual(["a", "c"]);
  });

  it("caps snippets and computes cosine similarity", () => {
    expect(snippet("y".repeat(900)).length).toBe(700);
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
  });
});

describe("embeddings client", () => {
  it("batches by size and count", () => {
    expect(batchTexts(["aa", "bb", "cc"], 4, 10)).toEqual([[0, 1], [2]]);
    expect(batchTexts(["a", "b", "c"], 100, 2)).toEqual([[0, 1], [2]]);
  });

  it("posts to <base>/embeddings and restores input order", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      const data = body.input.map((text, index) => ({ index, embedding: [text.length] })).reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const client = createEmbeddingsClient(
      { baseUrl: "https://openrouter.ai/api/v1/", model: "m", apiKey: "k" },
      fetchMock,
    );
    expect(await client.embed(["a", "bbb"])).toEqual([[1], [3]]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/embeddings");
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("surfaces provider errors", async () => {
    const client = createEmbeddingsClient(
      { baseUrl: "https://x", model: "m", apiKey: "k" },
      async () => new Response("quota exceeded", { status: 429 }),
    );
    await expect(client.embed(["a"])).rejects.toThrow(/429/);
  });
});

describe("assembleContext", () => {
  it("returns nothing when there is no memory", () => {
    expect(assembleContext([{ title: "Empty", body: "  ", priority: 1 }], 1_000)).toBe("");
  });

  it("keeps order, prefers high priority, and truncates to the budget", () => {
    const text = assembleContext(
      [
        { title: "Low", body: "l".repeat(2_000), priority: 5 },
        { title: "High", body: "important fact", priority: 1 },
      ],
      800,
    );
    expect(text.startsWith(MEMORY_TOOLS_HINT)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text.indexOf("### Low")).toBeLessThan(text.indexOf("### High"));
    expect(text).toContain("important fact");
    expect(text).toContain("truncated");
  });

  it("derives the recall query from the issue, else the wake reason", () => {
    expect(recallQueryForRun({ issueTitle: "Fix pricing page", issueDescription: null, wakeReason: "x" })).toBe(
      "Fix pricing page",
    );
    expect(recallQueryForRun({ wakeReason: "heartbeat_timer" })).toBe("heartbeat timer");
  });
});
