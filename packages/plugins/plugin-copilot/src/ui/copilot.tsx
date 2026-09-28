import {
  MarkdownBlock,
  Spinner,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isValidTimezone, nextCronRun, parseCron } from "../copilot/cron.js";
import {
  api,
  Button,
  cardStyle,
  ErrorLine,
  errorText,
  fontStack,
  formatTime,
  inputStyle,
  tokens,
  useIsNarrow,
} from "./shared.js";
import { allowCopilotTools, allowMemoryToolsForAllAgents, ensurePluginConfigured, listCopilotPolicies } from "./tool-access.js";

interface Settings {
  enabled: boolean;
  agentId: string | null;
  pulseIntervalMinutes: number;
  activeStart: string;
  activeEnd: string;
  timezone: string;
  maxWakesPerHour: number;
  maxNotificationsPerUserPerDay: number;
  staleAfterHours: number;
  lastPulseAt: string | null;
}

interface Overview {
  settings: Settings;
  agent: { id: string; name: string; status: string; adapterType: string; urlKey: string | null } | null;
  wakes: Array<{ id: string; reason: string; summary: string; itemCount: number; runId: string | null; error: string | null; createdAt: string }>;
  notifications: Array<{ id: string; userId: string; issueId: string | null; urgency: string; excerpt: string; createdAt: string }>;
  scheduleRuns: Array<{ id: string; scheduleName: string; firedAt: string; status: string; runId: string | null; error: string | null }>;
  nextSchedule: Schedule | null;
  openCommitments: number;
  problem: { at: string; message: string } | null;
}

interface Schedule {
  id: string;
  name: string;
  kind: "at" | "every" | "cron";
  runAt: string | null;
  everyMinutes: number | null;
  cronExpr: string | null;
  timezone: string;
  message: string;
  systemKey: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdByKind: string | null;
}

interface Commitment {
  id: string;
  ownerKind: string;
  ownerId: string | null;
  text: string;
  dueAt: string | null;
  status: string;
}

function useOverview(companyId: string | null) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!companyId) return;
    try {
      setOverview(await api<Overview>(`/copilot?companyId=${companyId}`));
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [companyId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { overview, error, refresh };
}

function statusLabel(overview: Overview | null): { text: string; tone: string } {
  if (!overview) return { text: "loading", tone: tokens.muted };
  if (!overview.settings.agentId) return { text: "not set up", tone: tokens.muted };
  if (!overview.settings.enabled) return { text: "off", tone: tokens.muted };
  if (overview.agent?.status === "paused") return { text: "paused", tone: tokens.destructive };
  if (overview.agent?.status === "running") return { text: "working", tone: tokens.fg };
  return { text: "on", tone: tokens.fg };
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: color }} />;
}

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8Z" />
    </svg>
  );
}

