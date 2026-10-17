// Client for the BISAK Kerf Server (shared/openapi.yaml). The token and address live in this browser only.
import type { Preset } from "./presets";
import type { JobDimension, JobDoc, JobObject, Origin } from "./job";
import type { Calibration } from "./alignlogic";

export interface Session { baseUrl: string; token: string; role: string; id: string; school?: string | null; classCode?: string; expiresAt?: string; /** Signed in with DINO: the access token is short-lived and renewed in place, and is never written to localStorage. */ sso?: boolean;
  /** The person's DINO display name, kept in memory only (never stored here) so the top bar can show a name instead of an ID. Never an email. */
  name?: string }
export interface Receipt { ticket?: number | null; position?: number | null; id: string; status: string; warnings?: string[]; replaced?: { id: string; ticket?: number | null }[]; estimate?: { durationS?: number; percentUsed?: number; costSar?: number | null; partAreaMm2?: number; extentMm?: Extent } }
/** The size of the design itself (not the bed), in mm. */
export interface Extent { widthMm: number; heightMm: number }
export interface QueueEntry {
  extentMm?: Extent | null;
  ticket: number; jobId: string | null; status: string; position: number | null; own: boolean; pupilId?: string | null; /** Staff only: the name DINO gave at sign-in. */ pupilName?: string | null; presetId?: string;
  station?: string | null; framedOn?: string | null; next?: boolean; estimatedS?: number | null; aheadS?: number | null; approvedAt?: string | null;
}
export interface StationInfo {
  id: string; online: boolean; state?: string | null; mpos?: number[] | null; currentJobId?: string | null; cutterVersion?: string | null;
  s30?: number | null; laserMode?: boolean | null; cameraAvailable?: boolean; calibrated?: boolean; lastSeen?: string | null;
  progress?: { jobId: string; line: number; totalLines: number; estimatedS?: number; actualS?: number } | null;
}
export interface JobSummary { activityId?: string | null; pupilId?: string; pupilName?: string; ticket?: number | null; objects: JobObject[]; dimensions?: JobDimension[]; origin: Origin; id: string; status: string; statusReason?: string; createdAt: string; preset: { id: string; version: number }; estimate?: Receipt["estimate"]; warnings?: string[]; source?: string }

export class ServerError extends Error {
  constructor(message: string, public status: number, public code: string, public details?: { path: string; message: string }[]) {
    super(message);
  }
}

const KEY = "kerf.session"; // an older version kept a pasted token here
/** Nothing is stored: a DINO session lives in memory and a refresh token in the tab. This only clears what an older version stored. */
export function saveSession(_s: Session | null): void {
  try { localStorage.removeItem(KEY); } catch { /* fine */ }
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
    const msg = res.status === 401 ? "Your sign-in is not valid any more. Sign in with DINO again." : e.message ?? `The server answered ${res.status}.`;
    throw new ServerError(msg, res.status, e.code ?? "error", e.details);
  }
  return json as T;
}

