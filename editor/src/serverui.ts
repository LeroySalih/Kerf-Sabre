// The Server buttons: sign in, Send to server, My files. All talking is in server.ts; the job document is built in job.ts.
import { infoDialog, openDialog } from "./dialog";
import type { DocObject } from "./doc";
import { ANCHORS, buildJob, type Anchor, type Origin } from "./job";
import { setPresets } from "./presets";
import {
  STATUS_TEXT, ServerError, cancelJob, describeDuration, listJobs, listPresets, loadSession, saveSession, sendJob, signIn, submitJob,
  type JobSummary, type Session,
} from "./server";

export interface ServerUiContext {
  objects: () => DocObject[];
  materialId: () => string;
  /** Why the design can't be sent right now (out of bounds, empty...), or null. */
  blocker: () => string | null;
  notify: (msg: string) => void;
  presetsChanged: () => void;
}

const $ = (id: string) => document.getElementById(id)!;
const problem = (e: unknown): string => (e instanceof ServerError ? e.message : e instanceof Error ? e.message : String(e));

export function initServerUi(ctx: ServerUiContext): { session: () => Session | null } {
  let session = loadSession();
  const defaultBase = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";

  const render = () => {
    $("srv-status").textContent = session ? `Signed in: ${session.id}` : "Not signed in";
    $("srv-signin").textContent = session ? "Sign out" : "Sign in";
  };

  async function loadPresets(): Promise<void> {
    if (!session) return;
    try { setPresets(await listPresets(session)); ctx.presetsChanged(); } catch (e) { ctx.notify(`Couldn't load materials: ${problem(e)}`); }
  }

  async function doSignIn(): Promise<boolean> {
    const v = await openDialog("Sign in to the server", [
      { key: "url", label: "Server address", type: "text", value: session?.baseUrl || defaultBase, hint: "Leave blank if this page came from the server" },
      { key: "token", label: "Your token", type: "password", value: "", hint: "Your teacher gives you this" },
    ], { ok: "Sign in", intro: "Your token is kept in this browser only." });
    if (!v) return false;
    try {
      session = await signIn(String(v.url), String(v.token).trim());
      saveSession(session);
      render();
      await loadPresets();
      ctx.notify(`Signed in as ${session.id}`);
      return true;
    } catch (e) {
      await infoDialog("Couldn't sign in", [problem(e)]);
      return false;
    }
  }

  function signOut(): void {
    session = null;
    saveSession(null);
    render();
  }

  async function send(): Promise<void> {
    const why = ctx.blocker();
    if (why) { ctx.notify(why); return; }
    if (!session && !(await doSignIn())) return;
    const v = await openDialog("Send to the server", [
      { key: "mode", label: "Ready to cut?", type: "select", value: "submit", options: [{ value: "submit", label: "Yes, send it for cutting" }, { value: "draft", label: "No, just save it" }] },
      { key: "place", label: "Place it", type: "select", value: "head", options: [{ value: "head", label: "Where the laser head is at the station" }, { value: "bed", label: "Exactly where it is on this bed" }],
        hint: "At the station you line your material up with the laser head, so 'where the laser head is' is usually what you want." },
      { key: "anchor", label: "Laser head goes at its", type: "select", value: "bottom-left", options: ANCHORS.map((a) => ({ value: a.value, label: a.label })) },
    ], { ok: "Send", intro: `You are ${session!.id}. Your design is cleaned and checked on the server.` });
    if (!v) return;
    const origin: Origin = v.place === "bed" ? { mode: "absolute" } : { mode: "current-position", anchor: v.anchor as Anchor };
    const button = $("srv-send") as HTMLButtonElement;
    button.disabled = true;
    try {
      const job = buildJob({ objects: ctx.objects(), pupilId: session!.id, presetId: ctx.materialId(), origin, submit: v.mode === "submit" });
      const r = await sendJob(session!, job);
      const lines = [...(r.warnings ?? [])];
      const est = r.estimate;
      const facts = [`File number ${r.id}`, STATUS_TEXT[r.status] ?? r.status];
      if (est?.durationS) facts.push(`About ${describeDuration(est.durationS)} to cut`);
      if (est?.percentUsed !== undefined) facts.push(`Uses ${est.percentUsed}% of the sheet${est.costSar != null ? `, about ${est.costSar} SAR` : ""}`);
      await infoDialog(r.status === "draft" ? "Saved" : "Sent", [...facts, ...lines.map((w) => `Note: ${w}`)]);
    } catch (e) {
      const extra = e instanceof ServerError && e.details ? e.details.slice(0, 5).map((d) => `${d.path}: ${d.message}`) : [];
      if (e instanceof ServerError && e.status === 401) signOut();
      await infoDialog("Not sent", [problem(e), ...extra]);
    } finally {
      button.disabled = false;
    }
  }

  async function files(): Promise<void> {
    if (!session && !(await doSignIn())) return;
    let jobs: JobSummary[];
    try { jobs = await listJobs(session!); } catch (e) {
      if (e instanceof ServerError && e.status === 401) signOut();
      await infoDialog("Couldn't load your files", [problem(e)]);
      return;
    }
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog";
    dlg.innerHTML = "<h2>My files</h2>";
    const body = document.createElement("div");
    dlg.append(body);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => dlg.close());
    dlg.append(close);
    const draw = () => {
      body.replaceChildren();
      if (!jobs.length) body.append(Object.assign(document.createElement("p"), { textContent: "You haven't sent anything yet." }));
      for (const j of jobs) {
        const row = document.createElement("div");
        row.className = "krow";
        const when = new Date(j.createdAt).toLocaleString();
        const est = j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : "";
        const reason = j.statusReason && j.status !== "done" ? ` (${j.statusReason})` : "";
        row.append(Object.assign(document.createElement("span"), { textContent: `${j.id} · ${j.preset.id} · ${when}${est} · ${STATUS_TEXT[j.status] ?? j.status}${reason}` }));
        const act = (label: string, run: () => Promise<unknown>, next: (j: JobSummary, r: { status: string }) => void) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.addEventListener("click", async () => {
            b.disabled = true;
            try { next(j, (await run()) as { status: string }); draw(); } catch (e) { ctx.notify(problem(e)); b.disabled = false; }
          });
          row.append(b);
        };
        if (j.status === "draft") act("Send for cutting", () => submitJob(session!, j.id), (x, r) => { x.status = r.status; });
        if (["draft", "submitted", "approved"].includes(j.status)) act("Cancel", () => cancelJob(session!, j.id), (x, r) => { x.status = r.status; });
        body.append(row);
      }
    };
    draw();
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  }

  $("srv-signin").addEventListener("click", () => { if (session) signOut(); else void doSignIn(); });
  $("srv-send").addEventListener("click", () => void send());
  $("srv-files").addEventListener("click", () => void files());
  render();
  if (session) void loadPresets();
  return { session: () => session };
}
