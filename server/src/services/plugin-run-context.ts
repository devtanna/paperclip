import { asc, eq } from "drizzle-orm";
import { plugins, type Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { logger } from "../middleware/logger.js";

/** Capability a plugin declares to add markdown to agent run prompts. */
export const AGENT_CONTEXT_CONTRIBUTE_CAPABILITY = "agent.context.contribute";

/** Per-plugin RPC budget. Prompt assembly waits on this, so it stays short. */
export const PLUGIN_RUN_CONTEXT_TIMEOUT_MS = 1_500;
/** Total characters all plugins together may add to one run prompt. */
export const PLUGIN_RUN_CONTEXT_MAX_CHARS = 24_000;

export interface PluginRunContextInput {
  companyId: string;
  agentId: string;
  runId: string;
  wakeReason: string | null;
  invocationSource: string | null;
  issueId: string | null;
  conversationMode: boolean;
}

export interface PluginRunContextSource {
  pluginKey: string;
  chars: number;
  truncated: boolean;
  error?: string;
}

export interface PluginRunContextResult {
  markdown: string;
  sources: PluginRunContextSource[];
}

interface ContributingPlugin {
  id: string;
  pluginKey: string;
  displayName: string;
}

async function readyContributingPlugins(db: Db): Promise<ContributingPlugin[]> {
  const rows = await db
    .select({
      id: plugins.id,
      pluginKey: plugins.pluginKey,
      manifestJson: plugins.manifestJson,
    })
    .from(plugins)
    .where(eq(plugins.status, "ready"))
    .orderBy(asc(plugins.installOrder));
  return rows
    .filter((row) => row.manifestJson.capabilities.includes(AGENT_CONTEXT_CONTRIBUTE_CAPABILITY))
    .map((row) => ({
      id: row.id,
      pluginKey: row.pluginKey,
      displayName: row.manifestJson.displayName || row.pluginKey,
    }));
}

function truncateMarkdown(markdown: string, maxChars: number): { text: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, truncated: false };
  const marker = "\n\n…(truncated)";
  return { text: markdown.slice(0, Math.max(0, maxChars - marker.length)) + marker, truncated: true };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask every ready plugin declaring `agent.context.contribute` for markdown to
 * add to this run's prompt. Plugins run in parallel under a short timeout and
 * share one character budget. A failing plugin adds nothing and never fails
 * the run; its error is reported in `sources`.
 */
export async function collectPluginRunContext(
  db: Db,
  pluginWorkerManager: PluginWorkerManager | undefined,
  input: PluginRunContextInput,
  options: { timeoutMs?: number; maxChars?: number } = {},
): Promise<PluginRunContextResult> {
  if (!pluginWorkerManager) return { markdown: "", sources: [] };
  const contributors = (await readyContributingPlugins(db)).filter((plugin) =>
    pluginWorkerManager.isRunning(plugin.id),
  );
  if (contributors.length === 0) return { markdown: "", sources: [] };

  const timeoutMs = options.timeoutMs ?? PLUGIN_RUN_CONTEXT_TIMEOUT_MS;
  const maxChars = options.maxChars ?? PLUGIN_RUN_CONTEXT_MAX_CHARS;
  const perPluginChars = Math.floor(maxChars / contributors.length);

  const outcomes = await Promise.all(
    contributors.map(async (plugin) => {
      try {
        const result = await withTimeout(
          pluginWorkerManager.call(
            plugin.id,
            "contributeRunContext",
            { ...input, maxChars: perPluginChars },
            timeoutMs,
          ),
          timeoutMs,
        );
        const markdown = typeof result?.markdown === "string" ? result.markdown.trim() : "";
        const { text, truncated } = truncateMarkdown(markdown, perPluginChars);
        return { plugin, text, truncated };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          { pluginKey: plugin.pluginKey, runId: input.runId, err: message },
          "plugin run context contribution failed",
        );
        return { plugin, text: "", truncated: false, error: message };
      }
    }),
  );

  const sections: string[] = [];
  const sources: PluginRunContextSource[] = [];
  for (const outcome of outcomes) {
    sources.push({
      pluginKey: outcome.plugin.pluginKey,
      chars: outcome.text.length,
      truncated: outcome.truncated,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.text) sections.push(`## ${outcome.plugin.displayName}\n\n${outcome.text}`);
  }
  return { markdown: sections.join("\n\n"), sources };
}