export interface School { id: string; name: string; createdAt?: string }
export interface StaffMember { role: "admin" | "teacher" | "technician" | "station"; id: string; label?: string | null; createdAt?: string }
export const listSchools = (s: Session, f?: Fetch) => request<School[]>(s, "GET", "/schools", undefined, f);
export const createSchool = (s: Session, id: string, name: string, adminId?: string, f?: Fetch) => request<School & { admin?: { id: string; token: string } }>(s, "POST", "/schools", { id, name, ...(adminId ? { adminId } : {}) }, f);
export const mySchool = (s: Session, f?: Fetch) => request<School>(s, "GET", "/school", undefined, f);
export const listStaff = (s: Session, f?: Fetch) => request<StaffMember[]>(s, "GET", "/staff", undefined, f);
export const addStaff = (s: Session, role: StaffMember["role"], id: string, label?: string, f?: Fetch) => request<{ role: string; id: string; token: string }>(s, "POST", "/staff", { role, id, ...(label ? { label } : {}) }, f);
export const revokeStaff = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/staff/${encodeURIComponent(id)}`, undefined, f);

/** End a session on the server (best effort: the token also expires by itself). */
export async function logout(s: Session, f: Fetch = fetch): Promise<void> {
  try { await f(`${s.baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` } }); } catch { /* offline: it will expire */ }
}

export interface ClassInfo { code: string; label: string | null; pupilCount: number; teacherId?: string | null; requireApproval?: boolean }
export interface ClassPupil { pupilId: string; displayName?: string; lastLogin: string | null; locked: boolean }
export interface AddedPupils { created: { pupilId: string; pin: string }[]; existing: string[]; conflicts: string[] }
export const listClasses = (s: Session, f?: Fetch) => request<ClassInfo[]>(s, "GET", "/classes", undefined, f);
export const createClass = (s: Session, code: string, label: string, requireApproval = true, f?: Fetch) => request<ClassInfo>(s, "POST", "/classes", { code, label, requireApproval }, f);
export const updateClass = (s: Session, code: string, body: { label?: string; requireApproval?: boolean }, f?: Fetch) => request<ClassInfo>(s, "PUT", `/classes/${encodeURIComponent(code)}`, body, f);
export const classPupils = (s: Session, code: string, f?: Fetch) => request<ClassPupil[]>(s, "GET", `/classes/${encodeURIComponent(code)}/pupils`, undefined, f);
export const addPupils = (s: Session, code: string, pupilIds: string[], f?: Fetch) => request<AddedPupils>(s, "POST", `/classes/${encodeURIComponent(code)}/pupils`, { pupilIds }, f);
export const removePupil = (s: Session, code: string, pupilId: string, f?: Fetch) => request<null>(s, "DELETE", `/classes/${encodeURIComponent(code)}/pupils/${encodeURIComponent(pupilId)}`, undefined, f);

/** Pupil IDs pasted from a spreadsheet or typed: split on whitespace, commas and semicolons; drop blanks and repeats. */
export function parseIds(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/** "pupilId,pin" lines for handing out. */

export type ActivityStatus = "todo" | "working" | "submitted" | "revise" | "complete";
export const ACTIVITY_STATUS_TEXT: Record<ActivityStatus, string> = { todo: "Not started", working: "Working on it", submitted: "Handed in", revise: "Please improve", complete: "Complete" };
export interface FeedbackItem { id: number; teacherId: string; text: string; outcome: "comment" | "revise" | "complete"; jobId?: string | null; createdAt: string }
export interface Activity { id: string; classCode: string; title: string; instructions?: string; position: number; presetId?: string | null; dueAt?: string | null; published: boolean; counts?: Record<string, number> }
export interface MyActivity extends Activity { status: ActivityStatus; jobId?: string | null; submittedAt?: string | null; feedbackCount?: number; feedback?: FeedbackItem[] }
export interface ClassProgress { activities: { id: string; title: string; published: boolean; dueAt?: string | null }[]; pupils: { pupilId: string; displayName?: string; work: Record<string, { status: ActivityStatus; jobId?: string | null; submittedAt?: string | null; feedbackCount: number }> }[] }
export interface PupilWork { activityId: string; pupilId: string; status: ActivityStatus; jobId?: string | null; submittedAt?: string | null; feedback: FeedbackItem[]; files?: { id: string; status: string; createdAt: string; presetId: string }[] }
export type ActivityInput = { title?: string; instructions?: string; presetId?: string | null; dueAt?: string | null; published?: boolean };
const cls = (code: string) => `/classes/${encodeURIComponent(code)}`;
export const classActivities = (s: Session, code: string, f?: Fetch) => request<Activity[]>(s, "GET", `${cls(code)}/activities`, undefined, f);
export const createActivity = (s: Session, code: string, a: ActivityInput, f?: Fetch) => request<Activity>(s, "POST", `${cls(code)}/activities`, a, f);
export const updateActivity = (s: Session, code: string, id: string, a: ActivityInput, f?: Fetch) => request<Activity>(s, "PUT", `${cls(code)}/activities/${encodeURIComponent(id)}`, a, f);
export const archiveActivity = (s: Session, code: string, id: string, f?: Fetch) => request<null>(s, "DELETE", `${cls(code)}/activities/${encodeURIComponent(id)}`, undefined, f);
export const orderActivities = (s: Session, code: string, ids: string[], f?: Fetch) => request<Activity[]>(s, "POST", `${cls(code)}/activities-order`, { ids }, f);
export const copyActivities = (s: Session, intoCode: string, body: { fromClass: string; activityIds?: string[]; keepDueDates?: boolean; published?: boolean }, f?: Fetch) => request<Activity[]>(s, "POST", `${cls(intoCode)}/activities-copy`, body, f);
export const classProgress = (s: Session, code: string, f?: Fetch) => request<ClassProgress>(s, "GET", `${cls(code)}/progress`, undefined, f);
export const pupilWork = (s: Session, code: string, activityId: string, pupilId: string, f?: Fetch) => request<PupilWork>(s, "GET", `${cls(code)}/activities/${encodeURIComponent(activityId)}/work/${encodeURIComponent(pupilId)}`, undefined, f);
export const giveFeedback = (s: Session, code: string, activityId: string, pupilId: string, text: string, outcome: FeedbackItem["outcome"], f?: Fetch) => request<FeedbackItem>(s, "POST", `${cls(code)}/activities/${encodeURIComponent(activityId)}/work/${encodeURIComponent(pupilId)}/feedback`, { text, outcome }, f);
export const pupilFiles = (s: Session, code: string, pupilId: string, f?: Fetch) => request<(JobSummary & { origin: Origin })[]>(s, "GET", `${cls(code)}/pupils/${encodeURIComponent(pupilId)}/jobs`, undefined, f);
export const myActivities = (s: Session, f?: Fetch) => request<MyActivity[]>(s, "GET", "/activities", undefined, f);
export const myActivity = (s: Session, id: string, f?: Fetch) => request<MyActivity>(s, "GET", `/activities/${encodeURIComponent(id)}`, undefined, f);
export const submitActivity = (s: Session, id: string, jobId?: string, f?: Fetch) => request<PupilWork>(s, "POST", `/activities/${encodeURIComponent(id)}/submit`, jobId ? { jobId } : {}, f);

export const listPresets = (s: Session, f?: Fetch) => request<Preset[]>(s, "GET", "/presets", undefined, f);
export const sendJob = (s: Session, job: JobDoc, f?: Fetch) => request<Receipt>(s, "POST", "/jobs", job, f);
export const saveDraft = (s: Session, id: string, job: JobDoc, f?: Fetch) => request<Receipt>(s, "PUT", `/jobs/${encodeURIComponent(id)}`, job, f);
export const listQueue = (s: Session, station?: string, f?: Fetch) => request<QueueEntry[]>(s, "GET", station ? `/queue?station=${encodeURIComponent(station)}` : "/queue", undefined, f);
export const listStations = (s: Session, f?: Fetch) => request<StationInfo[]>(s, "GET", "/stations", undefined, f);
export const getJob = (s: Session, id: string, f?: Fetch) => request<JobSummary & { origin: Origin; station?: string | null }>(s, "GET", `/jobs/${encodeURIComponent(id)}`, undefined, f);
export const frameJob = (s: Session, id: string, station: string, opts: { skipQueue?: boolean } = {}, f?: Fetch) => request<{ bounds: { minX: number; minY: number; maxX: number; maxY: number } }>(s, "POST", `/jobs/${encodeURIComponent(id)}/frame`, { station, ...opts }, f);
export const assignJob = (s: Session, id: string, station: string, materialConfirmed: boolean, opts: { skipQueue?: boolean; allowUntested?: boolean } = {}, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/assign`, { station, materialConfirmed, ...opts }, f);
export const controlStation = (s: Session, station: string, command: "stop" | "pause" | "resume", f?: Fetch) => request<unknown>(s, "POST", `/stations/${encodeURIComponent(station)}/control`, { command }, f);
export const deferJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/defer`, undefined, f);
export const approveJob = (s: Session, id: string, station?: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/approve`, station ? { station } : {}, f);
export const rejectJob = (s: Session, id: string, reason: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/reject`, { reason }, f);
export const moveInQueue = (s: Session, id: string, body: { to?: "front" | "back" | "up" | "down"; position?: number }, f?: Fetch) => request<QueueEntry[]>(s, "POST", `/queue/${encodeURIComponent(id)}/move`, body, f);
export const listJobsByStatus = (s: Session, status: string, f?: Fetch) => request<JobSummary[]>(s, "GET", `/jobs?status=${encodeURIComponent(status)}`, undefined, f);

/** Where the camera picture sits on the bed, or null if a teacher has not calibrated this laser's camera yet. */
export async function getCalibration(s: Session, station: string, f?: Fetch): Promise<Calibration | null> {
  try { return await request<Calibration>(s, "GET", `/stations/${encodeURIComponent(station)}/camera-calibration`, undefined, f); }
  catch (e) { if (e instanceof ServerError && e.code === "not_calibrated") return null; throw e; }
}
export const putCalibration = (s: Session, station: string, cal: Pick<Calibration, "imageWidth" | "imageHeight" | "points" | "homography">, f?: Fetch) => request<Calibration>(s, "PUT", `/stations/${encodeURIComponent(station)}/camera-calibration`, cal, f);
export const deleteCalibration = (s: Session, station: string, f?: Fetch) => request<null>(s, "DELETE", `/stations/${encodeURIComponent(station)}/camera-calibration`, undefined, f);
/** Fix the design's place on the bed after lining it up on the camera picture. `matrix` is a move and turn only. */
export const placeJob = (s: Session, id: string, station: string, matrix: number[], opts: { skipQueue?: boolean } = {}, f?: Fetch) => request<{ bounds: { minX: number; minY: number; maxX: number; maxY: number } }>(s, "POST", `/jobs/${encodeURIComponent(id)}/placement`, { station, matrix, ...opts }, f);
export interface MarksRequest { centerX: number; centerY: number; sizeMm: number; spacingMm: number; count: 1 | 4; layer: "score" | "cut"; presetId: string }
/** A job of known squares to cut (approved and pinned to this laser), for calibrating its camera. Teacher only. */
export const createCalibrationMarks = (s: Session, station: string, body: MarksRequest, f?: Fetch) => request<{ jobId: string; squares: { square: number; corners: [number, number][] }[] }>(s, "POST", `/stations/${encodeURIComponent(station)}/calibration-marks`, body, f);
export type CutterKind = "practice" | "real";
export interface CutterPackage { station: string; token: string; kind: CutterKind; downloadPath: string; fileName: string; expiresAt: string }
/** A fresh token for one laser's Cutter and a short-lived download link for the Cutter software. School admins only. */
export const makeCutterPackage = (s: Session, station: string, kind: CutterKind = "practice", f?: Fetch) => request<CutterPackage>(s, "POST", "/cutter/package", { station, kind }, f);
/** Which Cutter downloads the server can offer: the practice one always, the real one once it has been built there. School admins only. */
export const cutterKinds = (s: Session, f?: Fetch) => request<Record<CutterKind, { available: boolean; fileName: string }>>(s, "GET", "/cutter/kinds", undefined, f);
/** The whole machine profile (shared/machine-profile.schema.json), so an edit keeps the fields the form does not show. */
export const getMachineDoc = (s: Session, id: string, f?: Fetch) => request<Record<string, unknown>>(s, "GET", `/machines/${encodeURIComponent(id)}`, undefined, f);
/** Add a laser (a new ID) or replace one's profile. Teachers and school admins. */
export const putMachine = (s: Session, doc: { id: string }, f?: Fetch) => request<Record<string, unknown>>(s, "PUT", `/machines/${encodeURIComponent(doc.id)}`, doc, f);
/** Remove a laser, its camera calibration and its tokens. School admins; refused while its Cutter is connected or files are waiting for it. */
export const deleteMachine = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/machines/${encodeURIComponent(id)}`, undefined, f);

