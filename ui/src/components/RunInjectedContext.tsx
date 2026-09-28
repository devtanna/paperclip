import type { HeartbeatRun } from "@paperclipai/shared";

interface ContextSource {
  pluginKey: string;
  chars: number;
  truncated?: boolean;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSources(value: unknown): ContextSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.pluginKey !== "string") return [];
    return [{
      pluginKey: record.pluginKey,
      chars: typeof record.chars === "number" ? record.chars : 0,
      truncated: record.truncated === true,
      error: typeof record.error === "string" ? record.error : undefined,
    }];
  });
}

/**
 * What plugins added to this run's prompt (e.g. recalled memory), and whether
 * the run was a memory flush before session compaction. Renders nothing for
 * ordinary runs.
 */
export function RunInjectedContext({ run }: { run: Pick<HeartbeatRun, "contextSnapshot"> }) {
  const context = asRecord(run.contextSnapshot);
  if (!context) return null;
  const sources = readSources(context.paperclipPluginContextSources);
  const markdown = typeof context.paperclipPluginContextMarkdown === "string" ? context.paperclipPluginContextMarkdown : "";
  const memoryFlush = typeof context.paperclipMemoryFlushNote === "string";
  if (sources.length === 0 && !memoryFlush) return null;

  return (
    <div className="border border-border rounded-lg px-4 py-3 space-y-2" data-testid="run-injected-context">
      {memoryFlush ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Memory flush run.</span> This session was about to be
          compacted, so the agent was asked to save durable memory first. The next run starts a fresh session.
        </p>
      ) : null}
      {sources.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium">
            Injected context · {sources.map((source) => `${source.pluginKey} ${source.chars.toLocaleString()} chars${source.truncated ? " (truncated)" : ""}${source.error ? " (failed)" : ""}`).join(" · ")}
          </summary>
          {sources.some((source) => source.error) ? (
            <ul className="mt-2 text-xs text-destructive">
              {sources.filter((source) => source.error).map((source) => (
                <li key={source.pluginKey}>{source.pluginKey}: {source.error}</li>
              ))}
            </ul>
          ) : null}
          {markdown ? (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
              {markdown}
            </pre>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
