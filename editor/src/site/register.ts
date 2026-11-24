// The /register page (proprietary site code, shared 0.2.40): a free school registers itself. The server emails a confirmation
// link; the school is only made when that link is used (/sign-in?register=<token>, see panel.ts). Decisions in registerlogic.ts.
import { normaliseBase, request, ServerError } from "../server";
import { checkRegistration, registrationOpen, viewAfter, type RegisterField, type RegisterView } from "./registerlogic";

type Fetch = typeof fetch;
const base = (): string => (location.protocol.startsWith("http") ? location.origin : "");

export function mountRegister(root: HTMLElement, f: Fetch = fetch): void {
  const one = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const form = one<HTMLFormElement>("[data-register-form]");
  const alertEl = one<HTMLElement>("[data-alert]");
  const input = (n: string) => form.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
  const FIELD: Record<RegisterField, string> = { schoolName: "schoolName", name: "name", email: "email", agreed: "agreed" };

  function alert(msg: string): void { alertEl.textContent = msg; alertEl.hidden = !msg; }
  function show(v: RegisterView, focus = false): void {
    for (const el of root.querySelectorAll<HTMLElement>("[data-view]")) el.hidden = el.dataset.view !== v;
    one<HTMLElement>("[data-foot]").hidden = v === "sent";
    for (const h of root.querySelectorAll<HTMLElement>(".kp-title")) h.removeAttribute("id");
    const title = one<HTMLElement>(`[data-view="${v}"] .kp-title`);
    title.id = "kerf-register-title";
    if (focus) { title.tabIndex = -1; title.focus(); }
    alert("");
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const check = checkRegistration({ schoolName: input("schoolName").value, name: input("name").value, email: input("email").value, agreed: input("agreed").checked });
    if (!check.ok) { alert(check.message); input(FIELD[check.field]).focus(); return; }
    const go = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    if (go.getAttribute("aria-busy")) return;
    go.setAttribute("aria-busy", "true");
    alert("");
    void request<{ message: string }>({ baseUrl: normaliseBase(base()), token: "" }, "POST", "/auth/register", check.body, f)
      .then(() => show("sent", true))
      .catch((e) => {
        const v = viewAfter(e instanceof ServerError ? e.code : "error");
        if (v === "form") alert(e instanceof Error ? e.message : String(e)); else show(v, true);
      })
      .finally(() => go.removeAttribute("aria-busy"));
  });
  one<HTMLButtonElement>("[data-back]").addEventListener("click", () => { show("form", true); input("email").select(); });

  show("form");
  void f(`${normaliseBase(base())}/api/v1/auth/config`)
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (!registrationOpen(cfg)) show("closed"); })
    .catch(() => { /* offline: the form says so when it is sent */ });
}
