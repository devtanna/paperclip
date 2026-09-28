/**
 * Daily window in which timer heartbeats may fire, read from
 * `runtimeConfig.heartbeat.activeHours`. Outside the window the scheduler skips
 * the timer wake; the agent becomes due again as soon as the window opens.
 * Event-driven wakes (assignments, mentions, on-demand) are never gated.
 */
export interface HeartbeatActiveHours {
  /** Minutes after local midnight, 0-1439. */
  startMinute: number;
  /** Minutes after local midnight, 0-1439. Before `startMinute` spans midnight. */
  endMinute: number;
  timezone: string;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = HH_MM.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns null (no restriction) for a missing or malformed window, and for
 * equal start and end, so a misconfiguration never silences an agent forever.
 */
export function parseHeartbeatActiveHours(value: unknown): HeartbeatActiveHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const startMinute = parseClock(raw.start);
  const endMinute = parseClock(raw.end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
  const timezone = typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : "UTC";
  if (!isValidTimezone(timezone)) return null;
  return { startMinute, endMinute, timezone };
}

function localMinuteOfDay(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** Start is inclusive, end exclusive; a window with end before start spans midnight. */
export function isWithinHeartbeatActiveHours(window: HeartbeatActiveHours, now: Date): boolean {
  const minute = localMinuteOfDay(now, window.timezone);
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute < window.endMinute;
  }
  return minute >= window.startMinute || minute < window.endMinute;
}