export function CopilotSidebarLink(_props: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  return (
    <a
      {...hostNavigation.linkProps("/copilot")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
      style={{ textDecoration: "none" }}
    >
      <span className="shrink-0">
        <SparkIcon />
      </span>
      <span className="flex-1 truncate">Copilot</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

export function CopilotWidget({ context }: PluginWidgetProps) {
  const { overview, error } = useOverview(context.companyId);
  const hostNavigation = useHostNavigation();
  const status = statusLabel(overview);
  return (
    <div style={{ fontFamily: fontStack, color: tokens.fg, fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Dot color={status.tone} />
        <strong>Copilot</strong>
        <span style={{ color: tokens.muted }}>{status.text}</span>
      </div>
      <ErrorLine message={error} />
      {overview ? (
        <div style={{ display: "grid", gap: 4, color: tokens.muted }}>
          <span>{overview.openCommitments} open commitment{overview.openCommitments === 1 ? "" : "s"}</span>
          <span>Next: {overview.nextSchedule ? `${overview.nextSchedule.name} · ${formatTime(overview.nextSchedule.nextRunAt)}` : "nothing scheduled"}</span>
          <span>Last check-in: {overview.wakes[0] ? `${formatTime(overview.wakes[0].createdAt)} · ${overview.wakes[0].summary}` : "none yet"}</span>
        </div>
      ) : null}
      <a {...hostNavigation.linkProps("/copilot")} style={{ display: "inline-block", marginTop: 8, color: tokens.fg }}>
        Open Copilot
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = "activity" | "schedules" | "commitments" | "pulse" | "settings";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "activity", label: "Activity" },
  { key: "schedules", label: "Schedules" },
  { key: "commitments", label: "Commitments" },
  { key: "pulse", label: "Pulse" },
  { key: "settings", label: "Settings" },
];

export function CopilotPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const narrow = useIsNarrow();
  const { overview, error, refresh } = useOverview(companyId);
  const [tab, setTab] = useState<Tab>("activity");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!companyId) {
    return <main style={{ padding: 24, color: tokens.muted, fontFamily: fontStack }}>Select a company.</main>;
  }

  const turnOn = () =>
    run(async () => {
      await ensurePluginConfigured(companyId);
      const result = await api<{ agentId: string | null; needsApproval: boolean }>("/copilot/enable", {
        method: "POST",
        body: JSON.stringify({ companyId }),
      });
      if (result.needsApproval) return "The Copilot agent is waiting for board approval. Approve it, then turn the Copilot on again.";
      if (result.agentId) await allowCopilotTools(companyId, result.agentId);
      return "The Copilot is on.";
    });
  const turnOff = () =>
    run(async () => {
      await api("/copilot/disable", { method: "POST", body: JSON.stringify({ companyId }) });
      return "The Copilot is off: no pulse, no schedules, and its agent is paused.";
    });
  const checkIn = () =>
    run(async () => {
      const result = await api<{ outcome: string }>("/copilot/check-in", { method: "POST", body: JSON.stringify({ companyId }) });
      return result.outcome === "woke" ? "The Copilot is checking in now." : `The Copilot could not check in (${result.outcome.replace(/_/g, " ")}).`;
    });

  const status = statusLabel(overview);
  const enabled = overview?.settings.enabled === true;

  return (
    <main style={{ padding: narrow ? 16 : 24, fontFamily: fontStack, color: tokens.fg, minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            Copilot <Dot color={status.tone} /> <span style={{ fontSize: 13, fontWeight: 400, color: tokens.muted }}>{status.text}</span>
          </h1>
          <div style={{ fontSize: 13, color: tokens.muted, marginTop: 4 }}>
            Watches the company, follows up on stuck work and commitments, and briefs the team.
            {overview?.settings.lastPulseAt ? ` Last pulse ${formatTime(overview.settings.lastPulseAt)}.` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {enabled ? (
            <>
              <Button onClick={checkIn} disabled={busy}>Check in now</Button>
              <Button danger onClick={turnOff} disabled={busy} title="Stops the pulse and all schedules, and pauses the Copilot agent">
                Turn off
              </Button>
            </>
          ) : (
            <Button primary onClick={turnOn} disabled={busy || !overview}>
              {overview?.settings.agentId ? "Turn on" : "Set up Copilot"}
            </Button>
          )}
        </div>
      </header>
      <ErrorLine message={error ?? actionError} />
      {overview?.problem ? (
        <p role="alert" style={{ color: tokens.destructive, fontSize: 13, margin: "8px 0" }}>
          {formatTime(overview.problem.at)}: {overview.problem.message}
        </p>
      ) : null}
      {notice ? <p style={{ fontSize: 13, color: tokens.muted, margin: "8px 0" }}>{notice}</p> : null}

      {!overview ? (
        <Spinner />
      ) : !overview.settings.agentId ? (
        <SetupExplainer />
      ) : (
        <>
          <nav role="tablist" style={{ display: "flex", gap: 4, borderBottom: `1px solid ${tokens.border}`, marginBottom: 16, overflowX: "auto" }}>
            {TABS.map((entry) => (
              <button
                key={entry.key}
                role="tab"
                aria-selected={tab === entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                style={{
                  padding: "8px 12px",
                  border: "none",
                  borderBottom: `2px solid ${tab === entry.key ? tokens.fg : "transparent"}`,
                  background: "transparent",
                  color: tab === entry.key ? tokens.fg : tokens.muted,
                  fontSize: 13,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          {tab === "activity" ? <ActivityTab overview={overview} /> : null}
          {tab === "schedules" ? <SchedulesTab companyId={companyId} settings={overview.settings} onChange={refresh} /> : null}
          {tab === "commitments" ? <CommitmentsTab companyId={companyId} onChange={refresh} /> : null}
          {tab === "pulse" ? <PulseTab companyId={companyId} /> : null}
          {tab === "settings" ? <SettingsTab companyId={companyId} overview={overview} onChange={refresh} /> : null}
        </>
      )}
    </main>
  );
}

function SetupExplainer() {
  return (
    <section style={cardStyle}>
      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>What setting up does</h2>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.muted, display: "grid", gap: 4 }}>
        <li>Adds a Copilot agent (OpenCode by default; pick its model on the agent page) with a $30 monthly budget.</li>
        <li>Allows that agent to use its memory, pulse, schedule, commitment, and messaging tools (one access policy you can edit).</li>
        <li>Every 30 minutes during active hours, checks the company with plain queries and wakes the Copilot only when something changed.</li>
        <li>Adds a weekday morning brief, nightly memory consolidation, and a Friday weekly review. You can change or disable each.</li>
        <li>Messages reach people through Agent Chat, capped per person per day. Turn it off any time.</li>
      </ul>
    </section>
  );
}

function Row({ time, title, detail, tone }: { time: string; title: ReactNode; detail?: ReactNode; tone?: string }) {
  return (
    <li style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0, 1fr)", gap: 12, padding: "8px 0", borderBottom: `1px solid ${tokens.border}` }}>
      <span style={{ fontSize: 12, color: tokens.muted }}>{formatTime(time)}</span>
      <span style={{ fontSize: 13, minWidth: 0 }}>
        <span style={{ color: tone ?? tokens.fg }}>{title}</span>
        {detail ? <span style={{ display: "block", color: tokens.muted, overflowWrap: "anywhere" }}>{detail}</span> : null}
      </span>
    </li>
  );
}

function ActivityTab({ overview }: { overview: Overview }) {
  const hostNavigation = useHostNavigation();
  const agentRef = overview.agent?.urlKey ?? overview.agent?.id ?? null;
  const runLink = (runId: string | null) =>
    runId && agentRef ? (
      <a {...hostNavigation.linkProps(`/agents/${agentRef}/runs/${runId}`)} style={{ color: tokens.fg }}>
        view run
      </a>
    ) : null;
  const entries = [
    ...overview.wakes.map((wake) => ({
      time: wake.createdAt,
      node: (
        <Row
          key={`w${wake.id}`}
          time={wake.createdAt}
          tone={wake.error ? tokens.destructive : undefined}
          title={<>{wake.reason === "pulse" ? "Pulse check-in" : wake.reason === "manual" ? "Manual check-in" : "Scheduled"} {runLink(wake.runId)}</>}
          detail={wake.error ?? `${wake.itemCount ? `${wake.itemCount} items · ` : ""}${wake.summary}`}
        />
      ),
    })),
    ...overview.notifications.map((note) => ({
      time: note.createdAt,
      node: (
        <Row
          key={`n${note.id}`}
          time={note.createdAt}
          title={`Messaged ${note.userId}${note.urgency === "urgent" ? " (urgent)" : ""}`}
          detail={note.excerpt}
        />
      ),
    })),
    ...overview.scheduleRuns
      .filter((entry) => entry.status !== "fired")
      .map((entry) => ({
        time: entry.firedAt,
        node: (
          <Row
            key={`s${entry.id}`}
            time={entry.firedAt}
            tone={entry.status === "failed" ? tokens.destructive : tokens.muted}
            title={`${entry.scheduleName}: ${entry.status}`}
            detail={entry.error}
          />
        ),
      })),
  ].sort((a, b) => b.time.localeCompare(a.time));

  if (entries.length === 0) {
    return <p style={{ fontSize: 13, color: tokens.muted }}>Nothing yet. The Copilot wakes when the pulse finds something, when a schedule fires, or when you check in.</p>;
  }
  return <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{entries.slice(0, 60).map((entry) => entry.node)}</ul>;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function timingLabel(schedule: Schedule): string {
  if (schedule.kind === "at") return `once at ${formatTime(schedule.runAt)}`;
  if (schedule.kind === "every") return `every ${schedule.everyMinutes} min`;
  return `${schedule.cronExpr} (${schedule.timezone})`;
}

function SchedulesTab({ companyId, settings, onChange }: { companyId: string; settings: Settings; onChange: () => Promise<void> }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedules((await api<{ schedules: Schedule[] }>(`/schedules?companyId=${companyId}`)).schedules);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [companyId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
      await onChange();
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Schedules wake an agent with a message. For recurring work that should create a task each time, use Routines.
        </span>
        {!creating ? <Button primary onClick={() => setCreating(true)}>New schedule</Button> : null}
      </div>
      <ErrorLine message={error} />
      {creating ? (
        <ScheduleForm
          companyId={companyId}
          defaultTimezone={settings.timezone}
          onDone={async () => {
            setCreating(false);
            await load();
            await onChange();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {schedules === null ? (
        <Spinner />
      ) : schedules.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.muted }}>No schedules.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {schedules.map((schedule) => (
            <li key={schedule.id} style={{ ...cardStyle, marginBottom: 8, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>
                  {schedule.name}
                  {schedule.systemKey ? <span style={{ fontWeight: 400, color: tokens.muted }}> · built-in</span> : null}
                  {schedule.createdByKind === "agent" ? <span style={{ fontWeight: 400, color: tokens.muted }}> · made by an agent</span> : null}
                </strong>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button onClick={() => act(() => api(`/schedules/${schedule.id}/run`, { method: "POST", body: JSON.stringify({ companyId }) }))}>
                    Run now
                  </Button>
                  <Button
                    onClick={() =>
                      act(() =>
                        api(`/schedules/${schedule.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ companyId, enabled: !schedule.enabled }),
                        }),
                      )
                    }
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  {!schedule.systemKey ? (
                    <Button danger onClick={() => act(() => api(`/schedules/${schedule.id}?companyId=${companyId}`, { method: "DELETE" }))}>
                      Delete
                    </Button>
                  ) : null}
                </span>
              </div>
              <span style={{ fontSize: 12, color: tokens.muted }}>
                {timingLabel(schedule)} · {schedule.enabled ? `next ${formatTime(schedule.nextRunAt)}` : "paused"}
                {schedule.lastStatus ? ` · last ${schedule.lastStatus} ${formatTime(schedule.lastRunAt)}` : ""}
              </span>
              {schedule.lastError ? <span style={{ fontSize: 12, color: tokens.destructive }}>{schedule.lastError}</span> : null}
              <span style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{schedule.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Timing = "cron" | "every" | "at";

function ScheduleForm(props: { companyId: string; defaultTimezone: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [timing, setTiming] = useState<Timing>("cron");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [at, setAt] = useState("");
  const [timezone, setTimezone] = useState(props.defaultTimezone);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => {
    if (timing !== "cron") return null;
    try {
      if (!isValidTimezone(timezone)) return "Unknown timezone";
      const spec = parseCron(cron);
      const runs: string[] = [];
      let cursor: Date | null = new Date();
      for (let i = 0; i < 5 && cursor; i += 1) {
        cursor = nextCronRun(spec, cursor, timezone);
        if (cursor) runs.push(cursor.toLocaleString());
      }
      return runs.length ? `Next: ${runs.join(" · ")}` : "Never matches";
    } catch (caught) {
      return errorText(caught);
    }
  }, [timing, cron, timezone]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/schedules", {
        method: "POST",
        body: JSON.stringify({
          companyId: props.companyId,
          name,
          message,
          timezone,
          ...(timing === "cron" ? { cron } : timing === "every" ? { everyMinutes: Number(everyMinutes) } : { at: at ? new Date(at).toISOString() : "" }),
        }),
      });
      await props.onDone();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const label = (text: string, control: ReactNode) => (
    <label style={{ display: "grid", gap: 4, fontSize: 12, color: tokens.muted }}>
      {text}
      {control}
    </label>
  );

  return (
    <div style={{ ...cardStyle, display: "grid", gap: 12, marginBottom: 12 }}>
      {label("Name", <input style={inputStyle} value={name} onChange={(event) => setName(event.target.value)} placeholder="Check deploy health" />)}
      {label(
        "Message (what the Copilot should do)",
        <textarea style={{ ...inputStyle, minHeight: 80 }} value={message} onChange={(event) => setMessage(event.target.value)} />,
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {label(
          "When",
          <select style={inputStyle} value={timing} onChange={(event) => setTiming(event.target.value as Timing)}>
            <option value="cron">On a schedule (cron)</option>
            <option value="every">Every N minutes</option>
            <option value="at">Once</option>
          </select>,
        )}
        {timing === "cron" ? label("Cron", <input style={inputStyle} value={cron} onChange={(event) => setCron(event.target.value)} />) : null}
        {timing === "every" ? label("Minutes (5 or more)", <input style={inputStyle} type="number" min={5} value={everyMinutes} onChange={(event) => setEveryMinutes(event.target.value)} />) : null}
        {timing === "at" ? label("At", <input style={inputStyle} type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />) : null}
        {timing === "cron" ? label("Timezone", <input style={inputStyle} value={timezone} onChange={(event) => setTimezone(event.target.value)} />) : null}
      </div>
      {preview ? <span style={{ fontSize: 12, color: tokens.muted }}>{preview}</span> : null}
      <ErrorLine message={error} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Button onClick={props.onCancel} disabled={saving}>Cancel</Button>
        <Button primary onClick={save} disabled={saving || !name.trim() || !message.trim()}>
          {saving ? "Saving…" : "Create schedule"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commitments, pulse, settings
// ---------------------------------------------------------------------------

function CommitmentsTab({ companyId, onChange }: { companyId: string; onChange: () => Promise<void> }) {
  const [filter, setFilter] = useState("open");
  const [commitments, setCommitments] = useState<Commitment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCommitments((await api<{ commitments: Commitment[] }>(`/commitments?companyId=${companyId}&status=${filter}`)).commitments);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [companyId, filter]);
  useEffect(() => {
    void load();
  }, [load]);
  const setStatus = async (id: string, status: string) => {
    try {
      await api(`/commitments/${id}`, { method: "PATCH", body: JSON.stringify({ companyId, status }) });
      await load();
      await onChange();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <section>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <select style={inputStyle} value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter commitments">
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
        <span style={{ fontSize: 13, color: tokens.muted }}>Promises the Copilot noticed, with who owns them and when they are due.</span>
      </div>
      <ErrorLine message={error} />
      {commitments === null ? (
        <Spinner />
      ) : commitments.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.muted }}>No commitments.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {commitments.map((commitment) => (
            <li key={commitment.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: `1px solid ${tokens.border}` }}>
              <span style={{ fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }}>
                {commitment.text}
                <span style={{ display: "block", fontSize: 12, color: tokens.muted }}>
                  {commitment.ownerKind === "company" ? "company" : `${commitment.ownerKind} ${commitment.ownerId}`} · {commitment.dueAt ? `due ${formatTime(commitment.dueAt)}` : "no due date"} · {commitment.status}
                </span>
              </span>
              {commitment.status === "open" ? (
                <span style={{ display: "flex", gap: 6 }}>
                  <Button onClick={() => setStatus(commitment.id, "done")}>Done</Button>
                  <Button onClick={() => setStatus(commitment.id, "cancelled")}>Cancel</Button>
                </span>
              ) : (
                <Button onClick={() => setStatus(commitment.id, "open")}>Reopen</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PulseTab({ companyId }: { companyId: string }) {
  const [pulse, setPulse] = useState<{ markdown: string; itemCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ markdown: string; itemCount: number }>(`/copilot/pulse?companyId=${companyId}`)
      .then(setPulse)
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [companyId]);
  return (
    <section>
      <p style={{ fontSize: 13, color: tokens.muted, marginTop: 0 }}>
        What the next pulse sees. Built from plain queries; the Copilot is only woken when this changes.
      </p>
      <ErrorLine message={error} />
      {pulse === null && !error ? <Spinner /> : pulse?.markdown ? <MarkdownBlock content={pulse.markdown} /> : <p style={{ fontSize: 13 }}>Quiet: nothing stale, blocked, or waiting.</p>}
    </section>
  );
}

function SettingsTab({ companyId, overview, onChange }: { companyId: string; overview: Overview; onChange: () => Promise<void> }) {
  const hostNavigation = useHostNavigation();
  const [draft, setDraft] = useState(() => ({ ...overview.settings }));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [policies, setPolicies] = useState<{ memory: boolean; copilot: boolean } | null>(null);

  const loadPolicies = useCallback(async () => {
    try {
      const found = await listCopilotPolicies(companyId);
      setPolicies({ memory: Boolean(found.memory?.enabled), copilot: Boolean(found.copilot?.enabled) });
    } catch {
      setPolicies(null);
    }
  }, [companyId]);
  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      await api("/copilot/settings", {
        method: "PATCH",
        body: JSON.stringify({
          companyId,
          pulseIntervalMinutes: Number(draft.pulseIntervalMinutes),
          activeStart: draft.activeStart,
          activeEnd: draft.activeEnd,
          timezone: draft.timezone,
          maxWakesPerHour: Number(draft.maxWakesPerHour),
          maxNotificationsPerUserPerDay: Number(draft.maxNotificationsPerUserPerDay),
          staleAfterHours: Number(draft.staleAfterHours),
        }),
      });
      setSaved(true);
      await onChange();
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const field = (label: string, key: keyof Settings, type: "text" | "number" = "number") => (
    <label style={{ display: "grid", gap: 4, fontSize: 12, color: tokens.muted }}>
      {label}
      <input
        style={inputStyle}
        type={type}
        value={String(draft[key] ?? "")}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );

  const agentRef = overview.agent?.urlKey ?? overview.agent?.id;
  return (
    <section style={{ display: "grid", gap: 16 }}>
      <div style={{ ...cardStyle, display: "grid", gap: 12 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Pulse and limits</h2>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          {field("Pulse every (minutes)", "pulseIntervalMinutes")}
          {field("Active from (HH:MM)", "activeStart", "text")}
          {field("Active until (HH:MM)", "activeEnd", "text")}
          {field("Timezone", "timezone", "text")}
          {field("Max check-ins per hour", "maxWakesPerHour")}
          {field("Max messages per person per day", "maxNotificationsPerUserPerDay")}
          {field("Task is stale after (hours)", "staleAfterHours")}
        </div>
        <ErrorLine message={error} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          {saved ? <span style={{ fontSize: 12, color: tokens.muted }}>Saved.</span> : null}
          <Button primary onClick={save}>Save</Button>
        </div>
      </div>

      <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tool access</h2>
        <p style={{ fontSize: 13, color: tokens.muted, margin: 0 }}>
          Agents can only use plugin tools that an access policy allows. These are ordinary policies you can edit in Access settings.
        </p>
        {policies === null ? (
          <span style={{ fontSize: 13, color: tokens.muted }}>Could not read access policies (board access required).</span>
        ) : (
          <>
            <PolicyRow
              label="Copilot uses its tools (memory, pulse, schedules, commitments, messaging)"
              allowed={policies.copilot}
              onAllow={async () => {
                if (!overview.settings.agentId) throw new Error("Set up the Copilot first");
                await allowCopilotTools(companyId, overview.settings.agentId);
                await loadPolicies();
              }}
            />
            <PolicyRow
              label="Every agent uses memory tools (search, notes, MEMORY.md)"
              allowed={policies.memory}
              onAllow={async () => {
                await allowMemoryToolsForAllAgents(companyId);
                await loadPolicies();
              }}
            />
          </>
        )}
      </div>

      <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Copilot agent</h2>
        <p style={{ fontSize: 13, color: tokens.muted, margin: 0 }}>
          {overview.agent
            ? `${overview.agent.name} · ${overview.agent.adapterType} · ${overview.agent.status}. Choose its model, budget, and instructions on the agent page.`
            : "Agent not found."}
        </p>
        {agentRef ? (
          <a {...hostNavigation.linkProps(`/agents/${agentRef}`)} style={{ fontSize: 13, color: tokens.fg }}>
            Open agent settings
          </a>
        ) : null}
      </div>
    </section>
  );
}

function PolicyRow({ label, allowed, onAllow }: { label: string; allowed: boolean; onAllow: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      {allowed ? (
        <span style={{ fontSize: 12, color: tokens.muted }}>Allowed</span>
      ) : (
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onAllow();
            } catch (caught) {
              setError(errorText(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          Allow
        </Button>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
