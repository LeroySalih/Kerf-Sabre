// Client for the BISAK Kerf Server (shared/openapi.yaml). The token and address live in this browser only.
import type { Preset } from "./presets";
import type { JobDimension, JobDoc, JobObject, Origin } from "./job";

export interface Session { baseUrl: string; token: string; role: string; id: string; classCode?: string; expiresAt?: string }
export interface Receipt { ticket?: number | null; position?: number | null; id: string; status: string; warnings?: string[]; estimate?: { durationS?: number; percentUsed?: number; costSar?: number | null; partAreaMm2?: number } }
export interface QueueEntry {
  ticket: number; jobId: string | null; status: string; position: number | null; own: boolean; pupilId?: string | null; presetId?: string;
  station?: string | null; framedOn?: string | null; next?: boolean; estimatedS?: number | null; aheadS?: number | null; approvedAt?: string | null;
}
export interface StationInfo {
  id: string; online: boolean; state?: string | null; mpos?: number[] | null; currentJobId?: string | null; cutterVersion?: string | null;
  s30?: number | null; laserMode?: boolean | null; cameraAvailable?: boolean; lastSeen?: string | null;
  progress?: { jobId: string; line: number; totalLines: number; estimatedS?: number; actualS?: number } | null;
}
export interface JobSummary { pupilId?: string; ticket?: number | null; objects: JobObject[]; dimensions?: JobDimension[]; origin: Origin; id: string; status: string; statusReason?: string; createdAt: string; preset: { id: string; version: number }; estimate?: Receipt["estimate"]; warnings?: string[]; source?: string }

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
  return { baseUrl: base, token, role: me.role, id: me.id };
}

/** Class login: class code + pupil ID + PIN give a short-lived token. Wrong details come back as the server's own words. */
export async function loginWithPin(baseUrl: string, classCode: string, pupilId: string, pin: string, f: Fetch = fetch): Promise<Session> {
  const base = normaliseBase(baseUrl);
  let res: Response;
  try {
    res = await f(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classCode: classCode.trim(), pupilId: pupilId.trim(), pin: pin.trim() }) });
  } catch {
    throw new ServerError("Can't reach the server. Check the address and your network.", 0, "network");
  }
  const json = (await res.json().catch(() => null)) as { token?: string; id?: string; classCode?: string; expiresAt?: string; code?: string; message?: string } | null;
  if (!res.ok || !json?.token) throw new ServerError(json?.message ?? `The server answered ${res.status}.`, res.status, json?.code ?? "error");
  return { baseUrl: base, token: json.token, role: "pupil", id: json.id!, classCode: json.classCode, expiresAt: json.expiresAt };
}

/** End a class-login session on the server (best effort: the token also expires by itself). */
export async function logout(s: Session, f: Fetch = fetch): Promise<void> {
  try { await f(`${s.baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` } }); } catch { /* offline: it will expire */ }
}

export interface ClassInfo { code: string; label: string | null; pupilCount: number }
export interface ClassPupil { pupilId: string; lastLogin: string | null; locked: boolean }
export interface AddedPupils { created: { pupilId: string; pin: string }[]; existing: string[]; conflicts: string[] }
export const listClasses = (s: Session, f?: Fetch) => request<ClassInfo[]>(s, "GET", "/classes", undefined, f);
export const createClass = (s: Session, code: string, label: string, f?: Fetch) => request<ClassInfo>(s, "POST", "/classes", { code, label }, f);
export const classPupils = (s: Session, code: string, f?: Fetch) => request<ClassPupil[]>(s, "GET", `/classes/${encodeURIComponent(code)}/pupils`, undefined, f);
export const addPupils = (s: Session, code: string, pupilIds: string[], f?: Fetch) => request<AddedPupils>(s, "POST", `/classes/${encodeURIComponent(code)}/pupils`, { pupilIds }, f);
export const resetPin = (s: Session, pupilId: string, f?: Fetch) => request<{ pupilId: string; pin: string }>(s, "POST", `/pupils/${encodeURIComponent(pupilId)}/reset-pin`, undefined, f);
export const removePupil = (s: Session, code: string, pupilId: string, f?: Fetch) => request<null>(s, "DELETE", `/classes/${encodeURIComponent(code)}/pupils/${encodeURIComponent(pupilId)}`, undefined, f);

