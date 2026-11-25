// "Change password…" in the Admin header, for staff signed in with a Kerf password (shared 0.2.47). Current + new + repeat, checked
// by `checkNewPassword` (staffpassword.ts, tested) before the server checks them again; the server ends the person's other sessions.
// Passwords live only in the dialog's boxes and are never stored.
import { el, msg } from "../dom";
import { changePassword } from "../emailsignin";
import type { Session } from "../server";
import { RULES, checkNewPassword } from "../staffpassword";

export function openChangePassword(s: Session): Promise<void> {
  return new Promise((resolve) => {
    const box = (id: string, label: string, auto: string) => {
      const input = el("input", { id, type: "password", autocomplete: auto, autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, label: el("label", { for: id }, label, input) };
    };
    const cur = box("cp-current", "Current password", "current-password");
    const next = box("cp-new", "New password", "new-password");
    const again = box("cp-again", "Type the new password again", "new-password");
    const show = el("input", { type: "checkbox", id: "cp-show", style: "width: auto; margin: 0" }) as HTMLInputElement;
    show.addEventListener("change", () => { for (const b of [cur, next, again]) b.input.type = show.checked ? "text" : "password"; });
    const status = el("p", { class: "kstatus", role: "alert" });
    const save = el("button", { type: "submit", class: "on" }, "Change password");
    const cancel = el("button", { type: "button" }, "Cancel");
    const form = el("form", { method: "dialog" },
      el("h2", {}, "Change password"),
      el("p", { class: "hint" }, "You stay signed in here. Every other computer where you are signed in is signed out."),
      el("ul", { class: "hint" }, ...RULES.map((r) => el("li", {}, r))),
      el("div", { class: "kgrid", style: "grid-template-columns: 1fr" }, cur.label, next.label, again.label),
      el("label", { for: "cp-show", style: "display: flex; align-items: center; gap: 8px; margin-top: 10px; width: fit-content" }, show, "Show passwords"),
      status, el("div", { class: "krow" }, cancel, save));
    const dlg = el("dialog", { class: "kdialog", "aria-labelledby": "cp-title" }, form);
    form.querySelector("h2")!.id = "cp-title";
    const close = () => { dlg.close(); };
    cancel.addEventListener("click", close);
    for (const b of [cur, next, again]) b.input.addEventListener("input", () => { status.textContent = ""; });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    let done = false;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (done) return;
      if (!cur.input.value) { status.textContent = "Type your current password."; cur.input.focus(); return; }
      const problem = checkNewPassword(next.input.value, again.input.value);
      if (problem) { status.textContent = problem; (next.input.value.length >= 10 && again.input.value !== next.input.value ? again : next).input.focus(); return; }
      if (save.getAttribute("aria-busy")) return;
      save.setAttribute("aria-busy", "true");
      status.textContent = "";
      void changePassword(s, cur.input.value, next.input.value)
        .then((text) => {
          done = true;
          for (const b of [cur, next, again]) b.input.value = "";
          form.replaceChildren(el("h2", {}, "Password changed"), el("p", {}, text), el("div", { class: "krow" }, el("button", { type: "submit", class: "on" }, "OK")));
          form.addEventListener("submit", close, { once: true });
        })
        .catch((e) => { status.textContent = msg(e); })
        .finally(() => save.removeAttribute("aria-busy"));
    });
    document.body.append(dlg);
    dlg.showModal();
    cur.input.focus();
  });
}
