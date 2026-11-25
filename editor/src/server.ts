// Client for the Kerf Server (shared/openapi.yaml). The token and address live in this browser only.
import type { Terms } from "./termsform";
import type { Preset } from "./presets";
import type { JobDimension, JobDoc, JobObject, Origin } from "./job";
import type { Calibration } from "./alignlogic";

export interface Session { baseUrl: string; token: string; role: string; id: string; school?: string | null; /** "free" or "paid" (the queue, lasers, Station pages, camera, activities, approval). */ plan?: string | null; /** A Kerf site admin (the Platform). */ siteAdmin?: boolean; schoolCode?: string | null; /** What the school's plan gives it today (shared 0.2.47); absent from an older server. */ features?: { laser: boolean; activities: boolean } | null; limits?: Record<string, number | null> | null; classCode?: string; expiresAt?: string; /** Signed in with DINO: the access token is short-lived and renewed in place, and is never written to localStorage. */ sso?: boolean; /** Signed in with Kerf's own sign-in (staff email + password, an emailed link before passwords, a Pupil Card): kept for this tab only, never in localStorage. */ email?: boolean; /** Signed in with a Kerf staff password (shared 0.2.47): they may change it. */ password?: boolean;
  /** The person's DINO display name, kept in memory only (never stored here) so the top bar can show a name instead of an ID. Never an email. */
  name?: string }
export interface Receipt { ticket?: number | null; position?: number | null; id: string; status: string; warnings?: string[]; replaced?: { id: string; ticket?: number | null }[]; estimate?: { durationS?: number; percentUsed?: number; costSar?: number | null; partAreaMm2?: number; extentMm?: Extent } }
/** The size of the design itself (not the bed), in mm. */
export interface Extent { widthMm: number; heightMm: number }
export interface QueueEntry {
  extentMm?: Extent | null;
  ticket: number; jobId: string | null; status: string; position: number | null; own: boolean; pupilId?: string | null; /** Staff only: the name DINO gave at sign-in. */ pupilName?: string | null; presetId?: string;
  station?: string | null; framedOn?: string | null; next?: boolean; estimatedS?: number | null; aheadS?: number | null; approvedAt?: string | null;
  /** Staff only: the pupil's groups in the school, and the file's name (shared 0.2.47). */ pupilGroups?: { code: string; label?: string | null }[]; name?: string | null;
}
export interface StationInfo {
  id: string; online: boolean; state?: string | null; mpos?: number[] | null; currentJobId?: string | null; cutterVersion?: string | null;
  s30?: number | null; laserMode?: boolean | null; cameraAvailable?: boolean; calibrated?: boolean; lastSeen?: string | null;
  progress?: { jobId: string; line: number; totalLines: number; estimatedS?: number; actualS?: number } | null;
}
export interface JobSummary { name?: string | null; activityId?: string | null; pupilId?: string; pupilName?: string; /** Staff only (shared 0.2.47). */ pupilGroups?: { code: string; label?: string | null }[]; ticket?: number | null; objects: JobObject[]; dimensions?: JobDimension[]; origin: Origin; id: string; status: string; statusReason?: string; createdAt: string; preset: { id: string; version: number }; estimate?: Receipt["estimate"]; warnings?: string[]; source?: string }

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
    // a wrong Pupil Card or a used sign-in link is also a 401: keep the server's own words for those
    const own = e.code === "bad_login" || e.code === "link_invalid";
    const msg = res.status === 401 && !own ? "Your sign-in is not valid any more. Sign in again." : e.message ?? `The server answered ${res.status}.`;
    throw new ServerError(msg, res.status, e.code ?? "error", e.details);
  }
  return json as T;
}