/**
 * The command that starts the Cutter on a laser PC. The address must be the one the laser PC uses to reach the server.
 * The real Cutter is a Windows folder started by run_cutter.bat; the practice one is a Python script that runs anywhere.
 */
export function cutterCommand(url: string, token: string, station: string, kind: CutterKind = "real", shell: "windows" | "unix" = "windows"): string {
  const q = (v: string) => (/^[A-Za-z0-9_.:/@-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`);
  const args = `--url ${q(normaliseBase(url))} --token ${q(token)} --station ${q(station)}`;
  if (kind === "real") return `run_cutter.bat ${args}`;
  return `${shell === "windows" ? "python" : "python3"} fake_cutter.py ${args}`;
}
export interface MachineInfo { id: string; name: string; bed: { widthMm: number; heightMm: number; originCorner: string } }
export const listMachines = (s: Session, f?: Fetch) => request<MachineInfo[]>(s, "GET", "/machines", undefined, f);
export const getMachine = (s: Session, id: string, f?: Fetch) => request<MachineInfo>(s, "GET", `/machines/${encodeURIComponent(id)}`, undefined, f);

/** The latest camera picture as an object URL (the caller revokes it), or null when there is none. */
export async function cameraUrl(s: Session, station: string, f: Fetch = fetch): Promise<string | null> {
  try {
    const res = await f(`${s.baseUrl}/api/v1/stations/${encodeURIComponent(station)}/camera`, { headers: { Authorization: `Bearer ${s.token}` } });
    return res.ok ? URL.createObjectURL(await res.blob()) : null;
  } catch { return null; }
}
export const listJobs = (s: Session, f?: Fetch) => request<JobSummary[]>(s, "GET", "/jobs?mine=1", undefined, f); // always the signed-in person's own files (staff would otherwise get everyone's)
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

/** What to call a pupil on screen: the name DINO gave at sign-in (staff only), else the ID. */
export const pupilLabel = (id?: string | null, name?: string | null): string => (name?.trim() || id || "");

/** Ask the server to remember this person's display name (it asks DINO itself). Best effort: the ID is shown if it fails. */
export const sendProfile = (s: Session, f?: Fetch): Promise<{ name: string | null } | null> => request<{ name: string | null }>(s, "POST", "/auth/profile", undefined, f).catch(() => null);

/** What the top bar calls the signed-in person: their name, or (if DINO could not say) a shortened ID. */
export function personLabel(s: Pick<Session, "id" | "name">): string {
  const name = s.name?.trim();
  if (name) return name;
  return s.id.length > 12 ? `${s.id.slice(0, 8)}\u2026` : s.id;
}
