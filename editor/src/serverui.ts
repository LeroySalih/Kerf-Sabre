// Pupil sign-in and their files on the server: Save, Send for cutting, My files (open / send / cancel).
// All talking is in server.ts; the job document is built and read back in job.ts.
import { infoDialog, openDialog } from "./dialog";
import { openClasses } from "./classesui";
import { closeStation, openStation, openTeacher } from "./stationui";
import type { Dimension } from "./dimensions";
import type { DocObject } from "./doc";
import { ANCHORS, buildJob, fromJobDimension, fromJobObjects, type Anchor, type LoadedShape, type Origin } from "./job";
import { setPresets } from "./presets";
import {
  STATUS_TEXT, ServerError, cancelJob, loginWithPin, logout, describeDuration, listJobs, listPresets, listQueue, queueText, type QueueEntry, loadSession, request, saveDraft, saveSession, sendJob, signIn, submitJob,
  type JobSummary, type Session,
} from "./server";

export interface ServerUiContext {
  objects: () => DocObject[];
  dimensions: () => Dimension[];
  materialId: () => string;
  /** Why the design can't be sent right now (out of bounds, empty...), or null. */
  blocker: () => string | null;
  notify: (msg: string) => void;
  presetsChanged: () => void;
  /** Replace the page with these shapes (and material), as one undoable step. */
  load: (shapes: LoadedShape[], materialId: string | null, dimensions: Dimension[]) => void;
  /** Empty the page (used on sign-out so the next pupil never sees it). */
  clear: () => void;
}

const $ = (id: string) => document.getElementById(id)!;
const problem = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const DEFAULT_ORIGIN: Origin = { mode: "current-position", anchor: "bottom-left" };