export interface School { id: string; name: string; createdAt?: string; code?: string | null; plan?: "free" | "paid"; /** New files go straight to the queue while this is on. */ autoApprove?: boolean }
export interface StaffMember { role: "admin" | "teacher" | "technician" | "station"; id: string; label?: string | null; createdAt?: string }
export const listSchools = (s: Session, f?: Fetch) => request<School[]>(s, "GET", "/schools", undefined, f);
export interface SignInSettings {
  methods: Record<"dino" | "google" | "microsoft" | "groupCode" | "email", boolean>;
  googleDomain: string | null; microsoftTenant: string | null;
  /** Whether each method may be turned on yet (Google/Microsoft need Kerf registered with them). */
  canEnable: Record<string, boolean>;
  /** Whether each method's sign-in screen exists yet (the others can be set ahead). */
  available: Record<string, boolean>;
}
export const getSignIn = (s: Session, f?: Fetch) => request<SignInSettings>(s, "GET", "/school/sign-in", undefined, f);
export const setSignIn = (s: Session, change: { methods?: Partial<SignInSettings["methods"]>; googleDomain?: string | null; microsoftTenant?: string | null }, f?: Fetch) => request<SignInSettings>(s, "PATCH", "/school/sign-in", change, f);
/** Platform: set a school's plan (free or paid) or rename it. */
export const updateSchool = (s: Session, id: string, change: { plan?: "free" | "paid"; name?: string }, f?: Fetch) => request<School>(s, "PATCH", `/schools/${encodeURIComponent(id)}`, change, f);
/** Sending files to the laser (queue, approval, Station pages, camera) is open to this session's school. A session from an older server (no features) goes by its plan; no plan counts as paid. */
export const isPaid = (s: Session | null | undefined): boolean => !!s && (s.features ? s.features.laser : s.plan !== "free");
/** Activities and teacher feedback are open to this session's school. */
export const hasActivities = (s: Session | null | undefined): boolean => !!s && (s.features ? s.features.activities : s.plan !== "free");
/** What the plan gives a school today: `{features, limits, grants: [{label, until}], paid}`. */
export interface TermsNow { features: { laser: boolean; activities: boolean }; limits: Record<string, number | null>; grants: { label: string; until: string | null }[]; paid: boolean }
export const getDefaultTerms = (s: Session, f?: Fetch) => request<Terms>(s, "GET", "/platform/terms", undefined, f);
export const setDefaultTerms = (s: Session, t: Terms, f?: Fetch) => request<Terms>(s, "PUT", "/platform/terms", t, f);
export const getSchoolTerms = (s: Session, id: string, f?: Fetch) => request<{ plan: string; terms: Terms | null; now: TermsNow }>(s, "GET", `/schools/${encodeURIComponent(id)}/terms`, undefined, f);
export const setSchoolTerms = (s: Session, id: string, t: Terms, f?: Fetch) => request<{ plan: string; terms: Terms | null; now: TermsNow }>(s, "PUT", `/schools/${encodeURIComponent(id)}/terms`, t, f);
export const myTerms = (s: Session, f?: Fetch) => request<TermsNow>(s, "GET", "/school/terms", undefined, f);
export const createSchool = (s: Session, id: string, name: string, adminId?: string, f?: Fetch, adminEmail?: string) => request<School & { admin?: { id: string; token: string }; adminInvite?: StaffPerson }>(s, "POST", "/schools", { id, name, ...(adminId ? { adminId } : {}), ...(adminEmail ? { adminEmail } : {}) }, f);
/** Staff who sign in with an emailed link (shared 0.2.47). The email is shown to the school's admins only. */
export interface StaffPerson { id: string; email: string; role: "admin" | "teacher" | "technician"; name: string | null; status: "invited" | "active"; lastLogin: string | null; createdAt: string | null; /** Has chosen a Kerf password (shared 0.2.47). */ hasPassword?: boolean }
export const listStaffPeople = (s: Session, f?: Fetch) => request<StaffPerson[]>(s, "GET", "/staff/people", undefined, f);
export const inviteStaff = (s: Session, body: { email: string; role: StaffPerson["role"]; name?: string }, f?: Fetch) => request<StaffPerson>(s, "POST", "/staff/invite", body, f);
export const removeStaffPerson = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/staff/people/${encodeURIComponent(id)}`, undefined, f);
export const mySchool = (s: Session, f?: Fetch) => request<School>(s, "GET", "/school", undefined, f);
export const setAutoApprove = (s: Session, on: boolean, f?: Fetch) => request<School>(s, "PATCH", "/school", { autoApprove: on }, f);
/** School admins rename their own school (shared 0.2.47). Only the display name changes: the school ID and school code stay. */
export const renameSchool = (s: Session, name: string, f?: Fetch) => request<School>(s, "PATCH", "/school", { name }, f);
export const listStaff = (s: Session, f?: Fetch) => request<StaffMember[]>(s, "GET", "/staff", undefined, f);
export const addStaff = (s: Session, role: StaffMember["role"], id: string, label?: string, f?: Fetch) => request<{ role: string; id: string; token: string }>(s, "POST", "/staff", { role, id, ...(label ? { label } : {}) }, f);
export const revokeStaff = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/staff/${encodeURIComponent(id)}`, undefined, f);

