import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  commitmentsNeedingAttention,
  pendingSignals,
  type Commitment,
  type CopilotSettings,
  type Signal,
} from "./store.js";

/**
 * The company pulse: a deterministic snapshot of what needs attention, built
 * from plain queries (no LLM). The Copilot is only woken when the pulse has
 * items and differs from the last one it saw.
 */

export type PulseItemKind =
  | "stale_task"
  | "blocked_task"
  | "waiting_review"
  | "approval_pending"
  | "budget"
  | "commitment_due"
  | "signal";

export interface PulseItem {
  /** Stable identity; changes when the underlying state changes. */
  key: string;
  kind: PulseItemKind;
  text: string;
  urgent?: boolean;
}

export interface Pulse {
  items: PulseItem[];
  /** Totals before the per-section display caps. */
  counts: Record<PulseItemKind, number>;
  hash: string;
  markdown: string;
  signalIds: string[];
  commitmentIds: string[];
  /** Data sources that failed; the pulse is incomplete when this is non-empty. */
  errors: string[];
}

interface PulseIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date | string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  conversationAgentId?: string | null;
  hiddenAt?: Date | string | null;
}

interface PulseApproval {
  id: string;
  type?: string | null;
  status: string;
  createdAt: Date | string;
}

export interface PulseInput {
  now: Date;
  staleAfterHours: number;
  inProgress: PulseIssue[];
  blocked: PulseIssue[];
  inReview: PulseIssue[];
  approvals: PulseApproval[];
  budget: { monthlyCents: number; spentCents: number } | null;
  commitments: Commitment[];
  signals: Signal[];
  agentNames?: Record<string, string>;
}

const SECTION_LIMIT = 8;
const APPROVAL_WAIT_HOURS = 4;

const SECTION_TITLES: Record<PulseItemKind, string> = {
  signal: "New since last pulse",
  commitment_due: "Commitments due",
  blocked_task: "Blocked tasks",
  stale_task: "Stale tasks (no activity)",
  waiting_review: "Waiting for review",
  approval_pending: "Approvals waiting",
  budget: "Budget",
};

const SECTION_ORDER: PulseItemKind[] = [
  "signal",
  "commitment_due",
  "budget",
  "blocked_task",
  "approval_pending",
  "waiting_review",
  "stale_task",
];

