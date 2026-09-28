/**
 * Builds the memory preamble added to every agent run (via the host's
 * `contributeRunContext` hook): curated long-term memory, the relevant user's
 * profile, today's and yesterday's daily logs, and the top recalled snippets
 * for what the run is about. Sections are dropped or truncated to fit.
 */

export interface ContextSection {
  title: string;
  body: string;
  /** Lower numbers survive truncation first. */
  priority: number;
}

const TRUNCATION_NOTE = "\n…(truncated; use memory_get for the full file)";

export const MEMORY_TOOLS_HINT =
  "Memory tools: `memory_search` to recall, `memory_get` to read a file, " +
  "`memory_note` to log something to today's daily notes, `memory_write` to curate MEMORY.md. " +
  "Write durable facts down; nothing survives a session unless it is in memory.";

/**
 * Fits sections into `maxChars`, highest priority first, then restores their
 * original order. A section that does not fully fit is truncated if at least
 * 200 characters remain, otherwise skipped.
 */
export function assembleContext(sections: ContextSection[], maxChars: number): string {
  const nonEmpty = sections
    .map((section, order) => ({ ...section, body: section.body.trim(), order }))
    .filter((section) => section.body.length > 0);
  if (nonEmpty.length === 0) return "";

  const header = MEMORY_TOOLS_HINT;
  let remaining = maxChars - header.length - 2;
  const kept: Array<{ order: number; text: string }> = [];
  for (const section of [...nonEmpty].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    const heading = `### ${section.title}\n\n`;
    const full = heading + section.body;
    if (full.length + 2 <= remaining) {
      kept.push({ order: section.order, text: full });
      remaining -= full.length + 2;
      continue;
    }
    const room = remaining - heading.length - TRUNCATION_NOTE.length - 2;
    if (room >= 200) {
      kept.push({ order: section.order, text: heading + section.body.slice(0, room) + TRUNCATION_NOTE });
      remaining = 0;
    }
  }
  if (kept.length === 0) return "";
  return [header, ...kept.sort((a, b) => a.order - b.order).map((entry) => entry.text)].join("\n\n");
}

/** Recall query for a run: the issue it is about, else its wake reason. */
export function recallQueryForRun(input: {
  issueTitle?: string | null;
  issueDescription?: string | null;
  wakeReason?: string | null;
}): string {
  const parts = [input.issueTitle, input.issueDescription?.slice(0, 300)]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join("\n");
  return (input.wakeReason ?? "").replace(/_/g, " ").trim();
}
