import type {
  ContributeRunContextParams,
  PluginContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { assembleContext, recallQueryForRun, type ContextSection } from "./context.js";
import {
  createEmbeddingsClient,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  type EmbeddingsClient,
} from "./embeddings.js";
import {
  dailyLogPath,
  isMemoryScopeKind,
  LONG_TERM_MEMORY_PATH,
  USER_PROFILE_PATH,
  yesterday,
  type MemoryScope,
} from "./paths.js";
import {
  appendToDocument,
  getDocument,
  listDocuments,
  searchMemory,
  writeDocument,
  type MemoryActor,
} from "./store.js";

export interface CopilotConfig {
  embeddingsBaseUrl: string;
  embeddingsModel: string;
  embeddingsApiKeyRef: unknown;
  captureAgentRuns: boolean;
}

function isSecretRef(value: unknown): value is { type: "secret_ref"; secretId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

export async function readConfig(ctx: PluginContext, companyId: string): Promise<CopilotConfig> {
  const raw = (await ctx.config.get(companyId).catch(() => ({}))) as Record<string, unknown>;
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return {
    embeddingsBaseUrl: text(raw.embeddingsBaseUrl, DEFAULT_EMBEDDINGS_BASE_URL),
    embeddingsModel: text(raw.embeddingsModel, DEFAULT_EMBEDDINGS_MODEL),
    embeddingsApiKeyRef: raw.embeddingsApiKeyRef,
    captureAgentRuns: raw.captureAgentRuns !== false,
  };
}

/** Embeddings client for a company, or null (keyword-only search) when no key is configured. */
export async function resolveEmbeddings(ctx: PluginContext, companyId: string): Promise<EmbeddingsClient | null> {
  const config = await readConfig(ctx, companyId);
  if (!isSecretRef(config.embeddingsApiKeyRef)) return null;
  const apiKey = await ctx.secrets.resolve(config.embeddingsApiKeyRef, {
    companyId,
    configPath: "embeddingsApiKeyRef",
  });
  if (!apiKey) return null;
  return createEmbeddingsClient(
    { baseUrl: config.embeddingsBaseUrl, model: config.embeddingsModel, apiKey },
    (url, init) => ctx.http.fetch(url, init),
  );
}

export function companyScope(companyId: string): MemoryScope {
  return { kind: "company", id: companyId };
}

export function agentScope(agentId: string): MemoryScope {
  return { kind: "agent", id: agentId };
}

export function userScope(userId: string): MemoryScope {
  return { kind: "user", id: userId };
}

/** What an agent may read and search: shared company memory plus its own. */
export function agentVisibleScopes(companyId: string, agentId: string): MemoryScope[] {
  return [companyScope(companyId), agentScope(agentId)];
}

function logEmbeddingError(ctx: PluginContext, companyId: string) {
  return (error: unknown) =>
    ctx.logger.warn("memory embeddings unavailable; using keyword search", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

export async function buildRunContext(
  ctx: PluginContext,
  params: ContributeRunContextParams,
  now = new Date(),
): Promise<string> {
  const { companyId, agentId } = params;
  const issue = params.issueId ? await ctx.issues.get(params.issueId, companyId).catch(() => null) : null;
  const conversationUserId = params.conversationMode ? issue?.conversationUserId ?? null : null;

  const today = dailyLogPath(now);
  const previous = dailyLogPath(yesterday(now));
  const read = (scope: MemoryScope, path: string) =>
    getDocument(ctx.db, companyId, scope, path).then((doc) => doc?.body ?? "");

  const [companyMemory, agentMemory, userProfile, companyToday, companyYesterday, agentToday, agentYesterday] =
    await Promise.all([
      read(companyScope(companyId), LONG_TERM_MEMORY_PATH),
      read(agentScope(agentId), LONG_TERM_MEMORY_PATH),
      conversationUserId ? read(userScope(conversationUserId), USER_PROFILE_PATH) : Promise.resolve(""),
      read(companyScope(companyId), today),
      read(companyScope(companyId), previous),
      read(agentScope(agentId), today),
      read(agentScope(agentId), previous),
    ]);

  const recallQuery = recallQueryForRun({
    issueTitle: issue?.title,
    issueDescription: issue?.description,
    wakeReason: params.wakeReason,
  });
  const scopes = agentVisibleScopes(companyId, agentId);
  if (conversationUserId) scopes.push(userScope(conversationUserId));
  const recalled = recallQuery
    ? await searchMemory(ctx.db, {
        companyId,
        scopes,
        query: recallQuery,
        topK: 5,
        embeddings: await resolveEmbeddings(ctx, companyId).catch(() => null),
        now,
        onEmbeddingError: logEmbeddingError(ctx, companyId),
      }).catch(() => ({ results: [] }))
    : { results: [] };

  const sections: ContextSection[] = [
    { title: "Company memory (MEMORY.md)", body: companyMemory, priority: 1 },
    { title: "Your memory (MEMORY.md)", body: agentMemory, priority: 2 },
    { title: "About the person you are talking to (USER.md)", body: userProfile, priority: 1 },
    {
      title: "Recalled memory",
      body: recalled.results
        .map((hit) => `- \`${hit.scope.kind}/${hit.path}#L${hit.startLine}\`: ${hit.snippet.replace(/\n+/g, " ")}`)
        .join("\n"),
      priority: 3,
    },
    { title: `Company notes today (${today})`, body: companyToday, priority: 4 },
    { title: `Your notes today (${today})`, body: agentToday, priority: 4 },
    { title: `Company notes yesterday (${previous})`, body: companyYesterday, priority: 5 },
    { title: `Your notes yesterday (${previous})`, body: agentYesterday, priority: 5 },
  ];
  return assembleContext(sections, params.maxChars);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ToolParams = Record<string, unknown>;

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

/** Tools address the shared company memory or the calling agent's own. */
function toolScope(value: unknown, run: ToolRunContext, fallback: "company" | "agent"): MemoryScope {
  const kind = value === undefined || value === null || value === "" ? fallback : value;
  if (kind === "company") return companyScope(run.companyId);
  if (kind === "agent") return agentScope(run.agentId);
  throw new Error(`scope must be "company" or "agent"${isMemoryScopeKind(kind) ? " for agent tools" : ""}`);
}

function agentActor(run: ToolRunContext): MemoryActor {
  return { kind: "agent", id: run.agentId };
}

async function logWrite(ctx: PluginContext, run: ToolRunContext, scope: MemoryScope, path: string, action: string) {
  await ctx.activity
    .log({
      companyId: run.companyId,
      message: `Agent ${action} ${scope.kind} memory ${path}`,
      entityType: "agent",
      entityId: run.agentId,
      metadata: { scopeKind: scope.kind, scopeId: scope.id, path, runId: run.runId },
    })
    .catch(() => undefined);
}

function asTool(fn: (params: ToolParams, run: ToolRunContext) => Promise<ToolResult>) {
  return async (params: unknown, run: ToolRunContext): Promise<ToolResult> => {
    try {
      return await fn((params ?? {}) as ToolParams, run);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_get",
  "memory_note",
  "memory_write",
  "memory_forget",
  "memory_list",
] as const;

export function registerMemoryTools(ctx: PluginContext): void {
  const schemaFor = (name: string) =>
    ctx.manifest.tools?.find((tool) => tool.name === name)?.parametersSchema ?? { type: "object" };
  const descriptionFor = (name: string) =>
    ctx.manifest.tools?.find((tool) => tool.name === name)?.description ?? name;
  const register = (name: (typeof MEMORY_TOOL_NAMES)[number], displayName: string, fn: Parameters<typeof asTool>[0]) =>
    ctx.tools.register(
      name,
      { displayName, description: descriptionFor(name), parametersSchema: schemaFor(name) },
      asTool(fn),
    );

  register("memory_search", "Search Memory", async (params, run) => {
    const query = requireText(params.query, "query");
    const { results, mode } = await searchMemory(ctx.db, {
      companyId: run.companyId,
      scopes: agentVisibleScopes(run.companyId, run.agentId),
      query,
      topK: typeof params.topK === "number" ? params.topK : undefined,
      embeddings: await resolveEmbeddings(ctx, run.companyId).catch(() => null),
      onEmbeddingError: logEmbeddingError(ctx, run.companyId),
    });
    return {
      content: results.length
        ? results
            .map((hit) => `[${hit.scope.kind}] ${hit.path}#L${hit.startLine}-${hit.endLine} (score ${hit.score})\n${hit.snippet}`)
            .join("\n\n")
        : "No memory matches.",
      data: { mode, results },
    };
  });

  register("memory_get", "Read Memory File", async (params, run) => {
    const scope = toolScope(params.scope, run, "company");
    const path = requireText(params.path, "path");
    const document = await getDocument(ctx.db, run.companyId, scope, path);
    if (!document) return { content: `No ${scope.kind} memory file at ${path}.`, data: { exists: false } };
    const lines = document.body.split("\n");
    const from = Math.max(1, typeof params.fromLine === "number" ? Math.floor(params.fromLine) : 1);
    const count = typeof params.lines === "number" ? Math.max(1, Math.floor(params.lines)) : lines.length;
    const selected = lines.slice(from - 1, from - 1 + count).join("\n");
    return {
      content: selected,
      data: { exists: true, path: document.path, scope: scope.kind, totalLines: lines.length, updatedAt: document.updatedAt },
    };
  });

  register("memory_note", "Note To Daily Log", async (params, run) => {
    const scope = toolScope(params.scope, run, "agent");
    const text = requireText(params.text, "text");
    const now = new Date();
    const path = dailyLogPath(now);
    const time = now.toISOString().slice(11, 16);
    await appendToDocument(ctx.db, {
      companyId: run.companyId,
      scope,
      path,
      text: `- ${time} ${text.trim().replace(/\n+/g, " ")}`,
      actor: agentActor(run),
      header: `# ${path.slice("memory/".length, -3)}`,
    });
    if (scope.kind === "company") await logWrite(ctx, run, scope, path, "noted in");
    return { content: `Noted in ${scope.kind} ${path}.` };
  });

  register("memory_write", "Write Memory File", async (params, run) => {
    const scope = toolScope(params.scope, run, "agent");
    const path = requireText(params.path, "path");
    const content = typeof params.content === "string" ? params.content : requireText(params.content, "content");
    const document = await writeDocument(ctx.db, {
      companyId: run.companyId,
      scope,
      path,
      body: content,
      actor: agentActor(run),
      reason: typeof params.reason === "string" ? params.reason : "memory_write",
    });
    await logWrite(ctx, run, scope, document.path, "updated");
    return { content: `Wrote ${scope.kind} ${document.path} (${document.body.length} chars).` };
  });

  register("memory_forget", "Forget Memory Lines", async (params, run) => {
    const scope = toolScope(params.scope, run, "agent");
    const path = requireText(params.path, "path");
    const match = requireText(params.match, "match").toLowerCase();
    const document = await getDocument(ctx.db, run.companyId, scope, path);
    if (!document) throw new Error(`No ${scope.kind} memory file at ${path}`);
    const lines = document.body.split("\n");
    const kept = lines.filter((line) => !line.toLowerCase().includes(match));
    const removed = lines.length - kept.length;
    if (removed === 0) return { content: `No lines in ${path} contain that text.` };
    if (removed > 20) throw new Error(`That would remove ${removed} lines; use a more specific match`);
    await writeDocument(ctx.db, {
      companyId: run.companyId,
      scope,
      path,
      body: kept.join("\n"),
      actor: agentActor(run),
      reason: typeof params.reason === "string" ? `forget: ${params.reason}` : "forget",
    });
    await logWrite(ctx, run, scope, document.path, "removed lines from");
    return { content: `Removed ${removed} line(s) from ${scope.kind} ${path}. The previous version is kept as a revision.` };
  });

  register("memory_list", "List Memory Files", async (_params, run) => {
    const documents = await listDocuments(ctx.db, run.companyId, agentVisibleScopes(run.companyId, run.agentId));
    return {
      content: documents.length
        ? documents.map((doc) => `[${doc.scope.kind}] ${doc.path} (${doc.chars} chars)`).join("\n")
        : "No memory files yet.",
      data: { documents },
    };
  });
}
