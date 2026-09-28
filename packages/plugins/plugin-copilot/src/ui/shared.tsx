import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export const PLUGIN_KEY = "paperclipai.plugin-copilot";

// Host theme variables with dark fallbacks, so plugin pages match the board.
export const tokens = {
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
export const fontStack = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(payload?.error ?? `Request failed (${response.status})`, response.status);
  return payload as T;
}

/** This plugin's API routes, authenticated as the signed-in board user. */
export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(`/api/plugins/${PLUGIN_KEY}/api${path}`, init);
}

/** Paperclip's own REST API, for things the plugin cannot do itself (tool access policies). */
export function coreApi<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(`/api${path}`, init);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useIsNarrow(): boolean {
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

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const color = props.danger ? tokens.destructive : props.primary ? tokens.primaryFg : tokens.fg;
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      style={{
        padding: "6px 12px",
        borderRadius: tokens.radius,
        border: `1px solid ${props.danger ? tokens.destructive : props.primary ? tokens.primary : tokens.border}`,
        background: props.primary ? tokens.primary : "transparent",
        color,
        fontSize: 13,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </button>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" style={{ color: tokens.destructive, fontSize: 13, margin: "8px 0" }}>
      {message}
    </p>
  );
}

export const inputStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.border}`,
  background: "transparent",
  color: tokens.fg,
  fontSize: 13,
  minWidth: 0,
};

export const cardStyle: CSSProperties = {
  border: `1px solid ${tokens.border}`,
  borderRadius: tokens.radius,
  padding: 16,
  background: tokens.card,
};

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
