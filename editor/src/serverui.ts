// Pupil sign-in and their files on the server: Save, Send for cutting, My files (open / send / cancel).
// All talking is in server.ts; the job document is built and read back in job.ts.
import { infoDialog, openDialog } from "./dialog";
import { sizeText } from "./stationlogic";
import { openMyActivities } from "./activitiesui";
import { closeStation, openStation, openStationPicker } from "./stationui";
import { addLocal, listLocal, removeLocal, type LocalDraft } from "./localdrafts";
import type { Dimension } from "./dimensions";
import type { DocObject } from "./doc";
import { ANCHORS, buildJob, fromJobDimension, fromJobObjects, type Anchor, type LoadedShape, type Origin } from "./job";
import { DEFAULT_ORIGIN, blankMeta, designName, fileKey, type ClosedFile, type FileMeta, type FileRef } from "./workspace";
import { setPresets } from "./presets";
import { Renewer, SsoError, beginSignIn, cleanAddress, endSignIn, fetchAuthConfig, finishSignIn, readCallback, restoreSignIn, type AuthConfig, type Tokens } from "./sso";
import {
  STATUS_TEXT, ServerError, personLabel, cancelJob, deleteJob, getJob, getWorkspace, putWorkspace, renameJob, type RemoteWorkspace, type WorkspaceTab, myActivity, submitActivity, type MyActivity, logout, describeDuration, listJobs, listPresets, listQueue, queueText, type QueueEntry, request, saveDraft, saveSession, sendJob, submitJob,
  type JobSummary, type Session,
} from "./server";

export interface ServerUiContext {
  objects: () => DocObject[];
  dimensions: () => Dimension[];
  materialId: () => string;
  /** The title to save the file under (the tab's name), or null while it is still called "Untitled". */
  fileName: () => string | null;
  /** Why the design can't be sent right now (out of bounds, empty...), or null. */
  blocker: () => string | null;
  notify: (msg: string) => void;
  presetsChanged: () => void;
  /** Replace the page with these shapes (and material), as one undoable step. */
  load: (shapes: LoadedShape[], materialId: string | null, dimensions: Dimension[]) => void;
  /** Empty the page (used on sign-out so the next pupil never sees it). Closes every file tab too. */
  clear: () => void;
  /** The file tabs. Opening a file that is already open in a tab switches to it instead of opening it twice. */
  tabs: {
    /** Switch to the tab holding this file, if there is one. */
    show: (ref: FileRef) => boolean;
    /** Get a blank page for a file about to be loaded, named `name`: a new tab, or the current one if it is empty and unsaved. */
    openBlank: (name: string) => void;
    /** Is there anything unsaved in a tab that is not showing? */
    othersDirty: () => boolean;
    /** The server panel's view of the file changed (saved, sent, opened): refresh the tab labels. */
    changed: () => void;
    /** Bring back the tabs kept in this browser for this owner (a pupil ID, or "offline"). True if there were any. */
    restore: (owner: string) => Promise<boolean>;
    /** A file was renamed or deleted in My files: keep any tab showing it in step. */
    setName: (jobId: string, name: string) => void;
    closeFile: (jobId: string) => void;
    /** Write the open tabs to this browser now. */
    persist: () => void;
    /** The files open in tabs now. */
    listOpen: () => { tabId: number; name: string; shapes: number; jobId: string | null; dirty: boolean }[];
    showTabById: (id: number) => void;
    /** Files kept in this browser from tabs that were closed, for this person only. */
    listClosed: (owner: string) => ClosedFile[];
    openClosed: (owner: string, id: string) => boolean;
    deleteClosed: (owner: string, id: string) => void;
  };
}

