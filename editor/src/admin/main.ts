// BISAK Kerf Admin: the teacher and school-admin site (and, for the platform owner, the list of schools).
// It talks to the same server API as the Editor. Pupils never see it; a token decides which pages and which school's data you get.
import "../style.css";
import "./admin.css";
import { btn, el, msg } from "../dom";
import { ServerError, request, type Session } from "../server";
import { pagesFor, type Ctx, type Page } from "./pages";
import { Renewer, beginSignIn, cleanAddress, endSignIn, fetchAuthConfig, finishSignIn, readCallback, restoreSignIn, type Tokens } from "../sso";

const KEY = "kerf.admin.session"; // an older version kept a pasted token here; nothing is stored any more
const saveSession = (_s: Session | null): void => { try { localStorage.removeItem(KEY); } catch { /* fine */ } };

const root = document.getElementById("admin")!;
let session: Session | null = null;
let renewer: Renewer | null = null;
/** A DINO sign-in is kept fresh in the background; if DINO ends it, back to the sign-in page. */
const keepAlive = (s: Session, tokens: Tokens): void => {
  renewer?.stop();
  renewer = new Renewer("admin", s, tokens, (why) => { stopPage(); renewer = null; session = null; saveSession(null); signInView(why); });
};
/** Only staff belong here, however they signed in. */
function staffOnly(me: { role: string }): void {
  if (!["teacher", "admin", "technician", "platform"].includes(me.role)) throw new ServerError(me.role === "station" ? "That is a laser station token. Station pages are for technicians and admins signing in with DINO." : "This site is for teachers, technicians and school admins. Pupils use the Editor.", 403, "forbidden");
}
let schoolName = "";
let stopPage: () => void = () => {};

function signInView(error = ""): void {
  stopPage();
  const err = el("p", { class: "ad-err", role: "alert" }, error);
  const url = el("input", { type: "text", placeholder: "Leave blank unless told otherwise" });
  (url as HTMLInputElement).value = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";
  const dino = el("button", { type: "submit", class: "on" }, "Sign in with DINO");
  const form = el("form", { class: "ad-card ad-signin" }, el("h1", {}, "BISAK Kerf Admin"),
    el("p", { class: "hint" }, "Classes, pupils, activities, the queue and stations. Sign in with your DINO account."),
    el("details", {}, el("summary", {}, "Server address"), url), err, dino, el("a", { href: "/" }, "Looking for the Editor?"));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      try {
        const c = await fetchAuthConfig((url as HTMLInputElement).value);
        if (!c.sso) throw new Error("Can't reach the server's DINO sign-in settings. Check the address and your network.");
        await beginSignIn("admin", (url as HTMLInputElement).value, c.sso, location, (u) => location.assign(u));
      } catch (e) { signInView(msg(e)); }
    })();
  });
  root.replaceChildren(form);
}

function signOut(): void {
  stopPage();
  if (session?.sso) void endSignIn("admin");
  renewer?.stop(); renewer = null;
  session = null;
  saveSession(null);
  signInView();
}

async function shell(): Promise<void> {
  if (!session) return signInView();
  const s = session;
  schoolName = "";
  if (s.role === "teacher" || s.role === "admin") {
    try { schoolName = (await request<{ name: string }>(s, "GET", "/school")).name; }
    catch (e) {
      if (e instanceof ServerError && e.status === 401) { session = null; saveSession(null); return signInView("Your sign-in is no longer valid. Sign in again."); }
      throw e;
    }
  }
  const pages = pagesFor(s.role);
  const main = el("main", { class: "ad-main" });
  const nav = el("nav", { class: "ad-nav", "aria-label": "Admin pages" });
  let current: Page = pages[0]!;

  const ctx: Ctx = { session: s, school: schoolName, go: (key) => { const p = pages.find((x) => x.key === key); if (p) show(p); } };
  function show(p: Page): void {
    stopPage();
    current = p;
    try { localStorage.setItem("kerf.admin.page", p.key); } catch { /* fine */ }
    nav.replaceChildren(...pages.map((x) => btn(x.title, () => show(x), x === current ? "on" : "")));
    main.replaceChildren(el("h1", {}, p.title), el("p", { class: "lead" }, p.lead));
    const body = el("div");
    main.append(body);
    const stop = p.mount(body, ctx);
    stopPage = typeof stop === "function" ? stop : () => {};
  }

  const head = el("header", { class: "ad-head" }, el("span", { class: "brand" }, "BISAK Kerf Admin"),
    el("span", { class: "who" }, `${schoolName ? schoolName + " · " : ""}${s.role === "platform" ? "Platform owner" : s.role === "admin" ? "School admin" : s.role === "technician" ? "Technician" : "Teacher"}: ${s.id}`), el("span", { class: "spacer" }),
    ...(s.role === "teacher" || s.role === "admin" ? [el("a", { class: "btnlink", href: "/" }, "Editor")] : []), btn("Sign out", signOut));
  root.replaceChildren(head, nav, main);
  let saved = "";
  try { saved = localStorage.getItem("kerf.admin.page") ?? ""; } catch { /* fine */ }
  show(pages.find((p) => p.key === saved) ?? pages[0]!);
}

/** Back from DINO (?code=&state=), or a reload of a tab signed in with DINO. */
async function start(): Promise<void> {
  if (readCallback(location.search)) {
    try {
      const r = await finishSignIn("admin", location.search, location);
      cleanAddress();
      if (r) { staffOnly(r.session); session = r.session; keepAlive(r.session, r.tokens); return void (await shell()); }
    } catch (e) {
      cleanAddress();
      void endSignIn("admin");
      return signInView(msg(e));
    }
  }
  if (!session) {
    const r = await restoreSignIn("admin");
    if (r) {
      try { staffOnly(r.session); session = r.session; keepAlive(r.session, r.tokens); } catch (e) { void endSignIn("admin"); return signInView(msg(e)); }
    }
  }
  if (session) await shell(); else signInView();
}
void start().catch((e) => signInView(msg(e)));
