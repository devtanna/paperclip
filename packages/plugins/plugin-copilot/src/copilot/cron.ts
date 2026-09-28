/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week),
 * evaluated in an IANA timezone. Supports `*`, lists, ranges, and steps; when
 * both day fields are restricted, either may match (classic cron semantics).
 */

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(raw: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${field.name}: ${part}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = field.min;
      end = field.max;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-").map(Number);
      start = a!;
      end = b!;
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : field.max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < field.min || end > field.max || start > end) {
      throw new Error(`Invalid ${field.name}: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expression must have 5 fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const daysOfWeek = parseField(dow, FIELDS[4]);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseField(minute, FIELDS[0]),
    hours: parseField(hour, FIELDS[1]),
    daysOfMonth: parseField(dom, FIELDS[2]),
    months: parseField(month, FIELDS[3]),
    daysOfWeek,
    dayOfMonthRestricted: dom !== "*",
    dayOfWeekRestricted: dow !== "*",
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClock(date: Date, timezone: string): WallClock {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function dayMatches(spec: CronSpec, clock: WallClock): boolean {
  if (!spec.months.has(clock.month)) return false;
  const dom = spec.daysOfMonth.has(clock.day);
  const dow = spec.daysOfWeek.has(clock.weekday);
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return dom || dow;
  if (spec.dayOfMonthRestricted) return dom;
  if (spec.dayOfWeekRestricted) return dow;
  return true;
}

const MINUTE_MS = 60_000;

/**
 * First matching minute strictly after `after`. Skips whole days and hours
 * that cannot match, so a search spans at most a few thousand steps a year.
 */
export function nextCronRun(spec: CronSpec, after: Date, timezone: string): Date | null {
  let candidate = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = after.getTime() + 366 * 24 * 60 * MINUTE_MS;
  while (candidate.getTime() <= limit) {
    const clock = wallClock(candidate, timezone);
    if (!dayMatches(spec, clock)) {
      candidate = new Date(candidate.getTime() + ((23 - clock.hour) * 60 + (60 - clock.minute)) * MINUTE_MS);
      continue;
    }
    if (!spec.hours.has(clock.hour)) {
      candidate = new Date(candidate.getTime() + (60 - clock.minute) * MINUTE_MS);
      continue;
    }
    if (spec.minutes.has(clock.minute)) return candidate;
    candidate = new Date(candidate.getTime() + MINUTE_MS);
  }
  return null;
}

/** Smallest gap between the next few runs, for rejecting schedules that fire too often. */
export function minimumCronIntervalMinutes(spec: CronSpec, timezone: string, from = new Date()): number {
  let previous = nextCronRun(spec, from, timezone);
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8 && previous; i += 1) {
    const next = nextCronRun(spec, previous, timezone);
    if (!next) break;
    smallest = Math.min(smallest, (next.getTime() - previous.getTime()) / MINUTE_MS);
    previous = next;
  }
  return smallest;
}

/** Minutes after local midnight in `timezone`. */
export function localMinuteOfDay(date: Date, timezone: string): number {
  const clock = wallClock(date, timezone);
  return clock.hour * 60 + clock.minute;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: string): number | null {
  const match = HH_MM.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Start inclusive, end exclusive; end before start spans midnight; equal means always. */
export function isWithinWindow(now: Date, start: string, end: string, timezone: string): boolean {
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return true;
  const minute = localMinuteOfDay(now, isValidTimezone(timezone) ? timezone : "UTC");
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}
