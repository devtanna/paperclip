import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from "./memory/embeddings.js";
import { copilotInstructionFiles } from "./templates.js";

export const PLUGIN_ID = "paperclipai.plugin-copilot";
export const REINDEX_JOB_KEY = "memory-reindex";
export const COPILOT_TICK_JOB_KEY = "copilot-tick";

const scopeParameter = {
  type: "string",
  enum: ["company", "agent", "user"],
  description:
    "`company` is shared by every agent and teammate; `agent` is your own private memory; `user` (Copilot only, with userId) is one person's private memory.",
};
const userIdParameter = { type: "string", description: "Person's user id, for scope `user` (Copilot only)." };

const instructionFiles = copilotInstructionFiles();

const scheduleTimingProperties = {
  at: { type: "string", description: "One-time run, ISO date-time with offset." },
  everyMinutes: { type: "number", description: "Fixed interval in minutes (5 or more)." },
  cron: { type: "string", description: "5-field cron, e.g. `30 8 * * 1-5` (at most every 5 minutes)." },
  timezone: { type: "string", description: "IANA timezone for cron, default the Copilot's timezone." },
};

const boardRoute = (routeKey: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string) => ({
  routeKey,
  method,
  path,
  auth: "board" as const,
  capability: "api.routes.register" as const,
  companyResolution: method === "GET" || method === "DELETE"
    ? { from: "query" as const, key: "companyId" }
    : { from: "body" as const, key: "companyId" },
});

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Copilot Memory",
  description:
    "An always-on company Copilot with OpenClaw-style memory: MEMORY.md, per-person USER.md and daily logs recalled into every agent run, a proactive company pulse, commitments, schedules, and nightly consolidation.",
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
    "issues.create",
    "issue.comments.read",
    "issue.comments.create",
    "approvals.read",
    "agents.read",
    "agents.managed",
    "agents.invoke",
    "agents.pause",
    "agents.resume",
    "access.members.read",
    "agent.tools.register",
    "agent.context.contribute",
    "activity.log.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
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
  agents: [
    {
      agentKey: "copilot",
      displayName: "Copilot",
      role: "general",
      title: "Company Copilot",
      icon: "brain",
      capabilities:
        "Watches the whole company, remembers what matters, follows up on stuck work and commitments, and briefs the team.",
      adapterType: "opencode_local",
      adapterPreference: ["opencode_local", "claude_local", "codex_local", "gemini_local", "hermes_local", "pi_local"],
      adapterConfig: {},
      runtimeConfig: {
        // The plugin's pulse wakes the Copilot only when something changed, so
        // the blind interval heartbeat stays off.
        heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1, memoryFlush: true },
      },
      permissions: { canCreateAgents: false },
      status: "paused",
      budgetMonthlyCents: 3000,
      instructions: {
        entryFile: "AGENTS.md",
        content: instructionFiles["AGENTS.md"],
        files: instructionFiles,
        assetPath: "agents/copilot",
      },
    },
  ],
  jobs: [
    {
      jobKey: COPILOT_TICK_JOB_KEY,
      displayName: "Copilot tick",
      description:
        "Fires due schedules, checks the company pulse (plain queries; wakes the Copilot only when something changed), and prunes old history daily.",
      schedule: "* * * * *",
    },
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
          userId: userIdParameter,
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
          userId: userIdParameter,
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
          userId: userIdParameter,
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
          userId: userIdParameter,
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
    {
      name: "company_pulse",
      displayName: "Company Pulse",
      description: "Show what needs attention across the company right now: stale, blocked, and waiting tasks, approvals, budget, due commitments, and recent events.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "team_members",
      displayName: "Team Members",
      description: "List the people in the company (user ids and roles).",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "copilot_notify",
      displayName: "Message A Person",
      description:
        "Copilot only. Send a message to a person's Agent Chat with you (it also reaches their inbox). Use sparingly: each person has a daily cap.",
      parametersSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "The person's user id, or `all` for every active member." },
          message: { type: "string" },
          urgency: { type: "string", enum: ["normal", "urgent"] },
        },
        required: ["userId", "message"],
      },
    },
    {
      name: "commitment_create",
      displayName: "Record Commitment",
      description: "Record a promise with an optional due date so it gets followed up (e.g. \"Sam will send the deck by Friday\").",
      parametersSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          dueAt: { type: "string", description: "ISO date-time." },
          ownerUserId: { type: "string" },
          ownerAgentId: { type: "string" },
          issueId: { type: "string", description: "Related task, if any." },
        },
        required: ["text"],
      },
    },
    {
      name: "commitment_list",
      displayName: "List Commitments",
      description: "List commitments (default: open).",
      parametersSchema: {
        type: "object",
        properties: { status: { type: "string", enum: ["open", "done", "cancelled", "all"] } },
      },
    },
    {
      name: "commitment_complete",
      displayName: "Complete Commitment",
      description: "Mark a commitment done (or cancelled).",
      parametersSchema: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string", enum: ["done", "cancelled"] } },
        required: ["id"],
      },
    },
    {
      name: "schedule_create",
      displayName: "Create Schedule",
      description:
        "Wake yourself (or another agent) later with a message: once (`at`), on an interval (`everyMinutes`), or on a `cron`. For work that should create a task every time, create a Paperclip routine instead.",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          message: { type: "string", description: "What to do when it fires." },
          ...scheduleTimingProperties,
          targetAgentId: { type: "string", description: "Agent to wake; defaults to you." },
        },
        required: ["name", "message"],
      },
    },
    {
      name: "schedule_list",
      displayName: "List Schedules",
      description: "List schedules in this company.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "schedule_update",
      displayName: "Update Schedule",
      description: "Change a schedule's timing, message, or enabled state.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          message: { type: "string" },
          ...scheduleTimingProperties,
          enabled: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    {
      name: "schedule_delete",
      displayName: "Delete Schedule",
      description: "Delete a schedule you created (built-in ones can only be disabled).",
      parametersSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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
    boardRoute("revisions", "GET", "/revisions"),
    boardRoute("restore-revision", "POST", "/revisions/restore"),
    boardRoute("copilot", "GET", "/copilot"),
    boardRoute("copilot-enable", "POST", "/copilot/enable"),
    boardRoute("copilot-disable", "POST", "/copilot/disable"),
    boardRoute("copilot-settings", "PATCH", "/copilot/settings"),
    boardRoute("copilot-pulse", "GET", "/copilot/pulse"),
    boardRoute("copilot-check-in", "POST", "/copilot/check-in"),
    boardRoute("schedules", "GET", "/schedules"),
    boardRoute("create-schedule", "POST", "/schedules"),
    boardRoute("update-schedule", "PATCH", "/schedules/:id"),
    boardRoute("delete-schedule", "DELETE", "/schedules/:id"),
    boardRoute("run-schedule", "POST", "/schedules/:id/run"),
    boardRoute("commitments", "GET", "/commitments"),
    boardRoute("update-commitment", "PATCH", "/commitments/:id"),
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
      {
        type: "sidebar",
        id: "copilot-sidebar",
        displayName: "Copilot",
        exportName: "CopilotSidebarLink",
        order: 35,
      },
      {
        type: "page",
        id: "copilot-page",
        displayName: "Copilot",
        exportName: "CopilotPage",
        routePath: "copilot",
      },
      {
        type: "dashboardWidget",
        id: "copilot-widget",
        displayName: "Copilot",
        exportName: "CopilotWidget",
      },
    ],
  },
};

export default manifest;