const $ = (id: string) => document.getElementById(id)!;
const problem = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ServerUiHandle {
  session: () => Session | null;
  /** The file in the tab that is showing, and a way to give the panel another tab's file. */
  /** Who the open tabs belong to: the signed-in ID, or "offline". */
  owner: () => string;
  /** The file in the tab showing now (the live object: saves write to it), and a way to give the panel another tab's file. */
  getFile: () => FileMeta;
  setFile: (m: FileMeta) => void;
  isDirty: () => boolean;
  /** The page may have changed: schedule a save to the server. */
  noteChange: () => void;
  /** Save the file showing now without waiting. */
  flushNow: () => Promise<void>;
  /** Tell the panel whether the copy kept in this browser worked (false when the browser's storage is full). */
  setLocalOk: (ok: boolean) => void;
  /** Rename a file on the server (a tab was renamed). */
  renameFile: (jobId: string, name: string) => void;
  /** The tabs the person has open, as last kept on the server; null if there is none or the server cannot be reached. */
  loadWorkspace: () => Promise<RemoteWorkspace | null>;
  /** Keep the open tabs on the server (best effort). */
  saveWorkspace: (w: { tabs: WorkspaceTab[]; active: string | null }) => Promise<boolean>;
  /** One of the person's own files from the server, or null. */
  loadJob: (id: string) => Promise<Awaited<ReturnType<typeof getJob>> | null>;
}