/** End a session on the server (best effort: the token also expires by itself). */
export async function logout(s: Session, f: Fetch = fetch): Promise<void> {
  try { await f(`${s.baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` } }); } catch { /* offline: it will expire */ }
}

export interface ClassInfo { code: string; label: string | null; pupilCount: number; teacherId?: string | null; /** The teacher's name, when Kerf has one (shared 0.2.47). */ teacherName?: string | null; requireApproval?: boolean; joinCode?: string | null; archived?: boolean; source?: string; /** A laser group (picked by a school admin while the plan limits them). */ laser?: boolean; /** Pupils waiting to join (shared 0.2.47). */ joinRequests?: number }
export interface ClassPupil { pupilId: string; displayName?: string; lastLogin: string | null; locked: boolean }
export interface AddedPupils { /** New pupils and their two-word passwords (shown only now; `pin` is the same, for older code). */ created: { pupilId: string; pin: string; password?: string; displayName?: string }[]; /** Already in another group of the school: added to this one too, PIN unchanged. */ added?: string[]; /** Archived pupils brought back (files and PIN kept). */ restored?: string[]; existing: string[]; conflicts: string[] }
export interface GroupInfo { id: string; name: string; subject: string | null; yearGroup: string | null; pupils: string[] }
/** The teacher's classes with their pupil IDs (from DINO when signed in with DINO). */
export const listGroups = (s: Session, f?: Fetch) => request<GroupInfo[]>(s, "GET", "/groups", undefined, f);
/** A DINO class the teacher teaches, and the Kerf group it was imported as (shared 0.2.47). */
export interface DinoClass { id: string; name: string; subject: string | null; yearGroup: string | null; pupilCount: number; importedAs: string | null; archived?: boolean }
export const listDinoClasses = (s: Session, f?: Fetch) => request<DinoClass[]>(s, "GET", "/dino/classes", undefined, f);
export const importDinoClasses = (s: Session, ids: string[], f?: Fetch) => request<{ dinoId: string; code: string; name: string; already: boolean; pupils?: number; conflicts?: string[] }[]>(s, "POST", "/dino/classes/import", { ids }, f);
export const syncDinoClass = (s: Session, code: string, apply: boolean, f?: Fetch) => request<{ code: string; name: string; add: string[]; remove: string[]; applied: boolean; conflicts?: string[] }>(s, "POST", `/classes/${encodeURIComponent(code)}/dino-sync`, { apply }, f);
export const listClasses = (s: Session, f?: Fetch, archived = false) => request<ClassInfo[]>(s, "GET", archived ? "/classes?archived=true" : "/classes", undefined, f);
/** A blank code: Kerf makes one. */
export const createClass = (s: Session, code: string, label: string, requireApproval = true, f?: Fetch) => request<ClassInfo>(s, "POST", "/classes", { ...(code ? { code } : {}), label, requireApproval }, f);
export const updateClass = (s: Session, code: string, body: { label?: string; requireApproval?: boolean; joinCode?: string | null; archived?: boolean; laser?: boolean }, f?: Fetch) => request<ClassInfo>(s, "PUT", `/classes/${encodeURIComponent(code)}`, body, f);
export const classPupils = (s: Session, code: string, f?: Fetch) => request<ClassPupil[]>(s, "GET", `/classes/${encodeURIComponent(code)}/pupils`, undefined, f);
export const addPupils = (s: Session, code: string, pupilIds: string[], f?: Fetch) => request<AddedPupils>(s, "POST", `/classes/${encodeURIComponent(code)}/pupils`, { pupilIds }, f);
/** Add pupils by ID and/or name; `generate` more with IDs Kerf makes (shared 0.2.47). */
export const addPupilsDetailed = (s: Session, code: string, body: { pupils?: { id?: string; name?: string }[]; generate?: number }, f?: Fetch) => request<AddedPupils>(s, "POST", `/classes/${encodeURIComponent(code)}/pupils`, body, f);
/** New two-word passwords for a group's pupils (all, or these), for Pupil Cards. Old passwords stop working. */
export const newPasswords = (s: Session, code: string, pupilIds?: string[], f?: Fetch) => request<{ pupilId: string; password: string; displayName?: string }[]>(s, "POST", `/classes/${encodeURIComponent(code)}/passwords`, pupilIds ? { pupilIds } : {}, f);
/** A pupil's display name (empty clears it): staff and their own card only. */
export const setPupilName = (s: Session, code: string, pupilId: string, displayName: string, f?: Fetch) => request<{ pupilId: string; displayName: string | null }>(s, "PUT", `/classes/${encodeURIComponent(code)}/pupils/${encodeURIComponent(pupilId)}`, { displayName }, f);
export interface ArchivedPupil { pupilId: string; displayName?: string; archivedAt: string; lastGroup: string }
/** Pupils out of every group (archived: kept with their files, cannot sign in). */
export const archivedPupils = (s: Session, f?: Fetch) => request<ArchivedPupil[]>(s, "GET", "/pupils/archived", undefined, f);
/** School admins: delete an archived pupil and their files for good (logged). */
export const deletePupilForever = (s: Session, pupilId: string, f?: Fetch) => request<{ pupilId: string; filesDeleted: number }>(s, "DELETE", `/pupils/${encodeURIComponent(pupilId)}`, undefined, f);
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
export const createPreset = (s: Session, p: Preset, f?: Fetch) => request<Preset>(s, "POST", "/presets", p, f);
/** Every edit becomes the material's next version on the server; files already sent keep the version they were sent with. */
export const putPreset = (s: Session, p: Preset, f?: Fetch) => request<Preset>(s, "PUT", `/presets/${encodeURIComponent(p.id)}`, p, f);
export const sendJob = (s: Session, job: JobDoc, f?: Fetch) => request<Receipt>(s, "POST", "/jobs", job, f);
export const saveDraft = (s: Session, id: string, job: JobDoc, f?: Fetch) => request<Receipt>(s, "PUT", `/jobs/${encodeURIComponent(id)}`, job, f);
export const listQueue = (s: Session, station?: string, f?: Fetch) => request<QueueEntry[]>(s, "GET", station ? `/queue?station=${encodeURIComponent(station)}` : "/queue", undefined, f);
export const listStations = (s: Session, f?: Fetch) => request<StationInfo[]>(s, "GET", "/stations", undefined, f);
export const getJob = (s: Session, id: string, f?: Fetch) => request<JobSummary & { origin: Origin; station?: string | null }>(s, "GET", `/jobs/${encodeURIComponent(id)}`, undefined, f);
export const frameJob = (s: Session, id: string, station: string, opts: { skipQueue?: boolean } = {}, f?: Fetch) => request<{ bounds: { minX: number; minY: number; maxX: number; maxY: number } }>(s, "POST", `/jobs/${encodeURIComponent(id)}/frame`, { station, ...opts }, f);
export const assignJob = (s: Session, id: string, station: string, materialConfirmed: boolean, opts: { skipQueue?: boolean; allowUntested?: boolean } = {}, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/assign`, { station, materialConfirmed, ...opts }, f);
export const disconnectStation = (s: Session, station: string, f?: Fetch) => request<null>(s, "POST", `/stations/${encodeURIComponent(station)}/disconnect`, undefined, f);
export const takeJob = (s: Session, id: string, station: string, f?: Fetch) => request<{ id: string; station: string }>(s, "POST", `/jobs/${encodeURIComponent(id)}/take`, { station }, f);
export const markTested = (s: Session, presetId: string, station: string, tested = true, f?: Fetch) => request<Preset>(s, "POST", `/presets/${encodeURIComponent(presetId)}/tested`, { station, tested }, f);
export const controlStation = (s: Session, station: string, command: "stop" | "pause" | "resume", f?: Fetch) => request<unknown>(s, "POST", `/stations/${encodeURIComponent(station)}/control`, { command }, f);
export const deferJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/defer`, undefined, f);
export const approveJob = (s: Session, id: string, station?: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/approve`, station ? { station } : {}, f);
export const rejectJob = (s: Session, id: string, reason: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/reject`, { reason }, f);
export const moveInQueue = (s: Session, id: string, body: { to?: "front" | "back" | "up" | "down"; position?: number }, f?: Fetch) => request<QueueEntry[]>(s, "POST", `/queue/${encodeURIComponent(id)}/move`, body, f);
export const listJobsByStatus = (s: Session, status: string, f?: Fetch, limit?: number) => request<JobSummary[]>(s, "GET", `/jobs?status=${encodeURIComponent(status)}${limit ? `&limit=${limit}` : ""}`, undefined, f);
/** Staff: change a waiting file's material without the pupil sending it again (it keeps its place). */
export const changeJobPreset = (s: Session, id: string, presetId: string, f?: Fetch) => request<Receipt>(s, "PUT", `/jobs/${encodeURIComponent(id)}/preset`, { presetId }, f);
/** Staff: put a processed file (cut, failed, cancelled or rejected) back at the end of the queue. */
export const requeueJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/requeue`, undefined, f);
/** Staff: remove a material from the catalogue (refused while waiting or queued files use it). */
export const deletePreset = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/presets/${encodeURIComponent(id)}`, undefined, f);

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
export type CutterKind = "practice" | "creality-falcon";
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
 * The Creality Falcon Cutter (kind "creality-falcon") is a Windows folder started by run_cutter.bat; the practice one is a Python script that runs anywhere.
 */
