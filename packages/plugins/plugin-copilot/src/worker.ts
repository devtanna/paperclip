import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { REINDEX_JOB_KEY } from "./manifest.js";
import { dailyLogPath, isMemoryScopeKind, type MemoryScope } from "./memory/paths.js";
import {
  agentScope,
  buildRunContext,
  companyScope,
  readConfig,
  registerMemoryTools,
  resolveEmbeddings,
  userScope,
} from "./memory/service.js";
import {
  appendToDocument,
  getDocument,
  hasVectorExtension,
  indexStatus,
  listBrowsableDocuments,
  reindexPending,
  searchMemory,
  writeDocument,
} from "./memory/store.js";

let activeContext: PluginContext | null = null;

function requireContext(): PluginContext {
  if (!activeContext) throw new Error("Copilot Memory worker is not initialized");
  return activeContext;
}

function queryString(input: PluginApiRequestInput, key: string): string | null {
  const value = input.query[key];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function bodyField(input: PluginApiRequestInput, key: string): unknown {
  return input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>)[key] : undefined;
}

function badRequest(message: string): PluginApiResponse {
  return { status: 400, body: { error: message } };
}

/**
 * Resolves a scope a board user asked for. Company memory and any agent in the
 * company are shared; user memory is visible only to that user.
 */
async function resolveBoardScope(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  kind: unknown,
  id: unknown,
): Promise<MemoryScope | PluginApiResponse> {
  if (!isMemoryScopeKind(kind)) return badRequest("scopeKind must be company, user, or agent");
  if (kind === "company") return companyScope(input.companyId);
  if (kind === "user") {
    const userId = input.actor.userId;
    if (!userId) return { status: 403, body: { error: "Personal memory requires a signed-in user" } };
    if (typeof id === "string" && id && id !== userId) {
      return { status: 403, body: { error: "You can only open your own personal memory" } };
    }
    return userScope(userId);
  }
  if (typeof id !== "string" || !id) return badRequest("scopeId is required for agent memory");
  const agent = await ctx.agents.get(id, input.companyId).catch(() => null);
  if (!agent) return { status: 404, body: { error: "Agent not found in this company" } };
  return agentScope(id);
}

function isResponse(value: MemoryScope | PluginApiResponse): value is PluginApiResponse {
  return !("kind" in value);
}

async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const companyId = input.companyId;
  const userId = input.actor.userId ?? null;

  if (input.routeKey === "status") {
    const [status, vector, embeddings] = await Promise.all([
      indexStatus(ctx.db, companyId),
      hasVectorExtension(ctx.db),
      resolveEmbeddings(ctx, companyId).catch(() => null),
    ]);
    return {
      body: {
        ...status,
        vectorExtension: vector,
        embeddingsConfigured: embeddings !== null,
        mode: embeddings ? "hybrid" : "keyword",
      },
    };
  }

  if (input.routeKey === "documents") {
    return { body: { documents: await listBrowsableDocuments(ctx.db, companyId, userId), userId } };
  }

  if (input.routeKey === "document") {
    const scope = await resolveBoardScope(ctx, input, queryString(input, "scopeKind"), queryString(input, "scopeId"));
    if (isResponse(scope)) return scope;
    const path = queryString(input, "path");
    if (!path) return badRequest("path is required");
    const document = await getDocument(ctx.db, companyId, scope, path);
    return { body: { document: document ?? { scope, path, body: "", exists: false } } };
  }

  if (input.routeKey === "write-document") {
    const scope = await resolveBoardScope(ctx, input, bodyField(input, "scopeKind"), bodyField(input, "scopeId"));
    if (isResponse(scope)) return scope;
    const path = bodyField(input, "path");
    const body = bodyField(input, "body");
    if (typeof path !== "string" || typeof body !== "string") return badRequest("path and body are required");
    const document = await writeDocument(ctx.db, {
      companyId,
      scope,
      path,
      body,
      actor: { kind: "user", id: userId },
      reason: "edited in Memory page",
    });
    await ctx.activity
      .log({
        companyId,
        message: `Edited ${scope.kind} memory ${document.path}`,
        entityType: "memory_document",
        entityId: document.id,
        metadata: { scopeKind: scope.kind, scopeId: scope.id, path: document.path, userId },
      })
      .catch(() => undefined);
    return { body: { document } };
  }

  if (input.routeKey === "search") {
    const query = queryString(input, "q");
    if (!query) return badRequest("q is required");
    const scopes: MemoryScope[] = [companyScope(companyId)];
    if (userId) scopes.push(userScope(userId));
    const agentIds = (await listBrowsableDocuments(ctx.db, companyId, userId))
      .filter((doc) => doc.scope.kind === "agent")
      .map((doc) => doc.scope.id);
    for (const agentId of new Set(agentIds)) scopes.push(agentScope(agentId));
    const result = await searchMemory(ctx.db, {
      companyId,
      scopes,
      query,
      topK: 10,
      embeddings: await resolveEmbeddings(ctx, companyId).catch(() => null),
    });
    return { body: result };
  }

  return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
}

interface RunEventPayload {
  runId?: string;
  agentId?: string;
  status?: string;
  issueId?: string | null;
  error?: string | null;
}

/** One deterministic line per finished run in the agent's own daily log. */
async function captureRun(ctx: PluginContext, companyId: string, payload: RunEventPayload): Promise<void> {
  if (!payload.agentId) return;
  const config = await readConfig(ctx, companyId);
  if (!config.captureAgentRuns) return;
  const issue = payload.issueId ? await ctx.issues.get(payload.issueId, companyId).catch(() => null) : null;
  const subject = issue ? `${issue.identifier ?? "issue"} "${issue.title}"` : "no task";
  const outcome = payload.status === "succeeded" ? "finished" : payload.status ?? "ended";
  const error = payload.error ? ` (${payload.error.slice(0, 160).replace(/\n+/g, " ")})` : "";
  const now = new Date();
  const path = dailyLogPath(now);
  await appendToDocument(ctx.db, {
    companyId,
    scope: agentScope(payload.agentId),
    path,
    text: `- ${now.toISOString().slice(11, 16)} run ${outcome} on ${subject}${error}`,
    actor: { kind: "system", id: "copilot-memory" },
    header: `# ${path.slice("memory/".length, -3)}`,
  });
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    activeContext = ctx;
    registerMemoryTools(ctx);

    ctx.jobs.register(REINDEX_JOB_KEY, async () => {
      const indexed = await reindexPending(ctx.db, (companyId) => resolveEmbeddings(ctx, companyId), {
        limit: 50,
        onEmbeddingError: (companyId, error) =>
          ctx.logger.warn("memory embeddings failed; indexed keyword-only", {
            companyId,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
      if (indexed > 0) ctx.logger.info("memory reindexed", { documents: indexed });
    });

    for (const eventName of ["agent.run.finished", "agent.run.failed"] as const) {
      ctx.events.on(eventName, async (event) => {
        await captureRun(ctx, event.companyId, event.payload as RunEventPayload).catch((error) =>
          ctx.logger.warn("memory run capture failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
  },

  async onContributeRunContext(params) {
    return { markdown: await buildRunContext(requireContext(), params) };
  },

  async onApiRequest(input) {
    return handleApiRequest(requireContext(), input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