export function initServerUi(ctx: ServerUiContext): ServerUiHandle {
  let session: Session | null = null; saveSession(null); // an older version kept a pasted token here; only DINO sign-in is left
  let offline = false;
  /** The file in the tab that is showing (swapped by `setFile` when another tab is shown; saves hold on to the object they started on). */
  let cur: FileMeta = blankMeta();
  /** The class activity new saves are for (null: none). */
  let activity: { id: string; title: string } | null = null;
  const defaultBase = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";

  /** A fingerprint of the page, to tell whether there is anything unsaved. */
  const key = () => fileKey({ materialId: ctx.materialId(), objects: ctx.objects(), dimensions: ctx.dimensions() });
  const dirty = () => ctx.objects().length > 0 && key() !== cur.savedKey;
  const markSaved = (f: FileMeta = cur, k: string = key()) => { f.savedKey = k; };
  const confirmDiscard = (what: string) => !(dirty() || ctx.tabs.othersDirty()) || confirm(`You have changes that are not saved. ${what} anyway?`);

  const render = () => {
    const signedIn = !!session;
    $("gate").hidden = signedIn || offline;
    const person = $("srv-status") as HTMLButtonElement; // the signed-in person's menu (My files, Activities, Admin site, Sign out)
    if (signedIn) {
      delete person.dataset.direct;
      person.title = `Signed in as ${personLabel(session!)}`;
      person.replaceChildren(Object.assign(document.createElement("span"), { textContent: personLabel(session!) }), document.createTextNode(" \u25be"));
    } else {
      person.dataset.direct = "1"; // nobody to show a menu for: the button itself signs in
      person.title = offline ? "Working offline: nothing is saved to the server. Click to sign in." : "Sign in";
      person.textContent = "Sign in";
    }
    ($("srv-files") as HTMLButtonElement).hidden = false; // everyone signed in has files of their own (staff look at pupils' files on the Admin site)
    ($("srv-activities") as HTMLButtonElement).hidden = session?.role !== "pupil";
    const act = $("srv-activity") as HTMLElement;
    act.hidden = !(session?.role === "pupil" && activity);
    act.replaceChildren(...(activity ? [document.createTextNode(`Activity: ${activity.title} `), Object.assign(document.createElement("button"), { textContent: "×", title: "Stop saving files for this activity", onclick: () => { activity = null; render(); } })] : []));
    ($("srv-admin") as HTMLAnchorElement).hidden = session?.role !== "teacher" && session?.role !== "admin";
    $("srv-file").textContent = signedIn && cur.jobId ? `Editing ${cur.jobId}` : "";
    ctx.tabs.changed();
    showSaveState();
  };

  /** Keeps a DINO sign-in renewed while it is the current session. */
  let renewer: Renewer | null = null;
  const dropSession = () => {
    activity = null;
    if (session?.sso) void endSignIn("editor"); // a DINO session: end the connection there too
    else if (session?.expiresAt) void logout(session); // a class-login session: end it on the server too
    renewer?.stop(); renewer = null;
    session = null; saveSession(null); cur.jobId = null; render(); };
  const keepAlive = (next: Session, tokens: Tokens) => {
    renewer?.stop();
    renewer = new Renewer("editor", next, tokens, (why) => { dropSession(); ctx.notify(why); });
  };
  const handle = (e: unknown): string => {
    if (e instanceof ServerError && e.status === 401) dropSession();
    return problem(e);
  };

  async function loadPresets(): Promise<void> {
    if (!session) return;
    try { setPresets(await listPresets(session)); ctx.presetsChanged(); } catch (e) { ctx.notify(`Couldn't load materials: ${handle(e)}`); }
  }

  /** Is the Station page showing instead of the design Editor? */
  let stationMode = false;
  /** The laser a technician or admin chose (the Admin site links to `/?station=<id>`; it survives the trip to DINO and back in this tab). */
  const wantedStation = (): string | null => { try { return sessionStorage.getItem("kerf.station"); } catch { return null; } };
  const wantStation = (id: string | null): void => { try { if (id) sessionStorage.setItem("kerf.station", id); else sessionStorage.removeItem("kerf.station"); } catch { /* fine */ } };
  // The laser lives in the address (`/?station=station-1`) while the Station page is open, so a reload keeps it and the plain Editor address
  // ("/") never inherits it. It is kept in sessionStorage only for the trip to DINO and back (that return address has `code=`).
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("station")) wantStation(q.get("station"));
    else if (!q.get("code") && !q.get("error")) wantStation(null);
  } catch { /* fine */ }
  const showStationInAddress = (id: string | null): void => { try { history.replaceState(null, "", id ? `/?station=${encodeURIComponent(id)}` : location.pathname); } catch { /* fine */ } };

  /** A technician always gets the Station page (and picks the laser); an admin or teacher gets it when they follow a station link; everyone else gets the design Editor. */
  function enterRole(): void {
    stationMode = false;
    const role = session?.role;
    if (!session || role === "pupil") { closeStation(); return; }
    if (role === "platform") { location.assign("/admin/"); return; }
    const id = wantedStation();
    if (role === "technician" || id) {
      stationMode = true;
      $("gate").hidden = true;
      const s = session;
      const choose = () => { wantStation(null); openStationPicker(s, (pick) => { wantStation(pick); enterRole(); }, signOut); };
      if (id) { showStationInAddress(id); openStation(s, signOut, { stationId: id, onOtherStation: choose }); }
      else { showStationInAddress(null); choose(); }
    } else { showStationInAddress(null); closeStation(); }
  }

  /** Everything after a successful sign-in, however it happened. */
  async function signedIn(next: Session): Promise<void> {
    session = next;
    saveSession(session);
    offline = false;
    render();
    await loadPresets();
    enterRole();
    if (stationMode) return;
    ctx.notify(`Signed in as ${session.id}`);
    const restored = await ctx.tabs.restore(session.id); // the tabs this person had open last time (on this or another browser)
    if (session.role === "pupil" && !restored) void files(true);
  }

  /** The only way in is DINO. The sign-in page asks the server how to reach it. */
  let authConfig: AuthConfig = { mode: "planner", sso: null };

  async function startDino(): Promise<void> {
    const err = $("gate-error");
    err.textContent = "";
    try {
      const base = (($("gate-url") as HTMLInputElement).value);
      const c = authConfig.sso ? authConfig : await fetchAuthConfig(base);
      if (!c.sso) throw new SsoError("Can't reach the server's DINO sign-in settings. Check the address and your network.");
      authConfig = c;
      await beginSignIn("editor", base, c.sso, location, (url) => location.assign(url));
    } catch (e) { err.textContent = problem(e); }
  }

  const currentJob = () => buildJob({ objects: ctx.objects(), dimensions: ctx.dimensions(), activityId: session!.role === "pupil" ? activity?.id ?? null : undefined, pupilId: session!.id, presetId: ctx.materialId(), origin: cur.origin, name: ctx.fileName(), submit: false });

  /** What went wrong, in words, with the server's own list of problems when it gave one. */
  const explain = (e: unknown): string[] => [handle(e), ...(e instanceof ServerError && e.details ? e.details.slice(0, 5).map((d) => `${d.path || "the job"}: ${d.message}`) : [])];

  /** The server did not take the design: keep it in this browser instead, and say so. Returns the lines for the dialog. */
  function keepLocally(e: unknown): string[] {
    let kept: LocalDraft | null = null;
    try { kept = addLocal(currentJob(), explain(e).join(" "), undefined); } catch { /* nothing to keep */ }
    return [...explain(e), kept
      ? "Your design is safe: it is kept on this computer, in My files under 'On this computer'. Open it there, and save it to the server when the problem is fixed."
      : "It could not be kept on this computer either (the browser's storage is full or blocked). Use Export DXF to keep your work."];
  }

  /** Saves of one file run one after the other, and write to the file they started on even if another tab is showing by then. */
  const chain = new WeakMap<FileMeta, Promise<unknown>>();

  /** Make sure there is a draft on the server holding the design as it is now. Returns its id. */
  function saveCurrent(): Promise<string> {
    const f = cur, job = currentJob(), k = key(), s = session!; // taken now: the page may change while we wait
    const run = (chain.get(f) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<string> => {
      if (f.jobId) {
        try { await saveDraft(s, f.jobId, job); markSaved(f, k); ctx.tabs.changed(); return f.jobId; } catch (e) {
          if (!(e instanceof ServerError && (e.status === 409 || e.status === 404))) throw e; // the draft was sent or cancelled meanwhile: start a new one
          f.jobId = null;
        }
      }
      const r = await sendJob(s, job);
      f.jobId = r.id;
      if (f.openedLocal) { removeLocal(f.openedLocal); f.openedLocal = null; } // it reached the server: the local copy is no longer needed
      markSaved(f, k);
      render();
      return r.id;
    });
    chain.set(f, run.catch(() => undefined));
    return run;
  }

  // ---- autosave: every change goes to the server a moment later (and to this browser at once, see main.ts) ----
  const AUTOSAVE_MS = 1500;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 0;
  let saving = 0;
  let localOk = true;
  type SaveState = "idle" | "saving" | "saved" | "failed";
  let saveState: SaveState = "idle";
  const showSaveState = () => {
    const el = $("srv-save-state");
    const extra = localOk ? "" : " Too big to keep on this computer as well.";
    el.hidden = false;
    if (!session) { el.textContent = offline ? `Kept on this computer.${extra}` : ""; el.className = ""; return; }
    if (stationMode) { el.hidden = true; return; }
    el.className = saveState === "failed" || !localOk ? "bad" : "";
    el.textContent = saveState === "saving" ? "Saving…"
      : saveState === "failed" ? `Not on the server yet: kept on this computer, trying again.${extra}`
      : saveState === "saved" ? `All changes saved.${extra}`
      : ctx.objects().length ? `Not saved yet.${extra}` : extra.trim();
  };

  /** Save the page to the server now if there is anything new. Never throws: a failure is shown and retried. */
  async function autosave(): Promise<void> {
    clearTimeout(autoTimer); autoTimer = undefined;
    if (!session || stationMode || !ctx.objects().length || key() === cur.savedKey) { showSaveState(); return; }
    saving++; saveState = "saving"; showSaveState();
    try {
      await saveCurrent();
      retryMs = 0;
      saveState = "saved";
    } catch (e) {
      saveState = "failed";
      if (e instanceof ServerError && e.status === 401) dropSession();
      else { retryMs = Math.min(retryMs ? retryMs * 2 : 5000, 60000); autoTimer = setTimeout(() => void autosave(), retryMs); }
    } finally {
      saving--;
      if (!saving && saveState === "saving") saveState = "idle";
      showSaveState();
      if (!autoTimer && dirty()) noteChange(); // edited while we were saving
    }
  }

  /** Called often (by main.ts, a few times a second after anything is drawn): schedule a save when the page differs from the last saved version. */
  function noteChange(): void {
    if (!session || stationMode) { showSaveState(); return; }
    if (!dirty()) { if (saveState === "saved") showSaveState(); return; }
    if (autoTimer) clearTimeout(autoTimer);
    if (saveState !== "failed") { saveState = "idle"; showSaveState(); }
    autoTimer = setTimeout(() => void autosave(), AUTOSAVE_MS);
  }

  /** Save the file showing now without waiting, e.g. before switching tabs or signing out. */
  const flushNow = (): Promise<void> => autosave();

  async function send(): Promise<void> {
    const why = ctx.blocker();
    if (why) { ctx.notify(why); return; }
    // a new send replaces the pupil's earlier file that is still waiting, and goes to the back of the queue
    let waiting: JobSummary[] = [];
    try { waiting = (await listJobs(session!)).filter((j) => ["submitted", "approved"].includes(j.status)); } catch { /* the warning is only a courtesy */ }
    const replaceNote = waiting.length
      ? ` You already have ${waiting.length === 1 ? "a file" : `${waiting.length} files`} waiting${waiting.some((j) => j.ticket != null) ? ` (ticket ${waiting.map((j) => j.ticket).filter((t) => t != null).join(", ")})` : ""}: sending this replaces ${waiting.length === 1 ? "it" : "them"}, and you go to the back of the queue.`
      : "";
    const v = await openDialog("Send for cutting", [
      { key: "place", label: "Place it", type: "select", value: cur.origin.mode === "absolute" ? "bed" : "head", options: [{ value: "head", label: "Where the laser head is at the station" }, { value: "bed", label: "Exactly where it is on this bed" }],
        hint: "At the station you line your material up with the laser head, so 'where the laser head is' is usually what you want." },
      { key: "anchor", label: "Laser head goes at its", type: "select", value: cur.origin.mode === "current-position" ? cur.origin.anchor : "bottom-left", options: ANCHORS.map((a) => ({ value: a.value, label: a.label })) },
    ], { ok: "Send", intro: `You are ${session!.id}. Your design is saved, then cleaned and checked on the server. A teacher sees it in the queue, approves it and chooses which laser cuts it.${replaceNote}` });
    if (!v) return;
    cur.origin = v.place === "bed" ? { mode: "absolute" } : { mode: "current-position", anchor: v.anchor as Anchor };
    const button = $("srv-send") as HTMLButtonElement;
    button.disabled = true;
    try {
      const id = await saveCurrent();
      const r = await submitJob(session!, id);
      cur.jobId = null; // it is now in the queue: further changes are a new file
      render();
      const est = r.estimate;
      const facts = [`File number ${r.id}`, STATUS_TEXT[r.status] ?? r.status];
      const q = queueText(r.ticket, r.position);
      if (q) facts.push(q);
      if (r.replaced?.length) facts.push(`This replaced your earlier file${r.replaced.length > 1 ? "s" : ""} ${r.replaced.map((x) => x.id + (x.ticket != null ? ` (ticket ${x.ticket})` : "")).join(", ")}, so you start from the back of the queue.`);
      if (est?.extentMm) facts.push(`Design size ${sizeText(est.extentMm)}`);
      if (est?.durationS) facts.push(`About ${describeDuration(est.durationS)} to cut`);
      if (est?.percentUsed !== undefined) facts.push(`Uses ${est.percentUsed}% of the sheet${est.costSar != null ? `, about ${est.costSar} SAR` : ""}`);
      await infoDialog("Sent", [...facts, ...(r.warnings ?? []).map((w) => `Note: ${w}`)]);
    } catch (e) {
      if (cur.jobId) await infoDialog("Not sent", [...explain(e), "Your design is still saved as a draft in My files."]); // it did reach the server as a draft
      else await infoDialog("Not sent", keepLocally(e));
    } finally {
      button.disabled = false;
    }
  }

  function open(j: JobSummary, close: () => void): void {
    if (ctx.tabs.show({ jobId: j.status === "draft" ? j.id : null, sourceId: j.id })) { ctx.notify(`${j.id} is already open: switched to its tab.`); close(); return; } // never two versions of one file
    ctx.tabs.openBlank(j.name || designName(j.createdAt, j.status !== "draft"));
    ctx.load(fromJobObjects(j.objects), j.preset.id, (j.dimensions ?? []).map(fromJobDimension));
    cur.origin = j.origin ?? DEFAULT_ORIGIN;
    cur.jobId = j.status === "draft" ? j.id : null; // only a draft can be changed; anything else opens as a copy
    cur.sourceId = j.status === "draft" ? null : j.id;
    cur.openedLocal = null;
    activity = null;
    if (j.activityId && session?.role === "pupil") {
      activity = { id: j.activityId, title: "…" };
      void myActivity(session, j.activityId).then((a) => { if (activity?.id === a.id) { activity = { id: a.id, title: a.title }; render(); } }).catch(() => {});
    }
    markSaved();
    render();
    ctx.notify(j.status === "draft" ? `Opened ${j.id}` : `Opened a copy of ${j.id}. Save to keep your changes as a new file.`);
    close();
  }

  async function files(auto = false): Promise<void> {
    if (!session) return;
    const me = session.id; // only this person's files: the browser lists are keyed by their ID
    let jobs: JobSummary[];
    try { jobs = await listJobs(session); } catch (e) { await infoDialog("Couldn't load your files", [handle(e)]); return; }
    let local = listLocal(me);
    if (auto && !jobs.length && !local.length && !ctx.tabs.listClosed(me).length) return; // nothing to show a new pupil yet
    let queued = new Map<string, QueueEntry>();
    try { queued = new Map((await listQueue(session)).filter((q) => q.jobId).map((q) => [q.jobId!, q])); } catch { /* the list still works without queue places */ }
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog wide";
    dlg.innerHTML = `<h2>My files</h2><p class="hint">${me}. Open a file to keep working on it, or send it for cutting.</p>`;
    const tabsBar = document.createElement("div");
    tabsBar.className = "seg";
    tabsBar.setAttribute("role", "tablist");
    const body = document.createElement("div");
    dlg.append(tabsBar, body);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => dlg.close());
    dlg.append(close);
    let view: "server" | "browser" = auto && !jobs.length ? "browser" : "server";

    const mkRow = (text: string) => {
      const row = document.createElement("div");
      row.className = "filerow";
      const info = document.createElement("span");
      info.textContent = text;
      row.append(info);
      const add = (label: string, run: () => Promise<void> | void, cls = "") => {
        const b = document.createElement("button");
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", async () => { b.disabled = true; try { await run(); } catch (e) { ctx.notify(handle(e)); } b.disabled = false; });
        row.append(b);
      };
      return { row, add };
    };
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

    const drawServer = () => {
      if (!jobs.length) body.append(Object.assign(document.createElement("p"), { textContent: "You haven't saved anything on the server yet." }));
      for (const j of jobs) {
        const est = j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : "";
        const reason = j.statusReason && j.status !== "done" ? ` (${j.statusReason})` : "";
        const place = queued.get(j.id);
        const where = j.status === "approved" ? queueText(j.ticket ?? place?.ticket, place?.position, place?.aheadS) : j.ticket != null ? `Ticket ${j.ticket}` : "";
        const { row, add } = mkRow(`${where ? where + " · " : ""}${j.name || designName(j.createdAt)} · ${j.preset.id} · ${new Date(j.createdAt).toLocaleString()}${est} · ${STATUS_TEXT[j.status] ?? j.status}${reason}`);
        row.title = j.id;
        add(j.status === "draft" ? "Open" : "Open a copy", () => open(j, () => dlg.close()));
        add("Rename", async () => {
          const v = await openDialog("Rename file", [{ key: "name", label: "Name", type: "text", value: j.name || designName(j.createdAt) }], { intro: "A name for you to find it by. It does not change the design.", ok: "Rename" });
          if (!v) return;
          const r = await renameJob(session!, j.id, String(v.name).trim().slice(0, 60) || null);
          j.name = r.name;
          ctx.tabs.setName(j.id, r.name || designName(j.createdAt));
          draw();
        });
        if (j.status === "draft") add("Send for cutting", async () => { const r = await submitJob(session!, j.id); j.status = r.status; j.warnings = r.warnings; if (cur.jobId === j.id) cur.jobId = null; render(); draw(); });
        if (["draft", "cancelled", "failed"].includes(j.status)) add("Delete", async () => {
          if (!confirm(`Delete "${j.name || designName(j.createdAt)}"? It cannot be brought back.`)) return;
          await deleteJob(session!, j.id);
          jobs = jobs.filter((x) => x.id !== j.id);
          ctx.tabs.closeFile(j.id);
          ctx.notify("Deleted.");
          draw();
        }, "danger");
        if (["draft", "submitted", "approved"].includes(j.status)) add("Cancel", async () => { const r = await cancelJob(session!, j.id); j.status = r.status; if (cur.jobId === j.id) cur.jobId = null; render(); draw(); });
        body.append(row);
      }
    };

    const drawBrowser = () => {
      const open = ctx.tabs.listOpen().filter((t) => t.shapes > 0 || t.jobId);
      const closed = ctx.tabs.listClosed(me);
      const h = (t: string) => body.append(Object.assign(document.createElement("h3"), { textContent: t }));
      body.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "These are kept in this browser on this computer, only for you. Every change is kept here as you work, and the tabs you close stay here so you can open them again." }));
      if (!open.length && !closed.length && !local.length) body.append(Object.assign(document.createElement("p"), { textContent: "Nothing is kept on this computer yet." }));
      if (open.length) {
        h("Open now");
        for (const t of open) {
          const { row, add } = mkRow(`${t.name} · ${plural(t.shapes, "shape")} · ${t.jobId ? `on the server as ${t.jobId}` : "not on the server yet"}${t.dirty ? " · changes waiting to be saved" : ""}`);
          add("Show", () => { ctx.tabs.showTabById(t.tabId); dlg.close(); });
          body.append(row);
        }
      }
      if (closed.length) {
        h("Closed tabs");
        for (const f of closed) {
          const { row, add } = mkRow(`${f.name} · ${plural(f.state.objects.length, "shape")} · closed ${new Date(f.closedAt).toLocaleString()} · ${f.meta.jobId ? `on the server as ${f.meta.jobId}` : "not on the server yet"}`);
          add("Open", () => { if (ctx.tabs.openClosed(me, f.id)) { ctx.notify(`Opened ${f.name}.`); dlg.close(); } else { ctx.notify("That file is no longer on this computer."); draw(); } });
          add("Delete", () => { if (confirm(`Delete "${f.name}" from this computer?${f.meta.jobId ? " It stays on the server." : " It is not on the server, so it will be gone."}`)) { ctx.tabs.deleteClosed(me, f.id); draw(); } }, "danger");
          body.append(row);
        }
      }
      if (local.length) {
        h("Kept because sending did not work");
        for (const d of local) {
          const { row, add } = mkRow(`${new Date(d.savedAt).toLocaleString()} · ${plural(d.job.objects.length, "shape")} · ${d.job.preset.id} · kept because: ${d.reason || "the server did not take it"}`);
          add("Open", () => {
            if (ctx.tabs.show({ localId: d.id })) { ctx.notify("That copy is already open: switched to its tab."); dlg.close(); return; }
            ctx.tabs.openBlank(designName(d.savedAt));
            ctx.load(fromJobObjects(d.job.objects), d.job.preset.id, (d.job.dimensions ?? []).map(fromJobDimension));
            cur.jobId = null; cur.sourceId = null; cur.origin = d.job.origin ?? DEFAULT_ORIGIN; activity = null; cur.openedLocal = d.id;
            render(); ctx.notify("Opened the copy kept on this computer. It is saved to the server automatically."); dlg.close();
          });
          add("Save to the server", async () => {
            const r = await sendJob(session!, { ...d.job, status: "draft" });
            removeLocal(d.id); if (cur.openedLocal === d.id) cur.openedLocal = null;
            local = listLocal(me);
            ctx.notify(`Saved as ${r.id}`);
            jobs = await listJobs(session!).catch(() => jobs);
            draw();
          }, "on");
          add("Delete", () => { if (confirm("Delete this copy from this computer? It is not on the server.")) { removeLocal(d.id); local = listLocal(me); draw(); } }, "danger");
          body.append(row);
        }
      }
    };

    function draw(): void {
      const nBrowser = ctx.tabs.listOpen().filter((t) => t.shapes > 0 || t.jobId).length + ctx.tabs.listClosed(me).length + local.length;
      tabsBar.replaceChildren(...([["server", `On the server (${jobs.length})`], ["browser", `On this computer (${nBrowser})`]] as const).map(([v, label]) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(view === v));
        b.className = view === v ? "on" : "";
        b.addEventListener("click", () => { view = v; draw(); });
        return b;
      }));
      body.replaceChildren();
      if (view === "server") drawServer(); else drawBrowser();
    }
    draw();
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  }

  async function signOut(): Promise<void> {
    if (stationMode) { wantStation(null); closeStation(); dropSession(); offline = false; render(); return; }
    await flushNow(); // whatever is new goes to the server first
    if ((dirty() || ctx.tabs.othersDirty()) && !confirm("Some changes could not be saved to the server. They are kept on this computer and will be here when you sign in again as the same person. Sign out anyway?")) return;
    ctx.tabs.persist(); // the open tabs stay on this computer for the next time this pupil signs in
    dropSession();
    ctx.clear();
    markSaved();
    offline = false;
    render();
  }

  $("gate-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void startDino();
  });
  $("gate-url").addEventListener("change", () => { authConfig = { mode: "planner", sso: null }; });
  ($("gate-url") as HTMLInputElement).value = defaultBase;
  $("gate-offline").addEventListener("click", () => { offline = true; render(); void ctx.tabs.restore("offline"); });
  $("srv-signin").addEventListener("click", () => { if (session) signOut(); else { offline = false; render(); } });
  window.addEventListener("kerf-profile", () => render()); // the person's name arrived from DINO
  $("srv-status").addEventListener("click", () => { if (!session) { offline = false; render(); } });
  $("srv-send").addEventListener("click", () => (session ? void send() : (offline = false, render())));
  $("srv-activities").addEventListener("click", () => {
    if (session?.role !== "pupil") return;
    const s = session;
    void openMyActivities(s, {
      current: () => activity?.id ?? null,
      work: async (a: MyActivity) => {
        activity = { id: a.id, title: a.title };
        if (a.jobId) {
          const j = await getJob(s, a.jobId);
          if (!ctx.tabs.show({ jobId: j.status === "draft" ? j.id : null, sourceId: j.id })) {
            ctx.tabs.openBlank(a.title);
            ctx.load(fromJobObjects(j.objects), j.preset.id, (j.dimensions ?? []).map(fromJobDimension));
            cur.origin = j.origin ?? DEFAULT_ORIGIN;
            cur.jobId = j.status === "draft" ? j.id : null;
            cur.sourceId = j.status === "draft" ? null : j.id;
            cur.openedLocal = null;
            markSaved();
          }
        } else if (!ctx.objects().length) {
          ctx.load([], a.presetId ?? null, []);
          cur.jobId = null;
          markSaved();
        }
        render();
        ctx.notify(`Working on: ${a.title}. Save to keep your file with this activity.`);
      },
      handIn: async (a: MyActivity) => {
        if (activity?.id === a.id && ctx.objects().length) await saveCurrent(); // hand in what is on the page now
        await submitActivity(s, a.id);
        ctx.notify(`Handed in: ${a.title}`);
      },
    });
  });
  $("srv-files").addEventListener("click", () => (session ? void files() : (offline = false, render())));
  window.addEventListener("beforeunload", (ev) => { if (session && (dirty() || ctx.tabs.othersDirty())) ev.preventDefault(); });
  render();
  /** Back from DINO (?code=&state=), or a reload of a tab that was signed in with DINO. */
  const dinoStart = async (): Promise<void> => {
    if (readCallback(location.search)) {
      $("gate").hidden = false;
      try {
        const r = await finishSignIn("editor", location.search, location);
        cleanAddress();
        if (r) { await signedIn(r.session); keepAlive(r.session, r.tokens); }
      } catch (e) { cleanAddress(); $("gate").hidden = false; $("gate-error").textContent = problem(e); }
    } else if (!session) {
      const r = await restoreSignIn("editor");
      if (r) { await signedIn(r.session); keepAlive(r.session, r.tokens); }
    }
  };
  void dinoStart();
  if (session) {
    // a stored token may have been revoked: check it, and show the sign-in page if so
    void request<{ id: string }>(session, "GET", "/auth/me").then(async () => { await loadPresets(); enterRole(); const restored = !!session && !stationMode && (await ctx.tabs.restore(session.id)); if (session?.role === "pupil" && !restored) void files(true); }).catch((e) => {
      if (e instanceof ServerError && e.status === 401) { dropSession(); return; }
      // the server cannot be reached right now: the tabs kept on this computer still come back, and saving carries on trying
      if (session && !stationMode) { void ctx.tabs.restore(session.id); ctx.notify("The server cannot be reached. Your work is kept on this computer and will be saved when it is back."); }
    });
  }
  return {
    session: () => session,
    owner: () => session?.id ?? "offline",
    getFile: () => cur,
    setFile: (m) => { cur = m; saveState = "idle"; render(); showSaveState(); },
    isDirty: dirty,
    noteChange,
    flushNow,
    setLocalOk: (ok) => { if (ok !== localOk) { localOk = ok; showSaveState(); } },
    renameFile: (jobId, name) => { if (session && session.role !== "station") void renameJob(session, jobId, name).catch(() => undefined); },
    loadWorkspace: async () => { if (!session || session.role === "station") return null; try { return await getWorkspace(session); } catch { return null; } },
    saveWorkspace: async (w) => { if (!session || session.role === "station") return true; try { await putWorkspace(session, w); return true; } catch { return false; } },
    loadJob: async (id) => { if (!session) return null; try { return await getJob(session, id); } catch { return null; } },
  };
}