/** Pupil IDs pasted from a spreadsheet or typed: split on whitespace, commas and semicolons; drop blanks and repeats. */
export function parseIds(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/** "pupilId,pin" lines for handing out. */
export const pinsCsv = (rows: { pupilId: string; pin: string }[]): string => ["pupilId,pin", ...rows.map((r) => `${r.pupilId},${r.pin}`)].join("\n") + "\n";

export const listPresets = (s: Session, f?: Fetch) => request<Preset[]>(s, "GET", "/presets", undefined, f);
export const sendJob = (s: Session, job: JobDoc, f?: Fetch) => request<Receipt>(s, "POST", "/jobs", job, f);
export const saveDraft = (s: Session, id: string, job: JobDoc, f?: Fetch) => request<Receipt>(s, "PUT", `/jobs/${encodeURIComponent(id)}`, job, f);
export const listQueue = (s: Session, station?: string, f?: Fetch) => request<QueueEntry[]>(s, "GET", station ? `/queue?station=${encodeURIComponent(station)}` : "/queue", undefined, f);
export const listStations = (s: Session, f?: Fetch) => request<StationInfo[]>(s, "GET", "/stations", undefined, f);
export const getJob = (s: Session, id: string, f?: Fetch) => request<JobSummary & { origin: Origin; station?: string | null }>(s, "GET", `/jobs/${encodeURIComponent(id)}`, undefined, f);
export const frameJob = (s: Session, id: string, station: string, f?: Fetch) => request<{ bounds: { minX: number; minY: number; maxX: number; maxY: number } }>(s, "POST", `/jobs/${encodeURIComponent(id)}/frame`, { station }, f);
export const assignJob = (s: Session, id: string, station: string, materialConfirmed: boolean, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/assign`, { station, materialConfirmed }, f);
export const controlStation = (s: Session, station: string, command: "stop" | "pause" | "resume", f?: Fetch) => request<unknown>(s, "POST", `/stations/${encodeURIComponent(station)}/control`, { command }, f);
export const deferJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/defer`, undefined, f);
export const approveJob = (s: Session, id: string, station?: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/approve`, station ? { station } : {}, f);
export const rejectJob = (s: Session, id: string, reason: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/reject`, { reason }, f);
export const moveInQueue = (s: Session, id: string, body: { to?: "front" | "back" | "up" | "down"; position?: number }, f?: Fetch) => request<QueueEntry[]>(s, "POST", `/queue/${encodeURIComponent(id)}/move`, body, f);
export const listJobsByStatus = (s: Session, status: string, f?: Fetch) => request<JobSummary[]>(s, "GET", `/jobs?status=${encodeURIComponent(status)}`, undefined, f);

/** The latest camera picture as an object URL (the caller revokes it), or null when there is none. */
export async function cameraUrl(s: Session, station: string, f: Fetch = fetch): Promise<string | null> {
  try {
    const res = await f(`${s.baseUrl}/api/v1/stations/${encodeURIComponent(station)}/camera`, { headers: { Authorization: `Bearer ${s.token}` } });
    return res.ok ? URL.createObjectURL(await res.blob()) : null;
  } catch { return null; }
}
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

export const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

/** "Ticket 17, 3rd in the queue (about 6 min before yours)" for a waiting job; "" when it is not in the queue. */
export function queueText(ticket: number | null | undefined, position: number | null | undefined, aheadS?: number | null): string {
  if (ticket == null) return "";
  if (position == null) return `Ticket ${ticket}`;
  const wait = aheadS ? `, about ${describeDuration(aheadS)} of cutting before yours` : "";
  return position === 1 ? `Ticket ${ticket}, you are next` : `Ticket ${ticket}, ${ordinal(position)} in the queue${wait}`;
}
