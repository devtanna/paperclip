/**
 * Memory document addressing. A document is identified by (company, scope,
 * path) where path mirrors an OpenClaw workspace: `MEMORY.md`, `USER.md`,
 * `DREAMS.md`, and dated daily logs under `memory/YYYY-MM-DD.md`.
 */

export const MEMORY_SCOPE_KINDS = ["company", "user", "agent"] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

export interface MemoryScope {
  kind: MemoryScopeKind;
  id: string;
}

export const LONG_TERM_MEMORY_PATH = "MEMORY.md";
export const USER_PROFILE_PATH = "USER.md";
export const DREAMS_PATH = "DREAMS.md";

/** Largest document body accepted from tools or the UI. */
export const MAX_DOCUMENT_CHARS = 64_000;

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATED_NOTE = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9-]+)?\.md$/;

export function isMemoryScopeKind(value: unknown): value is MemoryScopeKind {
  return typeof value === "string" && (MEMORY_SCOPE_KINDS as readonly string[]).includes(value);
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.kind}:${scope.id}`;
}

/**
 * Normalizes a relative markdown path and rejects anything that could escape
 * the scope or is not a markdown file.
 */
export function normalizeMemoryPath(raw: string): string {
  const path = raw.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.length > 200) throw new Error("Memory path must be 1-200 characters");
  if (!path.endsWith(".md")) throw new Error("Memory path must be a markdown (.md) file");
  const segments = path.split("/");
  if (segments.length > 4) throw new Error("Memory path may be at most 4 levels deep");
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new Error(`Invalid memory path segment: ${segment || "(empty)"}`);
    }
  }
  return path;
}

/** The date of a dated note (`memory/2026-09-28.md`, `2026-09-28-standup.md`), else null. */
export function noteDateFromPath(path: string): string | null {
  const match = DATED_NOTE.exec(path);
  if (!match) return null;
  const date = match[1]!;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dailyLogPath(date: Date): string {
  return `memory/${isoDate(date)}.md`;
}

export function yesterday(date: Date): Date {
  return new Date(date.getTime() - 24 * 60 * 60 * 1000);
}
