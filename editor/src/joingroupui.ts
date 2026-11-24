// The pupil's "Join a group…" dialog (shared 0.2.44): type a group code, then wait for the teacher. Words in joingroup.ts.
import { btn, el, modal, msg } from "./dom";
import { askToJoin, cleanGroupCode, myJoinRequests, requestLine, STATUS_WORD, type JoinRequestDoc } from "./joingroup";
import { ServerError, type Session } from "./server";

export async function openJoinGroup(session: Session): Promise<void> {
  const { dlg, show } = modal("kdialog");
  const box = el("input", { type: "text", maxlength: "32", autocomplete: "off", spellcheck: "false", placeholder: "9B-DT", "aria-label": "Group code", style: "text-transform:uppercase;width:10em" });
  const note = el("p", { role: "status", class: "hint" });
  const list = el("div", { class: "joinlist" });
  const form = el("form", { class: "krow" }, el("label", {}, "Group code ", box), el("button", { type: "submit", class: "on" }, "Ask to join"));
  dlg.append(el("h2", {}, "Join a group"),
    el("p", { class: "hint" }, "Type the group code your teacher gave you. Your teacher then lets you in."),
    form, note, el("h3", {}, "Your requests"), list, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  const done = show();

  async function load(): Promise<void> {
    let rows: JoinRequestDoc[];
    try { rows = await myJoinRequests(session); } catch (e) { list.replaceChildren(el("p", { class: "st-error" }, msg(e))); return; }
    list.replaceChildren(...(rows.length ? rows.map((r) => el("div", { class: "filerow" }, el("span", {}, requestLine(r)), el("span", { class: `st-dot ${r.status === "approved" ? "on" : r.status === "declined" ? "off" : "wait"}` }, STATUS_WORD[r.status])))
      : [el("p", { class: "hint" }, "You have not asked to join a group yet.")]));
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = cleanGroupCode(box.value);
    if (!code) { note.className = "st-error"; note.textContent = "Type the group code: letters, digits, - and _."; box.focus(); return; }
    note.className = "hint"; note.textContent = "Asking…";
    void askToJoin(session, code).then(async (r) => {
      note.className = "hint"; note.textContent = requestLine(r);
      box.value = "";
      await load();
    }).catch((e) => {
      note.className = "st-error";
      note.textContent = e instanceof ServerError && e.code === "already_member" ? `You are already in ${code}.` : msg(e);
    });
  });
  box.focus();
  await load();
  await done;
}
