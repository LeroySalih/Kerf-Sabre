// Activities: pupils work through what their class has been set; teachers set activities, watch progress and give feedback.
import { infoDialog } from "./dialog";
import { btn, el, modal, msg, shortDate } from "./dom";
import { presetStore, presetLabel } from "./presets";
import {
  ACTIVITY_STATUS_TEXT, archiveActivity, classActivities, classProgress, createActivity, giveFeedback, myActivities, myActivity, orderActivities,
  pupilFiles, pupilWork, updateActivity,
  type Activity, type ActivityInput, type ActivityStatus, type FeedbackItem, type JobSummary, type MyActivity, type Session,
} from "./server";
import { previewSvg } from "./stationlogic";

const chip = (status: ActivityStatus): HTMLElement => el("span", { class: `chip st-${status}` }, ACTIVITY_STATUS_TEXT[status]);

function feedbackList(items: FeedbackItem[]): HTMLElement {
  const box = el("div", { class: "feedback" });
  if (!items.length) { box.append(el("p", { class: "hint" }, "No feedback yet.")); return box; }
  for (const f of items) {
    const label = f.outcome === "revise" ? "Please improve" : f.outcome === "complete" ? "Complete" : "Comment";
    box.append(el("div", { class: `fb ${f.outcome}` }, el("div", { class: "fbhead" }, el("b", {}, label), ` · ${f.teacherId} · ${new Date(f.createdAt).toLocaleString()}`), el("p", {}, f.text || "(no comment)")));
  }
  return box;
}

// ---------------------------------------------------------------- pupil

export interface PupilCallbacks {
  /** Start working on this activity: later saves are for it; opens the file already made for it, if any. */
  work: (a: MyActivity) => void | Promise<void>;
  /** Hand in the pupil's file for the activity (saves the page first if it is the current one). */
  handIn: (a: MyActivity) => Promise<void>;
  current: () => string | null;
}

