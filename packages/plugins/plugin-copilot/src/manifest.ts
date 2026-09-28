import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from "./memory/embeddings.js";

export const PLUGIN_ID = "paperclipai.plugin-copilot";
export const REINDEX_JOB_KEY = "memory-reindex";

const scopeParameter = {
  type: "string",
  enum: ["company", "agent"],
  description: "`company` is shared by every agent and teammate; `agent` is your own private memory.",
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Copilot Memory",
  description:
    "OpenClaw-style long-term memory for your company: MEMORY.md, per-person USER.md and daily logs, with hybrid keyword and vector search recalled into every agent run.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "issues.read",
    "agents.read",
    "agent.tools.register",
    "agent.context.contribute",
    "activity.log.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "copilot",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      embeddingsApiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Embeddings API key",
        description:
          "Secret holding an API key for an OpenAI-compatible embeddings endpoint. Without it, memory search is keyword-only.",
      },
      embeddingsBaseUrl: {
        type: "string",
        title: "Embeddings base URL",
        default: DEFAULT_EMBEDDINGS_BASE_URL,
        description: "OpenAI-compatible API base; `/embeddings` is appended.",
      },
      embeddingsModel: {
        type: "string",
        title: "Embeddings model",
        default: DEFAULT_EMBEDDINGS_MODEL,
      },
      captureAgentRuns: {
        type: "boolean",
        title: "Log agent runs to daily notes",
        default: true,
        description: "Append one line per finished agent run to that agent's daily log.",
      },
    },
  },
  jobs: [
    {
      jobKey: REINDEX_JOB_KEY,
      displayName: "Reindex memory",
      description: "Chunks and embeds memory documents that changed since they were last indexed.",
      schedule: "* * * * *",
    },
  ],
  tools: [
    {
      name: "memory_search",
      displayName: "Search Memory",
      description:
        "Search long-term memory (company and your own): past decisions, people, preferences, commitments, and context that is not in the current task. Hybrid semantic + keyword, recent notes weighted higher.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to remember, in natural language." },
          topK: { type: "number", description: "Results to return (1-20, default 6)." },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_get",
      displayName: "Read Memory File",
      description:
        "Read a memory file, e.g. MEMORY.md or memory/2026-09-28.md, optionally a line range from a search hit.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          scope: scopeParameter,
          fromLine: { type: "number" },
          lines: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "memory_note",
      displayName: "Note To Daily Log",
      description:
        "Append a timestamped line to today's daily log (memory/YYYY-MM-DD.md). Use for events, observations, and anything worth remembering later. Defaults to your own log; use scope `company` for things the whole team should see.",
      parametersSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          scope: scopeParameter,
        },
        required: ["text"],
      },
    },
    {
      name: "memory_write",
      displayName: "Write Memory File",
      description:
        "Replace a whole memory file. Use to curate MEMORY.md: durable facts, decisions, and preferences, kept short and current. Read it first with memory_get; the previous version is kept.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          scope: scopeParameter,
          reason: { type: "string", description: "Why this changed, for the revision history." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "memory_forget",
      displayName: "Forget Memory Lines",
      description:
        "Remove lines containing `match` from a memory file, e.g. a fact that is no longer true. The previous version is kept as a revision.",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          match: { type: "string" },
          scope: scopeParameter,
          reason: { type: "string" },
        },
        required: ["path", "match"],
      },
    },
    {
      name: "memory_list",
      displayName: "List Memory Files",
      description: "List the company and personal memory files you can read.",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
  apiRoutes: [
    {
      routeKey: "status",
      method: "GET",
      path: "/status",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "documents",
      method: "GET",
      path: "/documents",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "document",
      method: "GET",
      path: "/document",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "write-document",
      method: "POST",
      path: "/document",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "search",
      method: "GET",
      path: "/search",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "memory-sidebar",
        displayName: "Memory",
        exportName: "MemorySidebarLink",
        order: 36,
      },
      {
        type: "page",
        id: "memory-page",
        displayName: "Memory",
        exportName: "MemoryPage",
        routePath: "memory",
      },
    ],
  },
};

export default manifest;
