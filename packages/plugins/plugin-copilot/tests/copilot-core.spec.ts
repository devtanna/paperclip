import { describe, expect, it } from "vitest";
import { isWithinWindow, minimumCronIntervalMinutes, nextCronRun, parseCron } from "../src/copilot/cron.js";
import { buildPulse, type PulseInput } from "../src/copilot/pulse.js";
import { followingRun, isMissed, normalizeSchedule } from "../src/copilot/schedules.js";
import type { Schedule } from "../src/copilot/store.js";

describe("cron", () => {
  it("finds the next weekday 08:30 in a timezone", () => {
    const spec = parseCron("30 8 * * 1-5");
    // Saturday 2026-10-03 10:00 in Dubai (UTC+4) -> Monday 08:30 Dubai = 04:30 UTC.
    const next = nextCronRun(spec, new Date("2026-10-03T06:00:00Z"), "Asia/Dubai");
    expect(next?.toISOString()).toBe("2026-10-05T04:30:00.000Z");
  });

  it("supports steps, lists, and Sunday as 0 or 7", () => {
    const spec = parseCron("*/15 9,17 * * 7");
    expect(spec.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(spec.daysOfWeek).toEqual(new Set([0]));
  });

  it("matches either day field when both are restricted", () => {
    const spec = parseCron("0 9 1 * 1");
    // 2026-10-01 is a Thursday (day 1) and 2026-10-05 a Monday.
    const first = nextCronRun(spec, new Date("2026-09-30T12:00:00Z"), "UTC");
    const second = nextCronRun(spec, first!, "UTC");
    expect(first?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(second?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/minute/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });

  it("measures the tightest gap so every-minute crons can be refused", () => {
    expect(minimumCronIntervalMinutes(parseCron("* * * * *"), "UTC")).toBe(1);
    expect(minimumCronIntervalMinutes(parseCron("*/10 * * * *"), "UTC")).toBe(10);
  });

  it("evaluates active-hour windows, including overnight ones", () => {
    expect(isWithinWindow(new Date("2026-09-28T09:00:00Z"), "08:00", "22:00", "UTC")).toBe(true);
    expect(isWithinWindow(new Date("2026-09-28T23:00:00Z"), "08:00", "22:00", "UTC")).toBe(false);
    expect(isWithinWindow(new Date("2026-09-28T23:00:00Z"), "22:00", "06:00", "UTC")).toBe(true);
    expect(isWithinWindow(new Date("2026-09-28T23:00:00Z"), "09:00", "09:00", "UTC")).toBe(true);
  });
});

describe("schedules", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const base = { now, defaultTimezone: "UTC", defaultTargetAgentId: "agent-1" };

  it("creates one-shot, interval, and cron schedules", () => {
    const at = normalizeSchedule({ name: "Ping", message: "check deploy", at: "2026-09-28T15:00:00Z" }, base);
    expect(at).toMatchObject({ kind: "at", deleteAfterRun: true, targetAgentId: "agent-1" });
    expect(at.nextRunAt?.toISOString()).toBe("2026-09-28T15:00:00.000Z");

    const every = normalizeSchedule({ name: "Poll", message: "x", everyMinutes: 30 }, base);
    expect(every.nextRunAt?.toISOString()).toBe("2026-09-28T12:30:00.000Z");

    const cron = normalizeSchedule({ name: "Brief", message: "x", cron: "0 9 * * *", timezone: "Europe/Berlin" }, base);
    expect(cron.nextRunAt?.toISOString()).toBe("2026-09-29T07:00:00.000Z");
  });

  it("refuses schedules that would run too often or make no sense", () => {
    expect(() => normalizeSchedule({ name: "x", message: "x", everyMinutes: 1 }, base)).toThrow(/everyMinutes/);
    expect(() => normalizeSchedule({ name: "x", message: "x", cron: "* * * * *" }, base)).toThrow(/every 5 minutes/);
    expect(() => normalizeSchedule({ name: "x", message: "x", at: "2026-09-27T00:00:00Z" }, base)).toThrow(/future/);
    expect(() => normalizeSchedule({ name: "x", message: "x", at: "2026-09-29T00:00:00Z", cron: "0 9 * * *" }, base)).toThrow(/only one/);
    expect(() => normalizeSchedule({ name: "x", message: "x", cron: "0 9 * * *", timezone: "Mars/Base" }, base)).toThrow(/timezone/);
    expect(() => normalizeSchedule({ name: "", message: "x", everyMinutes: 10 }, base)).toThrow(/name/);
  });

  function schedule(overrides: Partial<Schedule>): Schedule {
    return {
      id: "s1",
      companyId: "c1",
      name: "s",
      kind: "every",
      runAt: null,
      everyMinutes: 30,
      cronExpr: null,
      timezone: "UTC",
      message: "m",
      targetAgentId: "agent-1",
      systemKey: null,
      enabled: true,
      deleteAfterRun: false,
      nextRunAt: "2026-09-28T12:00:00.000Z",
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      runCount: 0,
      createdByKind: "agent",
      createdById: "agent-1",
      ...overrides,
    };
  }

  it("advances intervals from the planned time and never into the past", () => {
    expect(followingRun(schedule({}), now)?.toISOString()).toBe("2026-09-28T12:30:00.000Z");
    const late = new Date("2026-09-28T14:05:00Z");
    expect(followingRun(schedule({}), late)?.toISOString()).toBe("2026-09-28T14:35:00.000Z");
    expect(followingRun(schedule({ kind: "at", everyMinutes: null }), now)).toBeNull();
  });

  it("treats runs more than two hours late as missed", () => {
    expect(isMissed(schedule({}), new Date("2026-09-28T13:00:00Z"))).toBe(false);
    expect(isMissed(schedule({}), new Date("2026-09-28T14:30:00Z"))).toBe(true);
  });
});

describe("pulse", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const issue = (id: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    identifier: `PAP-${id}`,
    title: `Task ${id}`,
    status,
    priority: "medium",
    updatedAt,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    ...extra,
  });
  const base: PulseInput = {
    now,
    staleAfterHours: 24,
    inProgress: [],
    blocked: [],
    inReview: [],
    approvals: [],
    budget: null,
    commitments: [],
    signals: [],
    agentNames: { "agent-1": "Eng" },
  };

  it("is quiet when nothing needs attention", () => {
    const pulse = buildPulse({ ...base, inProgress: [issue("1", "in_progress", "2026-09-28T10:00:00Z")] });
    expect(pulse.items).toHaveLength(0);
    expect(pulse.markdown).toBe("");
  });

  it("lists stale, blocked, waiting, approvals, budget, commitments, and signals", () => {
    const pulse = buildPulse({
      ...base,
      inProgress: [issue("1", "in_progress", "2026-09-26T10:00:00Z")],
      blocked: [issue("2", "blocked", "2026-09-28T11:00:00Z")],
      inReview: [issue("3", "in_review", "2026-09-25T00:00:00Z"), issue("4", "in_review", "2026-09-25T00:00:00Z", { conversationAgentId: "copilot" })],
      approvals: [{ id: "a1", type: "hire_agent", status: "pending", createdAt: "2026-09-28T01:00:00Z" }],
      budget: { monthlyCents: 10_000, spentCents: 9_100 },
      commitments: [
        {
          id: "c1",
          ownerKind: "user",
          ownerId: "sam",
          text: "Send the deck",
          dueAt: "2026-09-28T09:00:00.000Z",
          sourceIssueId: null,
          status: "open",
          createdByKind: "agent",
          createdById: "copilot",
          lastRemindedAt: null,
          createdAt: "2026-09-20T00:00:00.000Z",
        },
      ],
      signals: [{ id: "sig1", kind: "run_failed", urgent: true, entityType: null, entityId: null, summary: "Run failed for Eng", createdAt: "" }],
    });
    expect(pulse.counts).toMatchObject({
      stale_task: 1,
      blocked_task: 1,
      waiting_review: 1,
      approval_pending: 1,
      budget: 1,
      commitment_due: 1,
      signal: 1,
    });
    expect(pulse.markdown).toContain("PAP-1");
    expect(pulse.markdown).toContain("agent Eng");
    expect(pulse.markdown).toContain("91% of the monthly budget");
    expect(pulse.markdown).toContain("overdue since");
    expect(pulse.markdown).not.toContain("PAP-4");
    expect(pulse.signalIds).toEqual(["sig1"]);
  });

  it("keeps the same hash when nothing changed and a new one when a task moves", () => {
    const input = { ...base, blocked: [issue("2", "blocked", "2026-09-28T11:00:00Z")] };
    const first = buildPulse(input);
    expect(buildPulse(input).hash).toBe(first.hash);
    const moved = buildPulse({ ...base, blocked: [issue("2", "blocked", "2026-09-28T11:30:00Z")] });
    expect(moved.hash).not.toBe(first.hash);
  });

  it("caps each section and reports the remainder", () => {
    const blocked = Array.from({ length: 12 }, (_, i) => issue(String(i), "blocked", "2026-09-28T11:00:00Z"));
    const pulse = buildPulse({ ...base, blocked });
    expect(pulse.items).toHaveLength(8);
    expect(pulse.counts.blocked_task).toBe(12);
    expect(pulse.markdown).toContain("…and 4 more");
  });
});
