import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { addSignal, getSettings } from "./store.js";

/**
 * Turns Paperclip events into pulse signals for companies whose Copilot is on.
 * The Copilot's own actions and plugin-originated events are ignored so it can
 * never wake itself in a loop.
 */

export const SIGNAL_EVENT_TYPES = [
  "agent.run.failed",
  "issue.comment.created",
  "approval.created",
] as const;

interface RunFailedPayload {
  agentId?: string;
  issueId?: string | null;
  error?: string | null;
}

interface CommentPayload {
  issueId?: string;
  identifier?: string | null;
  issueTitle?: string | null;
  bodySnippet?: string | null;
}

interface ApprovalPayload {
  type?: string | null;
}

export async function recordSignalFromEvent(ctx: PluginContext, event: PluginEvent): Promise<boolean> {
  const settings = await getSettings(ctx.db, event.companyId);
  if (!settings.enabled) return false;
  if (event.actorType === "plugin") return false;
  if (settings.agentId && event.actorId === settings.agentId) return false;

  if (event.eventType === "agent.run.failed") {
    const payload = (event.payload ?? {}) as RunFailedPayload;
    if (!payload.agentId || payload.agentId === settings.agentId) return false;
    const [agent, issue] = await Promise.all([
      ctx.agents.get(payload.agentId, event.companyId).catch(() => null),
      payload.issueId ? ctx.issues.get(payload.issueId, event.companyId).catch(() => null) : Promise.resolve(null),
    ]);
    const where = issue ? ` on ${issue.identifier ?? "task"} "${issue.title}"` : "";
    await addSignal(ctx.db, {
      companyId: event.companyId,
      kind: "run_failed",
      urgent: issue ? ["critical", "high"].includes(issue.priority) : false,
      entityType: "heartbeat_run",
      entityId: event.entityId ?? null,
      summary: `Run failed for ${agent?.name ?? "an agent"}${where}: ${(payload.error ?? "no error message").slice(0, 200)}`,
    });
    return true;
  }

  if (event.eventType === "issue.comment.created") {
    // Only people's comments; agents' comments are part of normal work.
    if (event.actorType !== "user") return false;
    const payload = (event.payload ?? {}) as CommentPayload;
    // Comment events carry the issue as the event entity.
    const issueId = payload.issueId ?? (event.entityType === "issue" ? event.entityId ?? null : null);
    const issue = issueId ? await ctx.issues.get(issueId, event.companyId).catch(() => null) : null;
    // Chats with the Copilot already wake it directly.
    if (issue?.conversationAgentId && issue.conversationAgentId === settings.agentId) return false;
    const ref = issue ? `${issue.identifier ?? "task"} "${issue.title}"` : payload.identifier ?? "a task";
    await addSignal(ctx.db, {
      companyId: event.companyId,
      kind: "human_comment",
      entityType: "issue",
      entityId: issueId,
      summary: `New comment from a person on ${ref}: ${(payload.bodySnippet ?? "").replace(/\s+/g, " ").slice(0, 160)}`,
    });
    return true;
  }

  if (event.eventType === "approval.created") {
    const payload = (event.payload ?? {}) as ApprovalPayload;
    await addSignal(ctx.db, {
      companyId: event.companyId,
      kind: "approval_created",
      entityType: "approval",
      entityId: event.entityId ?? null,
      summary: `New approval requested: ${payload.type ?? "approval"}`,
    });
    return true;
  }
  return false;
}