export function initServerUi(ctx: ServerUiContext): { session: () => Session | null } {
  let session = loadSession();
  let offline = false;
  /** The draft on the server that Save updates; null until the first Save (or after the design was sent). */
  let jobId: string | null = null;
  let origin: Origin = DEFAULT_ORIGIN;
  let savedKey = "";
  const defaultBase = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";

  /** A fingerprint of the page, to tell whether there is anything unsaved. */
  const key = () => JSON.stringify([ctx.materialId(), ctx.objects().map((o) => [o.path, o.matrix, o.layer, o.tabs, o.settings]), ctx.dimensions()]);
  const dirty = () => ctx.objects().length > 0 && key() !== savedKey;
  const markSaved = () => { savedKey = key(); };
  const confirmDiscard = (what: string) => !dirty() || confirm(`You have changes that are not saved. ${what} anyway?`);

  const render = () => {
    const signedIn = !!session;
    $("gate").hidden = signedIn || offline;
    $("srv-status").textContent = signedIn ? `Signed in: ${session!.id}` : "Working offline";
    $("srv-signin").textContent = signedIn ? "Sign out" : "Sign in";
    ($("srv-queue") as HTMLButtonElement).hidden = session?.role !== "teacher";
    ($("srv-classes") as HTMLButtonElement).hidden = session?.role !== "teacher";
    $("srv-file").textContent = signedIn && jobId ? `Editing ${jobId}` : "";
  };

  const dropSession = () => {
    if (session?.expiresAt) void logout(session); // a class-login session: end it on the server too
    session = null; saveSession(null); jobId = null; render(); };
  const handle = (e: unknown): string => {
    if (e instanceof ServerError && e.status === 401) dropSession();
    return problem(e);
  };

  async function loadPresets(): Promise<void> {
    if (!session) return;
    try { setPresets(await listPresets(session)); ctx.presetsChanged(); } catch (e) { ctx.notify(`Couldn't load materials: ${handle(e)}`); }
  }

  /** A laser-station token goes straight to Station mode; everyone else gets the design Editor. */
  function enterRole(): void {
    if (session?.role === "station") { $("gate").hidden = true; openStation(session, signOut); }
    else closeStation();
  }

  /** Everything after a successful sign-in, however it happened. */
  async function signedIn(next: Session): Promise<void> {
    session = next;
    saveSession(session);
    offline = false;
    render();
    await loadPresets();
    enterRole();
    if (session.role === "station") return;
    ctx.notify(`Signed in as ${session.id}`);
    if (session.role === "pupil") void files(true);
  }

  /** The sign-in page has two ways in: class code + pupil ID + PIN (pupils), or a token (teachers, laser stations). */
  let tokenMode = false;
  const setMode = (token: boolean) => {
    tokenMode = token;
    ($("gate-pin-fields") as HTMLElement).hidden = token;
    ($("gate-token-fields") as HTMLElement).hidden = !token;
    for (const id of ["gate-class", "gate-pid", "gate-pin"]) ($(id) as HTMLInputElement).required = !token;
    ($("gate-token") as HTMLInputElement).required = token;
    $("gate-mode").textContent = token ? "Pupil? Sign in with your class code and PIN" : "Teacher or laser station? Sign in with a token";
    $("gate-error").textContent = "";
  };

  async function gateSubmit(): Promise<void> {
    const err = $("gate-error");
    const base = (($("gate-url") as HTMLInputElement).value);
    err.textContent = "";
    try {
      if (tokenMode) { await signedIn(await signIn(base, (($("gate-token") as HTMLInputElement).value).trim())); return; }
      const cls = (($("gate-class") as HTMLInputElement).value);
      const next = await loginWithPin(base, cls, (($("gate-pid") as HTMLInputElement).value), (($("gate-pin") as HTMLInputElement).value));
      try { localStorage.setItem("kerf.classCode", cls.trim()); } catch { /* fine */ }
      ($("gate-pin") as HTMLInputElement).value = ""; // never leave a PIN sitting in the form
      await signedIn(next);
    } catch (e) { err.textContent = problem(e); }
  }

  /** Make sure there is a draft on the server holding the current design. Returns its id. */
  async function saveCurrent(): Promise<string> {
    const job = buildJob({ objects: ctx.objects(), dimensions: ctx.dimensions(), pupilId: session!.id, presetId: ctx.materialId(), origin, submit: false });
    if (jobId) {
      try { await saveDraft(session!, jobId, job); markSaved(); return jobId; } catch (e) {
        if (!(e instanceof ServerError && (e.status === 409 || e.status === 404))) throw e; // the draft was sent or cancelled meanwhile: start a new one
        jobId = null;
      }
    }
    const r = await sendJob(session!, job);
    jobId = r.id;
    markSaved();
    render();
    return r.id;
  }

  async function save(): Promise<void> {
    const why = ctx.blocker();
    if (why && !ctx.objects().length) { ctx.notify(why); return; }
    try { const id = await saveCurrent(); ctx.notify(`Saved as ${id}`); } catch (e) { await infoDialog("Not saved", [handle(e)]); }
  }

  async function send(): Promise<void> {
    const why = ctx.blocker();
    if (why) { ctx.notify(why); return; }
    const v = await openDialog("Send for cutting", [
      { key: "place", label: "Place it", type: "select", value: origin.mode === "absolute" ? "bed" : "head", options: [{ value: "head", label: "Where the laser head is at the station" }, { value: "bed", label: "Exactly where it is on this bed" }],
        hint: "At the station you line your material up with the laser head, so 'where the laser head is' is usually what you want." },
      { key: "anchor", label: "Laser head goes at its", type: "select", value: origin.mode === "current-position" ? origin.anchor : "bottom-left", options: ANCHORS.map((a) => ({ value: a.value, label: a.label })) },
    ], { ok: "Send", intro: `You are ${session!.id}. Your design is saved, then cleaned and checked on the server.` });
    if (!v) return;
    origin = v.place === "bed" ? { mode: "absolute" } : { mode: "current-position", anchor: v.anchor as Anchor };
    const button = $("srv-send") as HTMLButtonElement;
    button.disabled = true;
    try {
      const id = await saveCurrent();
      const r = await submitJob(session!, id);
      jobId = null; // it is now in the queue: further changes are a new file
      render();
      const est = r.estimate;
      const facts = [`File number ${r.id}`, STATUS_TEXT[r.status] ?? r.status];
      const q = queueText(r.ticket, r.position);
      if (q) facts.push(q);
      if (est?.durationS) facts.push(`About ${describeDuration(est.durationS)} to cut`);
      if (est?.percentUsed !== undefined) facts.push(`Uses ${est.percentUsed}% of the sheet${est.costSar != null ? `, about ${est.costSar} SAR` : ""}`);
      await infoDialog("Sent", [...facts, ...(r.warnings ?? []).map((w) => `Note: ${w}`)]);
    } catch (e) {
      const extra = e instanceof ServerError && e.details ? e.details.slice(0, 5).map((d) => `${d.path}: ${d.message}`) : [];
      await infoDialog("Not sent", [handle(e), ...extra, "Your design is still saved as a draft in My files."]);
    } finally {
      button.disabled = false;
    }
  }

  function open(j: JobSummary, close: () => void): void {
    if (!confirmDiscard("Open this file")) return;
    ctx.load(fromJobObjects(j.objects), j.preset.id, (j.dimensions ?? []).map(fromJobDimension));
    origin = j.origin ?? DEFAULT_ORIGIN;
    jobId = j.status === "draft" ? j.id : null; // only a draft can be changed; anything else opens as a copy
    markSaved();
    render();
    ctx.notify(j.status === "draft" ? `Opened ${j.id}` : `Opened a copy of ${j.id}. Save to keep your changes as a new file.`);
    close();
  }

  async function files(auto = false): Promise<void> {
    if (!session) return;
    let jobs: JobSummary[];
    try { jobs = await listJobs(session); } catch (e) { await infoDialog("Couldn't load your files", [handle(e)]); return; }
    if (auto && !jobs.length) return; // nothing to show a new pupil yet
    let queued = new Map<string, QueueEntry>();
    try { queued = new Map((await listQueue(session)).filter((q) => q.jobId).map((q) => [q.jobId!, q])); } catch { /* the list still works without queue places */ }
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog wide";
    dlg.innerHTML = `<h2>My files</h2><p class="hint">${session.id}. Open a file to keep working on it, or send it for cutting.</p>`;
    const body = document.createElement("div");
    dlg.append(body);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => dlg.close());
    dlg.append(close);
    const draw = () => {
      body.replaceChildren();
      if (!jobs.length) body.append(Object.assign(document.createElement("p"), { textContent: "You haven't saved anything yet." }));
      for (const j of jobs) {
        const row = document.createElement("div");
        row.className = "filerow";
        const est = j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : "";
        const reason = j.statusReason && j.status !== "done" ? ` (${j.statusReason})` : "";
        const info = document.createElement("span");
        const place = queued.get(j.id);
        const where = j.status === "approved" ? queueText(j.ticket ?? place?.ticket, place?.position, place?.aheadS) : j.ticket != null ? `Ticket ${j.ticket}` : "";
        info.textContent = `${where ? where + " · " : ""}${j.id} · ${j.preset.id} · ${new Date(j.createdAt).toLocaleString()}${est} · ${STATUS_TEXT[j.status] ?? j.status}${reason}`;
        row.append(info);
        const btn = (label: string, run: () => Promise<void> | void) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.addEventListener("click", async () => {
            b.disabled = true;
            try { await run(); } catch (e) { ctx.notify(handle(e)); }
            b.disabled = false;
          });
          row.append(b);
        };
        btn(j.status === "draft" ? "Open" : "Open a copy", () => open(j, () => dlg.close()));
        if (j.status === "draft") btn("Send for cutting", async () => { const r = await submitJob(session!, j.id); j.status = r.status; j.warnings = r.warnings; if (jobId === j.id) jobId = null; render(); draw(); });
        if (["draft", "submitted", "approved"].includes(j.status)) btn("Cancel", async () => { const r = await cancelJob(session!, j.id); j.status = r.status; if (jobId === j.id) jobId = null; render(); draw(); });
        body.append(row);
      }
    };
    draw();
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  }

  function signOut(): void {
    if (session?.role === "station") { closeStation(); dropSession(); offline = false; render(); return; }
    if (!confirmDiscard("Sign out")) return;
    dropSession();
    ctx.clear();
    markSaved();
    offline = false;
    render();
  }

  $("gate-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void gateSubmit();
  });
  $("gate-mode").addEventListener("click", () => setMode(!tokenMode));
  try { ($("gate-class") as HTMLInputElement).value = localStorage.getItem("kerf.classCode") ?? ""; } catch { /* fine */ }
  ($("gate-url") as HTMLInputElement).value = defaultBase;
  $("gate-offline").addEventListener("click", () => { offline = true; render(); });
  $("srv-signin").addEventListener("click", () => { if (session) signOut(); else { offline = false; render(); } });
  $("srv-save").addEventListener("click", () => (session ? void save() : (offline = false, render())));
  $("srv-send").addEventListener("click", () => (session ? void send() : (offline = false, render())));
  $("srv-classes").addEventListener("click", () => { if (session?.role === "teacher") openClasses(session); });
  setMode(false);
  $("srv-queue").addEventListener("click", () => { if (session?.role === "teacher") openTeacher(session); });
  $("srv-files").addEventListener("click", () => (session ? void files() : (offline = false, render())));
  window.addEventListener("beforeunload", (ev) => { if (session && dirty()) ev.preventDefault(); });
  render();
  if (session) {
    // a stored token may have been revoked: check it, and show the sign-in page if so
    void request<{ id: string }>(session, "GET", "/auth/me").then(async () => { await loadPresets(); enterRole(); if (session?.role === "pupil") void files(true); }).catch((e) => {
      if (e instanceof ServerError && e.status === 401) dropSession();
    });
  }
  return { session: () => session };
}