function time(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function ageLabel(now: Date, value: Date | string): string {
  const hours = Math.max(0, (now.getTime() - time(value)) / 3_600_000);
  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours)}h`;
}

function isOrdinaryTask(issue: PulseIssue): boolean {
  return !issue.conversationAgentId && !issue.hiddenAt;
}

function describeTask(issue: PulseIssue, input: PulseInput): string {
  const ref = issue.identifier ?? issue.id.slice(0, 8);
  const owner = issue.assigneeAgentId
    ? `agent ${input.agentNames?.[issue.assigneeAgentId] ?? issue.assigneeAgentId.slice(0, 8)}`
    : issue.assigneeUserId
      ? `user ${issue.assigneeUserId}`
      : "unassigned";
  return `${ref} "${issue.title}" (${issue.priority}, ${owner}, idle ${ageLabel(input.now, issue.updatedAt)})`;
}

export function buildPulse(input: PulseInput): Pulse {
  const staleBefore = input.now.getTime() - input.staleAfterHours * 3_600_000;
  const byAge = (a: PulseIssue, b: PulseIssue) => time(a.updatedAt) - time(b.updatedAt);
  const all: PulseItem[] = [];

  for (const signal of input.signals) {
    all.push({ key: `signal:${signal.id}`, kind: "signal", text: signal.summary, urgent: signal.urgent });
  }
  for (const commitment of input.commitments) {
    const overdue = commitment.dueAt && time(commitment.dueAt) < input.now.getTime();
    const owner = commitment.ownerKind === "company" ? "company" : `${commitment.ownerKind} ${commitment.ownerId ?? "?"}`;
    all.push({
      key: `commitment:${commitment.id}:${commitment.dueAt}`,
      kind: "commitment_due",
      text: `[${commitment.id.slice(0, 8)}] ${owner}: ${commitment.text} (${overdue ? "overdue since" : "due"} ${commitment.dueAt})`,
      urgent: Boolean(overdue),
    });
  }
  if (input.budget && input.budget.monthlyCents > 0) {
    const ratio = input.budget.spentCents / input.budget.monthlyCents;
    if (ratio >= 0.8) {
      const bucket = ratio >= 1 ? 100 : ratio >= 0.9 ? 90 : 80;
      all.push({
        key: `budget:${bucket}`,
        kind: "budget",
        text: `Company spend is at ${Math.round(ratio * 100)}% of the monthly budget.`,
        urgent: bucket >= 90,
      });
    }
  }
  for (const issue of input.blocked.filter(isOrdinaryTask).sort(byAge)) {
    all.push({ key: `blocked:${issue.id}:${time(issue.updatedAt)}`, kind: "blocked_task", text: describeTask(issue, input) });
  }
  const approvalCutoff = input.now.getTime() - APPROVAL_WAIT_HOURS * 3_600_000;
  for (const approval of input.approvals) {
    if (approval.status !== "pending" || time(approval.createdAt) > approvalCutoff) continue;
    all.push({
      key: `approval:${approval.id}`,
      kind: "approval_pending",
      text: `${approval.type ?? "approval"} ${approval.id.slice(0, 8)} waiting ${ageLabel(input.now, approval.createdAt)}`,
    });
  }
  for (const issue of input.inReview.filter(isOrdinaryTask).sort(byAge)) {
    if (time(issue.updatedAt) > staleBefore) continue;
    all.push({ key: `review:${issue.id}:${time(issue.updatedAt)}`, kind: "waiting_review", text: describeTask(issue, input) });
  }
  for (const issue of input.inProgress.filter(isOrdinaryTask).sort(byAge)) {
    if (time(issue.updatedAt) > staleBefore) continue;
    all.push({ key: `stale:${issue.id}:${time(issue.updatedAt)}`, kind: "stale_task", text: describeTask(issue, input) });
  }

  const counts = Object.fromEntries(SECTION_ORDER.map((kind) => [kind, 0])) as Record<PulseItemKind, number>;
  for (const item of all) counts[item.kind] += 1;
  const items = SECTION_ORDER.flatMap((kind) => all.filter((item) => item.kind === kind).slice(0, SECTION_LIMIT));

  const hash = createHash("sha256")
    .update(items.map((item) => item.key).sort().join("\n"))
    .digest("hex");

  const sections = SECTION_ORDER.filter((kind) => counts[kind] > 0).map((kind) => {
    const shown = items.filter((item) => item.kind === kind);
    const more = counts[kind] - shown.length;
    const lines = shown.map((item) => `- ${item.urgent ? "**urgent** " : ""}${item.text}`);
    if (more > 0) lines.push(`- …and ${more} more`);
    return `### ${SECTION_TITLES[kind]} (${counts[kind]})\n\n${lines.join("\n")}`;
  });

  return {
    items,
    counts,
    hash,
    markdown: sections.join("\n\n"),
    signalIds: input.signals.map((signal) => signal.id),
    commitmentIds: input.commitments.map((commitment) => commitment.id),
    errors: [],
  };
}

/** Reads everything the pulse needs with a handful of bounded queries. */
export async function gatherPulse(ctx: PluginContext, settings: CopilotSettings, now: Date): Promise<Pulse> {
  const companyId = settings.companyId;
  const errors: string[] = [];
  // One failed source must not blank the whole pulse, but it must be visible.
  const safely = <T,>(label: string, promise: Promise<T>, fallback: T): Promise<T> =>
    promise.catch((error: unknown) => {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    });
  const listIssues = (status: "in_progress" | "blocked" | "in_review") =>
    safely(`${status} tasks`, ctx.issues.list({ companyId, status, limit: 200 }), []);
  const [inProgress, blocked, inReview, approvals, company, commitments, signals, agents] = await Promise.all([
    listIssues("in_progress"),
    listIssues("blocked"),
    listIssues("in_review"),
    safely("approvals", ctx.approvals.list({ companyId, status: "pending" }), []),
    safely("company budget", ctx.companies.get(companyId), null),
    commitmentsNeedingAttention(ctx.db, companyId, now),
    pendingSignals(ctx.db, companyId),
    safely("agents", ctx.agents.list({ companyId, limit: 200 }), []),
  ]);
  const budget = company as { budgetMonthlyCents?: number; spentMonthlyCents?: number } | null;
  const pulse = buildPulse({
    now,
    staleAfterHours: settings.staleAfterHours,
    inProgress: inProgress as unknown as PulseIssue[],
    blocked: blocked as unknown as PulseIssue[],
    inReview: inReview as unknown as PulseIssue[],
    approvals: approvals as unknown as PulseApproval[],
    budget: budget ? { monthlyCents: budget.budgetMonthlyCents ?? 0, spentCents: budget.spentMonthlyCents ?? 0 } : null,
    commitments,
    signals,
    agentNames: Object.fromEntries(agents.map((agent) => [agent.id, agent.name])),
  });
  return { ...pulse, errors };
}
