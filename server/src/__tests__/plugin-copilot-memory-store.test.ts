import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import copilotManifest from "../../../packages/plugins/plugin-copilot/src/manifest.js";
import {
  appendToDocument,
  getDocument,
  hasVectorExtension,
  indexDocument,
  indexStatus,
  listBrowsableDocuments,
  reindexPending,
  resetVectorExtensionProbe,
  searchMemory,
  writeDocument,
} from "../../../packages/plugins/plugin-copilot/src/memory/store.js";
import type { EmbeddingsClient } from "../../../packages/plugins/plugin-copilot/src/memory/embeddings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { derivePluginDatabaseNamespace, pluginDatabaseService } from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Deterministic "semantic" embeddings: words in the same synonym group land on
// the same dimension, so a paraphrase with no shared keyword still matches.
const SYNONYMS: string[][] = [
  ["pricing", "price", "cost", "costs", "expensive", "charge", "charges"],
  ["launch", "ship", "release", "go-live"],
  ["hire", "hiring", "recruit", "candidate"],
  ["customer", "client", "buyer"],
];
function fakeEmbed(text: string): number[] {
  const vector = new Array(SYNONYMS.length + 1).fill(0);
  for (const word of text.toLowerCase().match(/[a-z-]+/g) ?? []) {
    const group = SYNONYMS.findIndex((words) => words.includes(word));
    vector[group === -1 ? SYNONYMS.length : group] += group === -1 ? 0.05 : 1;
  }
  return vector;
}
const fakeEmbeddings: EmbeddingsClient = {
  model: "fake-synonyms",
  embed: async (texts) => texts.map(fakeEmbed),
};

describe("copilot memory manifest", () => {
  it("passes the host manifest schema", () => {
    expect(() => pluginManifestV1Schema.parse(copilotManifest)).not.toThrow();
  });
});