export function cutterCommand(url: string, token: string, station: string, kind: CutterKind = "creality-falcon", shell: "windows" | "unix" = "windows"): string {
  const q = (v: string) => (/^[A-Za-z0-9_.:/@-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`);
  const args = `--url ${q(normaliseBase(url))} --token ${q(token)} --station ${q(station)}`;
  if (kind === "creality-falcon") return `run_cutter.bat ${args}`;
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
/** Rename a file (its owner, any state). An empty name clears it. */
export const renameJob = (s: Session, id: string, name: string | null, f?: Fetch) => request<{ id: string; name: string | null }>(s, "PUT", `/jobs/${encodeURIComponent(id)}/name`, { name }, f);
/** Delete a file (its owner): drafts and cancelled or failed files. The server says why when it will not. */
export const deleteJob = (s: Session, id: string, f?: Fetch) => request<null>(s, "DELETE", `/jobs/${encodeURIComponent(id)}`, undefined, f);

/** The files a person has open (their tabs), kept on the server so another browser shows the same ones. */
export interface WorkspaceTab { jobId: string; name?: string | null; renamed?: boolean }
export interface RemoteWorkspace { tabs: WorkspaceTab[]; active: string | null; updatedAt: string | null }
export const getWorkspace = (s: Session, f?: Fetch) => request<RemoteWorkspace>(s, "GET", "/workspace", undefined, f);
export const putWorkspace = (s: Session, w: { tabs: WorkspaceTab[]; active: string | null }, f?: Fetch) => request<RemoteWorkspace>(s, "PUT", "/workspace", w, f);

export const cancelJob = (s: Session, id: string, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/cancel`, undefined, f);
/** Send a draft for cutting. `acceptOpenPaths` says the pupil was warned about open Cut paths and chose to send anyway. */
export const submitJob = (s: Session, id: string, acceptOpenPaths = false, f?: Fetch) => request<Receipt>(s, "POST", `/jobs/${encodeURIComponent(id)}/submit`, acceptOpenPaths ? { acceptOpenPaths: true } : undefined, f);

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
