// BISAK Kerf Admin: the teacher and school-admin site (and, for the platform owner, the list of schools).
// It talks to the same server API as the Editor. Pupils never see it; a token decides which pages and which school's data you get.
import "../style.css";
import "./admin.css";
import { btn, el, msg } from "../dom";
import { ServerError, normaliseBase, request, type Session } from "../server";
import { pagesFor, type Ctx, type Page } from "./pages";
import { Renewer, beginSignIn, cleanAddress, endSignIn, fetchAuthConfig, finishSignIn, readCallback, restoreSignIn, type Tokens } from "../sso";

const KEY = "kerf.admin.session";
const loadSession = (): Session | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return s && typeof s.token === "string" && typeof s.baseUrl === "string" ? (s as Session) : null;
  } catch { return null; }
};
const saveSession = (s: Session | null): void => {
  try { if (s && !s.sso) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private window: this page only */ }
};

const root = document.getElementById("admin")!;
let session = loadSession();
let renewer: Renewer | null = null;
/** A DINO sign-in is kept fresh in the background; if DINO ends it, back to the sign-in page. */
const keepAlive = (s: Session, tokens: Tokens): void => {
  renewer?.stop();
  renewer = new Renewer("admin", s, tokens, (why) => { stopPage(); renewer = null; session = null; saveSession(null); signInView(why); });
};
/** Only staff belong here, however they signed in. */
function staffOnly(me: { role: string }): void {
  if (!["teacher", "admin", "platform"].includes(me.role)) throw new ServerError(me.role === "station" ? "That is a laser station token. Use the Editor on the laser PC." : "This site is for teachers and school admins. Pupils use the Editor.", 403, "forbidden");
}
let schoolName = "";
let stopPage: () => void = () => {};

/** Only staff belong here. A pupil or laser-station token is turned away with a pointer to the right place. */
async function signInWith(token: string, address: string): Promise<Session> {
  const baseUrl = normaliseBase(address);
  const me = await request<{ role: string; id: string; school?: string | null }>({ baseUrl, token }, "GET", "/auth/me");
  staffOnly(me);
  return { baseUrl, token, role: me.role, id: me.id, school: me.school };
}

function signInView(error = ""): void {
  stopPage();
  const err = el("p", { class: "ad-err", role: "alert" }, error);
  const token = el("input", { type: "password", autocomplete: "off", spellcheck: "false", required: "", placeholder: "Teacher, admin or platform token" });
  const url = el("input", { type: "text", placeholder: "Leave blank unless told otherwise" });
  (url as HTMLInputElement).value = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";
  const dino = el("button", { type: "button", class: "on", hidden: "" }, "Sign in with DINO");
  void fetchAuthConfig((url as HTMLInputElement).value).then((c) => {
    if (!c.sso) return;
    (dino as HTMLElement).hidden = false;
    dino.addEventListener("click", () => { void beginSignIn("admin", (url as HTMLInputElement).value, c.sso!, location, (u) => location.assign(u)).catch((e) => signInView(msg(e))); });
  });
  const form = el("form", { class: "ad-card ad-signin" }, el("h1", {}, "BISAK Kerf Admin"),
    el("p", { class: "hint" }, "Classes, pupils, activities, the queue and stations. Sign in with your teacher or admin token."),
    el("label", {}, "Token", token), el("details", {}, el("summary", {}, "Server address"), url), err, el("button", { type: "submit", class: "on" }, "Sign in"),
    dino, el("a", { href: "/" }, "Looking for the Editor?"));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      try {
        session = await signInWith((token as HTMLInputElement).value.trim(), (url as HTMLInputElement).value);
        saveSession(session);
        await shell();
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
  if (s.role !== "platform") {
    try { schoolName = (await request<{ name: string }>(s, "GET", "/school")).name; }
    catch (e) {
      if (e instanceof ServerError && e.status === 401) { session = null; saveSession(null); return signInView("Your token is no longer valid. Sign in again."); }
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
    el("span", { class: "who" }, `${schoolName ? schoolName + " · " : ""}${s.role === "platform" ? "Platform owner" : s.role === "admin" ? "School admin" : "Teacher"}: ${s.id}`), el("span", { class: "spacer" }),
    ...(s.role === "platform" ? [] : [el("a", { class: "btnlink", href: "/" }, "Editor")]), btn("Sign out", signOut));
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
