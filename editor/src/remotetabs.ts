// Open tabs that follow the person from browser to browser. The server keeps the list of files they have open (RemoteWorkspace); this
// turns that list plus whatever this browser kept locally (Mirror) into the tabs to show. Pure: the caller fetches the files.
//
// Per file in the server's list:
//  - this browser has it with unsaved edits  -> keep this browser's copy (autosave will send it)
//  - this browser has it and it matches the server's file -> keep this browser's copy (it also remembers groups and live text, which the job format cannot)
//  - otherwise (new here, or changed on another browser) -> the server's file
// Files only this browser knows about (never saved, or with unsaved edits) are kept at the end, so nothing is ever lost by signing in elsewhere.
import { Doc, type DocState } from "./doc";
import { buildJob, fromJobDimension, fromJobObjects, type JobObject, type Origin } from "./job";
import type { JobSummary, RemoteWorkspace } from "./server";
import { DEFAULT_ORIGIN, designName, fileKey, isDirty, type FileMeta, type Mirror, type MirrorTab } from "./workspace";

/** JSON with sorted keys, so two copies of the same data compare equal whatever order a database gave the keys back in. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

type ServerJob = JobSummary & { origin?: Origin };

/** Does the server's file hold what this tab holds (in the job format)? */
export function sameContent(state: DocState, job: Pick<ServerJob, "objects" | "preset" | "dimensions">): boolean {
  if (!state.objects.length) return false;
  const mine = buildJob({ objects: state.objects, dimensions: state.dimensions, presetId: state.materialId, pupilId: "x", origin: DEFAULT_ORIGIN, submit: false });
  return canon(mine.objects) === canon(job.objects as JobObject[]) && canon(mine.dimensions ?? []) === canon(job.dimensions ?? []) && mine.preset.id === job.preset.id;
}

/** A tab made from a file on the server (groups and live text are not in the job format, so they are plain shapes here). */
export function tabFromJob(job: ServerJob, name: string, renamed: boolean): MirrorTab {
  const d = new Doc();
  d.state.materialId = job.preset.id;
  for (const sh of fromJobObjects(job.objects)) {
    const o = d.add(sh.path, sh.matrix, sh.layer);
    if (sh.tabs) o.tabs = sh.tabs;
    if (sh.settings) o.settings = sh.settings;
  }
  d.state.dimensions = (job.dimensions ?? []).map(fromJobDimension);
  const meta: FileMeta = { jobId: job.id, origin: job.origin ?? DEFAULT_ORIGIN, savedKey: fileKey(d.state), openedLocal: null, sourceId: null };
  return { name, renamed, state: d.state, meta };
}

export async function mergeRemoteTabs(opts: {
  local: Mirror | null;
  remote: RemoteWorkspace;
  loadJob: (id: string) => Promise<ServerJob | null>;
}): Promise<Mirror | null> {
  const { local, remote, loadJob } = opts;
  const mine = new Map<string, MirrorTab>();
  for (const t of local?.tabs ?? []) if (t.meta.jobId) mine.set(t.meta.jobId, t);

  const fromServer = await Promise.all(remote.tabs.map(async (r): Promise<MirrorTab | null> => {
    const lt = mine.get(r.jobId);
    const name = (r.name ?? "").trim();
    if (lt && isDirty(lt.state, lt.meta.savedKey)) return { ...lt, name: name || lt.name, renamed: r.renamed ?? lt.renamed };
    const job = await loadJob(r.jobId);
    if (!job) return lt ? { ...lt, name: name || lt.name } : null; // the server cannot say: keep what this browser has
    if (job.status !== "draft") return null; // sent or finished since: not something to keep editing
    if (lt && sameContent(lt.state, job)) return { ...lt, name: name || lt.name, renamed: r.renamed ?? lt.renamed };
    return tabFromJob(job, name || job.name || designName(job.createdAt), r.renamed === true);
  }));

  const tabs = fromServer.filter((t): t is MirrorTab => t !== null);
  const listed = new Set(remote.tabs.map((t) => t.jobId));
  for (const t of local?.tabs ?? []) { // only this browser knows about these
    if (t.meta.jobId && listed.has(t.meta.jobId)) continue;
    if ((!t.meta.jobId && t.state.objects.length) || (t.meta.jobId && isDirty(t.state, t.meta.savedKey))) tabs.push(t);
  }
  if (!tabs.length) return null;
  const at = remote.active ? tabs.findIndex((t) => t.meta.jobId === remote.active) : -1;
  const localActive = local?.tabs[local.active]?.meta.jobId;
  const byLocal = localActive ? tabs.findIndex((t) => t.meta.jobId === localActive) : -1;
  return { v: 1, savedAt: new Date().toISOString(), active: at >= 0 ? at : byLocal >= 0 ? byLocal : 0, tabs };
}