export async function openMyActivities(session: Session, cb: PupilCallbacks): Promise<void> {
  const { dlg, show } = modal("kdialog wide");
  const body = el("div");
  dlg.append(el("h2", {}, "My activities"), body, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  const done = show();

  async function list(): Promise<void> {
    let acts: MyActivity[];
    try { acts = await myActivities(session); } catch (e) { body.replaceChildren(el("p", { class: "st-error" }, msg(e))); return; }
    body.replaceChildren();
    if (!acts.length) body.append(el("p", {}, "Your teacher hasn't set any activities yet."));
    for (const a of acts) {
      const due = a.dueAt ? ` · due ${shortDate(a.dueAt)}` : "";
      const fb = a.feedbackCount ? ` · ${a.feedbackCount} feedback` : "";
      body.append(el("div", { class: "filerow" }, el("span", {}, el("b", {}, a.title), due, fb), chip(a.status), btn("Open", () => void detail(a.id), cb.current() === a.id ? "on" : "")));
    }
  }

  async function detail(id: string): Promise<void> {
    let a: MyActivity;
    try { a = await myActivity(session, id); } catch (e) { await infoDialog("Couldn't open that", [msg(e)]); return; }
    const preset = a.presetId ? presetStore.find((p) => p.id === a.presetId) : undefined;
    body.replaceChildren(
      el("h3", {}, a.title), chip(a.status),
      ...(a.dueAt ? [el("p", { class: "hint" }, `Due ${shortDate(a.dueAt)}`)] : []),
      el("p", { class: "instructions" }, a.instructions || "(No instructions.)"),
      ...(preset ? [el("p", {}, `Suggested material: ${presetLabel(preset)}`)] : []),
      el("h3", {}, "Feedback"), feedbackList(a.feedback ?? []),
      el("div", { class: "krow" },
        btn("‹ All activities", () => void list()),
        btn(a.jobId || a.status !== "todo" ? "Continue working" : "Start working", () => void (async () => { await cb.work(a); dlg.close(); })(), "on"),
        ...(a.status !== "complete" ? [btn(a.status === "submitted" ? "Hand in again" : "Hand in for review", () => void (async () => {
          try { await cb.handIn(a); await detail(id); } catch (e) { await infoDialog("Not handed in", [msg(e)]); }
        })())] : [])));
  }

  await list();
  await done;
}

// ---------------------------------------------------------------- teacher

function activityForm(existing?: Activity): Promise<ActivityInput | null> {
  return new Promise((resolve) => {
    const { dlg, show } = modal("kdialog wide");
    const title = el("input", { type: "text", required: "", value: existing?.title ?? "", maxlength: "200" });
    const text = el("textarea", { rows: "6", style: "width:100%;box-sizing:border-box" }, existing?.instructions ?? "");
    const preset = el("select", {}, new Option("No suggested material", ""), ...presetStore.map((p) => new Option(presetLabel(p), p.id)));
    preset.value = existing?.presetId ?? "";
    const due = el("input", { type: "datetime-local", value: existing?.dueAt ? new Date(new Date(existing.dueAt).getTime() - new Date(existing.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "" });
    const pub = el("input", { type: "checkbox" });
    pub.checked = existing?.published ?? false;
    const form = el("form", { method: "dialog" },
      el("h2", {}, existing ? "Edit activity" : "New activity"),
      el("label", {}, "Title ", title), el("label", {}, "Instructions", text),
      el("label", {}, "Suggested material ", preset), el("label", {}, "Due (optional) ", due),
      el("label", {}, pub, " Visible to pupils"));
    let out: ActivityInput | null = null;
    form.addEventListener("submit", () => {
      out = { title: title.value.trim(), instructions: text.value, presetId: preset.value || null, dueAt: due.value ? new Date(due.value).toISOString() : null, published: pub.checked };
    });
    const row = el("div", { class: "krow" }, btn("Cancel", () => dlg.close()), Object.assign(el("button", { type: "submit", class: "on" }, existing ? "Save" : "Create")));
    form.append(row);
    dlg.append(form);
    void show().then(() => resolve(out));
    title.focus();
  });
}

export interface TeacherCallbacks {
  /** Open a pupil's file in the Editor (as a copy to look at). */
  openFile: (job: JobSummary) => void;
}

export async function openClassWork(session: Session, code: string, cb: TeacherCallbacks, start: "activities" | "progress" = "activities"): Promise<void> {
  const { dlg, show } = modal("kdialog teacher wide");
  const body = el("div");
  const tabs = el("div", { class: "tabs" });
  dlg.append(el("h2", {}, `${code}: activities and progress`), tabs, body, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  const done = show();
  let tab: "activities" | "progress" = start;
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await infoDialog("That didn't work", [msg(e)]); } await draw(); };

  async function draw(): Promise<void> {
    tabs.replaceChildren(btn("Activities", () => { tab = "activities"; void draw(); }, tab === "activities" ? "on" : ""), btn("Progress", () => { tab = "progress"; void draw(); }, tab === "progress" ? "on" : ""));
    try { await (tab === "activities" ? drawActivities() : drawProgress()); } catch (e) { body.replaceChildren(el("p", { class: "st-error" }, msg(e))); }
  }

  async function drawActivities(): Promise<void> {
    const acts = await classActivities(session, code);
    body.replaceChildren();
    if (!acts.length) body.append(el("p", { class: "hint" }, "No activities yet. Set the first one."));
    acts.forEach((a, i) => {
      const c = a.counts ?? {};
      const stats = [c.submitted ? `${c.submitted} handed in` : "", c.revise ? `${c.revise} to improve` : "", c.complete ? `${c.complete} complete` : "", c.working ? `${c.working} working` : ""].filter(Boolean).join(", ");
      const move = (d: number) => void run(async () => { const ids = acts.map((x) => x.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; await orderActivities(session, code, ids); });
      body.append(el("div", { class: "filerow" },
        el("span", {}, el("b", {}, `${i + 1}. ${a.title}`), a.published ? "" : " (hidden from pupils)", a.dueAt ? ` · due ${shortDate(a.dueAt)}` : "", stats ? ` · ${stats}` : ""),
        btn("↑", () => move(-1), "icon"), btn("↓", () => move(1), "icon"),
        btn(a.published ? "Hide" : "Publish", () => void run(() => updateActivity(session, code, a.id, { published: !a.published }))),
        btn("Edit", () => void (async () => { const v = await activityForm(a); if (v) await run(() => updateActivity(session, code, a.id, v)); })()),
        btn("Archive", () => { if (confirm(`Archive "${a.title}"? Pupils won't see it. Their work and your feedback are kept.`)) void run(() => archiveActivity(session, code, a.id)); }, "danger")));
    });
    body.append(el("div", { class: "krow" }, btn("New activity…", () => void (async () => { const v = await activityForm(); if (v) await run(() => createActivity(session, code, v)); })(), "on")));
  }

  async function drawProgress(): Promise<void> {
    const p = await classProgress(session, code);
    body.replaceChildren();
    if (!p.activities.length || !p.pupils.length) { body.append(el("p", { class: "hint" }, !p.pupils.length ? "No pupils in this class yet." : "No activities yet.")); return; }
    const table = el("table", { class: "progress" });
    table.append(el("tr", {}, el("th", {}, "Pupil"), ...p.activities.map((a) => el("th", { title: a.title }, a.title.length > 16 ? a.title.slice(0, 15) + "…" : a.title))));
    for (const pu of p.pupils) {
      table.append(el("tr", {}, el("th", {}, pu.pupilId), ...p.activities.map((a) => {
        const w = pu.work[a.id] ?? { status: "todo" as ActivityStatus, feedbackCount: 0 };
        const cell = el("td", { class: `cell st-${w.status}`, title: `${ACTIVITY_STATUS_TEXT[w.status]}${w.feedbackCount ? ` · ${w.feedbackCount} feedback` : ""}` }, w.status === "todo" ? "" : ACTIVITY_STATUS_TEXT[w.status][0]! + (w.feedbackCount ? `·${w.feedbackCount}` : ""));
        cell.addEventListener("click", () => void openPupilWork(session, code, a, pu.pupilId, cb).then(() => draw()));
        return cell;
      })));
    }
    body.append(table, el("p", { class: "hint" }, "Click a cell to see the pupil's file and give feedback. W working, H handed in, P please improve, C complete."));
  }

  await draw();
  await done;
}

async function openPupilWork(session: Session, code: string, activity: { id: string; title: string }, pupilId: string, cb: TeacherCallbacks): Promise<void> {
  const { dlg, show } = modal("kdialog wide");
  const body = el("div");
  dlg.append(el("h2", {}, `${pupilId}: ${activity.title}`), body, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  const done = show();
  let jobs: (JobSummary & { origin: unknown })[] = [];
  try { jobs = await pupilFiles(session, code, pupilId); } catch { /* the work view still works without the preview */ }

  async function draw(): Promise<void> {
    let w;
    try { w = await pupilWork(session, code, activity.id, pupilId); } catch (e) { body.replaceChildren(el("p", { class: "st-error" }, msg(e))); return; }
    const shown = (w.jobId && jobs.find((j) => j.id === w.jobId)) || jobs.find((j) => (w.files ?? []).some((f) => f.id === j.id));
    const preview = el("div", { class: "st-preview" });
    if (shown) preview.innerHTML = previewSvg(shown.objects);
    else preview.append(el("span", { class: "hint" }, "No file yet."));
    const fileRow = shown ? el("p", {}, `${w.jobId === shown.id ? "Handed in" : "Latest"} file ${shown.id}${w.submittedAt ? ` · ${new Date(w.submittedAt).toLocaleString()}` : ""} `, btn("Open in the Editor", () => { cb.openFile(shown); dlg.close(); })) : el("p");
    const note = el("textarea", { rows: "4", placeholder: "Write feedback for the pupil…", style: "width:100%;box-sizing:border-box" });
    const send = (outcome: FeedbackItem["outcome"]) => void (async () => {
      try { await giveFeedback(session, code, activity.id, pupilId, note.value.trim(), outcome); await draw(); } catch (e) { await infoDialog("Not saved", [msg(e)]); }
    })();
    body.replaceChildren(chip(w.status), el("div", { class: "st-info" }, preview, el("div", {}, fileRow, el("h3", {}, "Feedback so far"), feedbackList(w.feedback))),
      note, el("div", { class: "krow" }, btn("Add comment", () => send("comment")), btn("Ask to improve", () => send("revise")), btn("Mark complete", () => send("complete"), "go")));
  }
  await draw();
  await done;
}
