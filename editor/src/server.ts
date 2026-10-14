// Client for the BISAK Kerf Server (shared/openapi.yaml). The token and address live in this browser only.
import type { Preset } from "./presets";
import type { JobDoc } from "./job";

export interface Session { baseUrl: string; token: string; role: string; id: string }
export interface Receipt { id: string; status: string; warnings?: string[]; estimate?: { durationS?: number; percentUsed?: number; costSar?: number | null; partAreaMm2?: number } }
export interface JobSummary { id: string; status: string; statusReason?: string; createdAt: string; preset: { id: string; version: number }; estimate?: Receipt["estimate"]; warnings?: string[]; source?: string }

export class ServerError extends Error {
  constructor(message: string, public status: number, public code: string, public details?: { path: string; message: string }[]) {
    super(message);
  }
}

const KEY = "kerf.session";
export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return s && typeof s.token === "string" && typeof s.baseUrl === "string" ? (s as Session) : null;
  } catch { return null; }
}
export function saveSession(s: Session | null): void {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private window: stay signed in for this page only */ }
}

/** "https://kerf.school/" and "https://kerf.school/api/v1" both become "https://kerf.school"; blank means this page's own server. */
export function normaliseBase(input: string): string {
  return input.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

type Fetch = typeof fetch;

export async function request<T>(s: { baseUrl: string; token: string }, method: string, path: string, body?: unknown, f: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(`${s.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${s.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ServerError("Can't reach the server. Check the address and your network.", 0, "network");
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json ?? {}) as { code?: string; message?: string; details?: { path: string; message: string }[] };
    const msg = res.status === 401 ? "The server doesn't accept that token. Ask your teacher for a new one." : e.message ?? `The server answered ${res.status}.`;
    throw new ServerError(msg, res.status, e.code ?? "error", e.details);
  }
  return json as T;
}

export async function signIn(baseUrl: string, token: string, f: Fetch = fetch): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const me = await request<{ role: string; id: string }>({ baseUrl: base, token }, "GET", "/auth/me", undefined, f);
  if (me.role === "station") throw new ServerError("That is a laser-station token. Pupils use their own token.", 403, "forbidden");
  return { baseUrl: base, token, role: me.role, id: me.id };
}

export const listPresets = (s: Session, f?: Fetch) => request<Preset[]>(s, "GET", "/presets", undefined, f);
export const sendJob = (s: Session, job: JobDoc, f?: Fetch) => request<Receipt>(s, "POST", "/jobs", job, f);
export const listJobs = (s: Session, f?: Fetch) => request<JobSummary[]>(s, "GET", "/jobs", undefined, f);
export const cancelJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/cancel`, undefined, f);
export const submitJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/submit`, undefined, f);

export function describeDuration(s: number | undefined): string {
  if (s === undefined) return "";
  const m = Math.round(s / 60);
  return m < 1 ? `${Math.round(s)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const STATUS_TEXT: Record<string, string> = {
  draft: "Saved, not sent for cutting",
  submitted: "Waiting for a teacher",
  approved: "Approved: go to a laser",
  queued: "In the queue",
  assigned: "Starting on a laser",
  running: "Cutting now",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};
