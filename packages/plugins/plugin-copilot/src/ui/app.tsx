import {
  MarkdownBlock,
  MarkdownEditor,
  Spinner,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

const PLUGIN_KEY = "paperclipai.plugin-copilot";

// Host theme variables with dark fallbacks, so the page matches the board.
const tokens = {
  border: "var(--border, oklch(0.269 0 0))",
  card: "var(--card, oklch(0.205 0 0))",
  fg: "var(--foreground, oklch(0.985 0 0))",
  muted: "var(--muted-foreground, oklch(0.708 0 0))",
  accent: "var(--accent, oklch(0.269 0 0))",
  primary: "var(--primary, oklch(0.985 0 0))",
  primaryFg: "var(--primary-foreground, oklch(0.205 0 0))",
  destructive: "var(--destructive, oklch(0.637 0.237 25.331))",
  radius: "var(--radius, 8px)",
};
const fontStack = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";

type ScopeKind = "company" | "user" | "agent";

interface Scope {
  kind: ScopeKind;
  id: string;
}

interface DocumentSummary {
  scope: Scope;
  path: string;
  chars: number;
  noteDate: string | null;
  updatedAt: string;
}

interface MemoryDocument {
  scope: Scope;
  path: string;
  body: string;
  updatedAt?: string;
  exists?: boolean;
}

interface SearchHit {
  path: string;
  scope: Scope;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  vectorScore: number;
  textScore: number;
  noteDate: string | null;
}

interface IndexStatus {
  documents: number;
  pending: number;
  chunks: number;
  embeddedChunks: number;
  vectorExtension: boolean;
  embeddingsConfigured: boolean;
  mode: "hybrid" | "keyword";
}

class ApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/plugins/${PLUGIN_KEY}/api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(payload?.error ?? `Request failed (${response.status})`);
  return payload as T;
}

function useIsNarrow(): boolean {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function sameDoc(a: { scope: Scope; path: string } | null, b: { scope: Scope; path: string }): boolean {
  return Boolean(a && a.scope.kind === b.scope.kind && a.scope.id === b.scope.id && a.path === b.path);
}

function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        padding: "6px 12px",
        borderRadius: tokens.radius,
        border: `1px solid ${props.primary ? tokens.primary : tokens.border}`,
        background: props.primary ? tokens.primary : "transparent",
        color: props.primary ? tokens.primaryFg : tokens.fg,
        fontSize: 13,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      {props.children}
    </button>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" style={{ color: tokens.destructive, fontSize: 13, margin: "8px 0" }}>
      {message}
    </p>
  );
}

function MemoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M12 5v13" />
    </svg>
  );
}