describeEmbeddedPostgres("copilot memory store (real Postgres, plugin SQL validators)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let memoryDb!: { namespace: string; query: any; execute: any };
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-copilot-memory-");
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

    // The same validated query/execute path the worker's ctx.db uses.
    memoryDb = {
      namespace: derivePluginDatabaseNamespace(copilotManifest.id, copilotManifest.database?.namespaceSlug),
      query: (statement: string, params?: unknown[]) => service.query(pluginId, statement, params),
      execute: (statement: string, params?: unknown[]) => service.execute(pluginId, statement, params),
    };
  }, 30_000);

  beforeEach(async () => {
    await db.execute(sql.raw(`DELETE FROM ${memoryDb.namespace}.memory_documents`));
    await db.execute(sql.raw(`DELETE FROM ${memoryDb.namespace}.embedding_cache`));
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Memory Co",
      status: "active",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${memoryDb?.namespace}" CASCADE`)).catch(() => undefined);
    await db.delete(pluginMigrations).catch(() => undefined);
    await db.delete(pluginDatabaseNamespaces).catch(() => undefined);
    await tempDb?.cleanup();
  });

  const company = () => ({ kind: "company" as const, id: companyId });
  const system = { kind: "system" as const, id: "test" };

  it("writes documents, keeps revisions, and dates daily notes", async () => {
    const first = await writeDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "MEMORY.md",
      body: "# Company\n\n- We sell to dentists.\n",
      actor: system,
    });
    expect(first.noteDate).toBeNull();

    const second = await writeDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "MEMORY.md",
      body: "# Company\n\n- We sell to dentists and orthodontists.\n",
      actor: system,
    });
    expect(second.id).toBe(first.id);
    const revisions = await memoryDb.query(
      `SELECT body FROM ${memoryDb.namespace}.memory_document_revisions WHERE document_id = $1`,
      [first.id],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0].body).toContain("We sell to dentists.");

    const log = await appendToDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "memory/2026-09-28.md",
      text: "- 09:00 kicked off pricing review",
      actor: system,
      header: "# 2026-09-28",
    });
    expect(log.noteDate).toBe("2026-09-28");
    const appended = await appendToDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "memory/2026-09-28.md",
      text: "- 10:00 agreed on usage-based plan",
      actor: system,
    });
    expect(appended.body).toBe("# 2026-09-28\n- 09:00 kicked off pricing review\n- 10:00 agreed on usage-based plan\n");
  });

  it("only lists a user's own personal memory", async () => {
    await writeDocument(memoryDb, { companyId, scope: { kind: "user", id: "alice" }, path: "USER.md", body: "Alice", actor: system });
    await writeDocument(memoryDb, { companyId, scope: { kind: "user", id: "bob" }, path: "USER.md", body: "Bob", actor: system });
    await writeDocument(memoryDb, { companyId, scope: company(), path: "MEMORY.md", body: "Shared", actor: system });

    const forAlice = await listBrowsableDocuments(memoryDb, companyId, "alice");
    expect(forAlice.map((doc) => `${doc.scope.kind}:${doc.scope.id}`).sort()).toEqual([
      `company:${companyId}`,
      "user:alice",
    ]);
  });

  it("indexes pending documents and finds them by keyword", async () => {
    await writeDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "MEMORY.md",
      body: "# Decisions\n\n- Launch date is October 14.\n- Pricing is usage based.\n",
      actor: system,
    });
    expect((await indexStatus(memoryDb, companyId)).pending).toBe(1);

    expect(await reindexPending(memoryDb, async () => null)).toBe(1);
    const status = await indexStatus(memoryDb, companyId);
    expect(status.pending).toBe(0);
    expect(status.chunks).toBe(1);

    const { results, mode } = await searchMemory(memoryDb, {
      companyId,
      scopes: [company()],
      query: "when is the launch?",
    });
    expect(mode).toBe("keyword");
    expect(results[0]?.path).toBe("MEMORY.md");
    expect(results[0]?.snippet).toContain("October 14");
  });

  it("recalls a paraphrase through vectors, in-process when pgvector is absent", async () => {
    resetVectorExtensionProbe();
    const vector = await hasVectorExtension(memoryDb);
    const document = await writeDocument(memoryDb, {
      companyId,
      scope: company(),
      path: "MEMORY.md",
      body: "- Our plan charges per seat, billed monthly.\n",
      actor: system,
    });
    await indexDocument(memoryDb, document, fakeEmbeddings);

    const keywordOnly = await searchMemory(memoryDb, { companyId, scopes: [company()], query: "how expensive is it" });
    expect(keywordOnly.results).toHaveLength(0);

    const hybrid = await searchMemory(memoryDb, {
      companyId,
      scopes: [company()],
      query: "how expensive is it",
      embeddings: fakeEmbeddings,
    });
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.results[0]?.snippet).toContain("charges per seat");
    expect(hybrid.results[0]?.vectorScore).toBeGreaterThan(0.5);
    // Embedded Postgres in tests normally lacks pgvector, which exercises the JS path.
    expect(typeof vector).toBe("boolean");

    const cached = await memoryDb.query(`SELECT count(*)::text AS n FROM ${memoryDb.namespace}.embedding_cache`);
    expect(Number(cached[0].n)).toBeGreaterThan(0);
  });

  it("ranks a recent daily note above an old one and never mixes scopes", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    for (const [path, body] of [
      ["memory/2026-06-01.md", "- customer churn discussion"],
      ["memory/2026-09-27.md", "- customer churn discussion"],
    ] as const) {
      const document = await writeDocument(memoryDb, { companyId, scope: company(), path, body, actor: system });
      await indexDocument(memoryDb, document, null);
    }
    const privateNote = await writeDocument(memoryDb, {
      companyId,
      scope: { kind: "agent", id: "agent-x" },
      path: "MEMORY.md",
      body: "- customer churn is private to agent x",
      actor: system,
    });
    await indexDocument(memoryDb, privateNote, null);

    const { results } = await searchMemory(memoryDb, {
      companyId,
      scopes: [company()],
      query: "customer churn",
      now,
    });
    expect(results.map((hit) => hit.path)).toEqual(["memory/2026-09-27.md", "memory/2026-06-01.md"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results.some((hit) => hit.scope.kind === "agent")).toBe(false);
  });

  it("rejects unsafe paths", async () => {
    await expect(
      writeDocument(memoryDb, { companyId, scope: company(), path: "../escape.md", body: "x", actor: system }),
    ).rejects.toThrow(/Invalid memory path/);
    await expect(
      getDocument(memoryDb, companyId, company(), "notes.txt"),
    ).rejects.toThrow(/markdown/);
  });
});