export function MemorySidebarLink(_props: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  return (
    <a
      {...hostNavigation.linkProps("/memory")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
      style={{ textDecoration: "none" }}
    >
      <span className="shrink-0">
        <MemoryIcon />
      </span>
      <span className="flex-1 truncate">Memory</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Memory page
// ---------------------------------------------------------------------------

export function MemoryPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const narrow = useIsNarrow();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  // The server's authenticated user, which is also set in local trusted mode where host context may omit it.
  const [apiUserId, setApiUserId] = useState<string | null>(null);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [selected, setSelected] = useState<{ scope: Scope; path: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    try {
      const [docs, indexStatus] = await Promise.all([
        api<{ documents: DocumentSummary[]; userId: string | null }>(`/documents?companyId=${companyId}`),
        api<IndexStatus>(`/status?companyId=${companyId}`),
      ]);
      setDocuments(docs.documents);
      setApiUserId(docs.userId);
      setStatus(indexStatus);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/companies/${companyId}/agents`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : []))
      .then((agents: Array<{ id: string; name: string }>) =>
        setAgentNames(Object.fromEntries((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent.name]))),
      )
      .catch(() => undefined);
  }, [companyId]);

  if (!companyId) {
    return <main style={{ padding: 24, color: tokens.muted, fontFamily: fontStack }}>Select a company to see its memory.</main>;
  }

  const userId = apiUserId ?? context.userId;
  const openStarter = (scope: Scope, path: string) => setSelected({ scope, path });

  return (
    <main style={{ padding: narrow ? 16 : 24, fontFamily: fontStack, color: tokens.fg, minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Memory</h1>
        <span style={{ color: tokens.muted, fontSize: 13 }}>
          What your agents remember. Recalled into every run; searchable with the memory tools.
        </span>
      </header>
      <ErrorLine message={loadError} />
      <SearchBox companyId={companyId} onOpen={(scope, path) => setSelected({ scope, path })} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "1fr" : "260px minmax(0, 1fr)",
          gap: 16,
          marginTop: 16,
        }}
      >
        <nav
          aria-label="Memory files"
          style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius, padding: 8, alignSelf: "start" }}
        >
          {documents === null ? (
            <Spinner />
          ) : (
            <ScopeTree
              documents={documents}
              agentNames={agentNames}
              companyId={companyId}
              userId={userId}
              selected={selected}
              onSelect={setSelected}
              onStarter={openStarter}
            />
          )}
        </nav>
        <section style={{ minWidth: 0 }}>
          {selected ? (
            <DocumentPane
              key={`${selected.scope.kind}:${selected.scope.id}:${selected.path}`}
              companyId={companyId}
              target={selected}
              onSaved={refresh}
            />
          ) : (
            <p style={{ color: tokens.muted, fontSize: 14 }}>Choose a file, or search above.</p>
          )}
        </section>
      </div>
      {status ? <StatusBar status={status} /> : null}
    </main>
  );
}

function TreeItem(props: { label: string; hint?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? "true" : undefined}
      style={{
        display: "flex",
        width: "100%",
        justifyContent: "space-between",
        gap: 8,
        padding: "4px 8px",
        border: "none",
        borderRadius: 6,
        background: props.active ? tokens.accent : "transparent",
        color: tokens.fg,
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.label}</span>
      {props.hint ? <span style={{ color: tokens.muted, fontSize: 12 }}>{props.hint}</span> : null}
    </button>
  );
}

function TreeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: tokens.muted, padding: "4px 8px" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ScopeTree(props: {
  documents: DocumentSummary[];
  agentNames: Record<string, string>;
  companyId: string;
  userId: string | null;
  selected: { scope: Scope; path: string } | null;
  onSelect: (target: { scope: Scope; path: string }) => void;
  onStarter: (scope: Scope, path: string) => void;
}) {
  const { documents, selected, onSelect } = props;
  const byScope = (kind: ScopeKind, id?: string) =>
    documents.filter((doc) => doc.scope.kind === kind && (id === undefined || doc.scope.id === id));
  const agentIds = [...new Set(byScope("agent").map((doc) => doc.scope.id))];
  const companyScope: Scope = { kind: "company", id: props.companyId };
  const userScope: Scope | null = props.userId ? { kind: "user", id: props.userId } : null;

  const renderDocs = (docs: DocumentSummary[]) =>
    docs.map((doc) => (
      <TreeItem
        key={`${doc.scope.kind}:${doc.scope.id}:${doc.path}`}
        label={doc.path}
        hint={`${Math.max(1, Math.round(doc.chars / 1000))}k`}
        active={sameDoc(selected, doc)}
        onClick={() => onSelect({ scope: doc.scope, path: doc.path })}
      />
    ));

  const companyDocs = byScope("company");
  const myDocs = userScope ? byScope("user", userScope.id) : [];

  return (
    <div>
      <TreeGroup title="Company">
        {renderDocs(companyDocs)}
        {!companyDocs.some((doc) => doc.path === "MEMORY.md") ? (
          <TreeItem label="+ MEMORY.md" active={false} onClick={() => props.onStarter(companyScope, "MEMORY.md")} />
        ) : null}
      </TreeGroup>
      {userScope ? (
        <TreeGroup title="Just me">
          {renderDocs(myDocs)}
          {!myDocs.some((doc) => doc.path === "USER.md") ? (
            <TreeItem label="+ USER.md" active={false} onClick={() => props.onStarter(userScope, "USER.md")} />
          ) : null}
        </TreeGroup>
      ) : null}
      {agentIds.length > 0 ? (
        <TreeGroup title="Agents">
          {agentIds.map((agentId) => (
            <div key={agentId} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12, color: tokens.muted, padding: "2px 8px" }}>
                {props.agentNames[agentId] ?? agentId.slice(0, 8)}
              </div>
              {renderDocs(byScope("agent", agentId))}
            </div>
          ))}
        </TreeGroup>
      ) : null}
    </div>
  );
}

function DocumentPane(props: {
  companyId: string;
  target: { scope: Scope; path: string };
  onSaved: () => Promise<void>;
}) {
  const { companyId, target } = props;
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      companyId,
      scopeKind: target.scope.kind,
      scopeId: target.scope.id,
      path: target.path,
    });
    api<{ document: MemoryDocument }>(`/document?${params.toString()}`)
      .then((result) => {
        setDocument(result.document);
        setDraft(result.document.body);
        setEditing(result.document.exists === false);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [companyId, target.scope.kind, target.scope.id, target.path]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ document: MemoryDocument }>("/document", {
        method: "POST",
        body: JSON.stringify({
          companyId,
          scopeKind: target.scope.kind,
          scopeId: target.scope.id,
          path: target.path,
          body: draft,
        }),
      });
      setDocument(result.document);
      setEditing(false);
      await props.onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const scopeLabel = target.scope.kind === "user" ? "just me" : target.scope.kind;
  const headerStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 12,
  };

  return (
    <article style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius, padding: 16, background: tokens.card }}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{target.path}</div>
          <div style={{ fontSize: 12, color: tokens.muted }}>
            {scopeLabel}
            {document?.updatedAt ? ` · updated ${new Date(document.updatedAt).toLocaleString()}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {editing ? (
            <>
              <Button
                onClick={() => {
                  setDraft(document?.body ?? "");
                  setEditing(false);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button primary onClick={save} disabled={saving || draft === (document?.body ?? "")}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button onClick={() => setEditing(true)}>Edit</Button>
          )}
        </div>
      </div>
      <ErrorLine message={error} />
      {document === null && !error ? (
        <Spinner />
      ) : editing ? (
        <MarkdownEditor value={draft} onChange={setDraft} bordered placeholder="Write durable facts, decisions, and preferences…" />
      ) : draft.trim() ? (
        <MarkdownBlock content={draft} />
      ) : (
        <p style={{ color: tokens.muted, fontSize: 14 }}>Empty.</p>
      )}
    </article>
  );
}

function SearchBox(props: { companyId: string; onOpen: (scope: Scope, path: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ companyId: props.companyId, q: query.trim() });
      const result = await api<{ results: SearchHit[]; mode: string }>(`/search?${params.toString()}`);
      setHits(result.results);
      setMode(result.mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memory…"
          aria-label="Search memory"
          style={{
            flex: 1,
            minWidth: 0,
            padding: "8px 10px",
            borderRadius: tokens.radius,
            border: `1px solid ${tokens.border}`,
            background: "transparent",
            color: tokens.fg,
            fontSize: 14,
          }}
        />
        <Button type="submit" primary disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      <ErrorLine message={error} />
      {hits ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 6 }}>
            {hits.length} result{hits.length === 1 ? "" : "s"} · {mode} search
          </div>
          {hits.map((hit, index) => (
            <button
              key={`${hit.scope.kind}:${hit.scope.id}:${hit.path}:${hit.startLine}:${index}`}
              type="button"
              onClick={() => props.onOpen(hit.scope, hit.path)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                border: `1px solid ${tokens.border}`,
                borderRadius: tokens.radius,
                background: "transparent",
                color: tokens.fg,
                padding: 10,
                marginBottom: 8,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span>
                  {hit.scope.kind === "user" ? "just me" : hit.scope.kind} · {hit.path}#L{hit.startLine}
                </span>
                <span style={{ color: tokens.muted }}>
                  score {hit.score} (vector {hit.vectorScore}, keyword {hit.textScore})
                </span>
              </div>
              <div style={{ fontSize: 13, color: tokens.muted, marginTop: 4, whiteSpace: "pre-wrap" }}>{hit.snippet}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusBar({ status }: { status: IndexStatus }) {
  const detail = useMemo(() => {
    if (status.mode === "hybrid") {
      return status.vectorExtension ? "hybrid search (pgvector)" : "hybrid search (in-process vectors)";
    }
    return "keyword search · add an embeddings key in plugin settings for semantic recall";
  }, [status]);
  return (
    <footer style={{ marginTop: 16, fontSize: 12, color: tokens.muted }}>
      {detail} · {status.documents} files · {status.chunks} chunks
      {status.embeddedChunks ? ` (${status.embeddedChunks} embedded)` : ""}
      {status.pending ? ` · ${status.pending} waiting to index` : ""}
    </footer>
  );
}
