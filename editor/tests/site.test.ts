// The public website's pure parts (src/site/) and the Editor/Admin side of "one sign-in page" (src/signinpage.ts, sso.ts).
import { describe, expect, it } from "vitest";
import { EDITOR_QUERY_KEYS, SITE_FILES, editorForward } from "../src/site/routes";
import { OFFLINE_EDITOR, destinationFor, dinoAppFor, emailAppFor, linkIsSpent, planSignIn } from "../src/site/signinlogic";
import { checkRegistration, registrationOpen, viewAfter } from "../src/site/registerlogic";
import { otherTheme, readTheme, saveTheme, THEME_KEY } from "../src/site/theme";
import { PROBLEM_KEY, goToSignInPage, signInPageFor, takeProblem } from "../src/signinpage";
import { beginSignIn, finishSignIn, type SsoConfig } from "../src/sso";

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

describe("which queries at / are forwarded to the Editor", () => {
  it("forwards the Editor's old queries with the same query", () => {
    expect(editorForward("?station=station-1")).toBe("/editor/?station=station-1");
    expect(editorForward("code=C&state=S")).toBe("/editor/?code=C&state=S"); // DINO returns to <origin>/
    expect(editorForward("?error=access_denied&state=S")).toBe("/editor/?error=access_denied&state=S");
    expect(editorForward(`?signin=${TOKEN}`)).toBe(`/editor/?signin=${TOKEN}`);
    expect(editorForward("?offline=1")).toBe("/editor/?offline=1");
    expect(editorForward("?ref=leaflet&state=S")).toBe("/editor/?ref=leaflet&state=S");
    expect([...EDITOR_QUERY_KEYS].sort()).toEqual(["code", "error", "offline", "signin", "state", "station"]);
  });
  it("keeps everything else on the landing page", () => {
    expect(editorForward("")).toBeNull();
    expect(editorForward("?")).toBeNull();
    expect(editorForward("?utm_source=x")).toBeNull();
    expect(editorForward("?stations=1")).toBeNull();
  });
  it("maps the site's addresses to the built files", () => {
    expect(SITE_FILES).toEqual({ "/": "site/index.html", "/pricing": "site/pricing.html", "/sign-in": "site/sign-in.html", "/register": "site/register.html", "/editor/": "index.html" });
  });
});

describe("the sign-in page's first view", () => {
  it("is the form, on the pupil tab, for someone who came by themselves", () => {
    expect(planSignIn("")).toEqual({ view: "form", role: "pupil", app: null, token: null, register: false });
    expect(planSignIn("?app=editor")).toEqual({ view: "form", role: "pupil", app: "editor", token: null, register: false });
  });
  it("opens the staff tab when the Admin site sent them", () => {
    expect(planSignIn("?app=admin")).toMatchObject({ view: "form", role: "staff", app: "admin" });
    expect(planSignIn("?app=nonsense")).toMatchObject({ role: "pupil", app: null });
  });
  it("trades an emailed link, for the app the link names (the Admin site by default)", () => {
    expect(planSignIn(`?signin=${TOKEN}&app=admin`)).toEqual({ view: "busy", role: "staff", app: "admin", token: TOKEN, register: false });
    expect(planSignIn(`?signin=${TOKEN}&app=editor`)).toMatchObject({ view: "busy", app: "editor", token: TOKEN });
    expect(planSignIn(`?signin=${TOKEN}`)).toMatchObject({ app: "admin" });
  });
  it("shows the expired view for a broken link or when told the link did not work", () => {
    expect(planSignIn("?signin=short&app=editor")).toEqual({ view: "expired", role: "staff", app: "editor", token: null, register: false });
    expect(planSignIn("?signin=<script>")).toMatchObject({ view: "expired", token: null });
    expect(planSignIn("?app=admin&link=expired")).toMatchObject({ view: "expired", app: "admin" });
  });
  it("starts the right DINO sign-in and asks for the right link", () => {
    expect(dinoAppFor("pupil", null)).toBe("editor");
    expect(dinoAppFor("pupil", "admin")).toBe("editor");
    expect(dinoAppFor("staff", null)).toBe("admin");
    expect(dinoAppFor("staff", "editor")).toBe("editor"); // a teacher the Editor sent here goes back to the Editor
    expect(emailAppFor(null)).toBe("admin");
    expect(emailAppFor("editor")).toBe("editor");
  });
  it("tells a spent link from a network failure", () => {
    expect(linkIsSpent(401)).toBe(true);
    expect(linkIsSpent(404)).toBe(true);
    expect(linkIsSpent(0)).toBe(false);
    expect(linkIsSpent(503)).toBe(false);
    expect(linkIsSpent(undefined)).toBe(false);
  });
});

describe("where a signed-in person is sent", () => {
  it("goes to the Admin site or the Editor", () => {
    expect(destinationFor("admin")).toBe("/admin/");
    expect(destinationFor("admin", "station-1")).toBe("/admin/");
    expect(destinationFor("editor")).toBe("/editor/");
    expect(destinationFor("editor", "station 2")).toBe("/editor/?station=station%202"); // the Station link they followed first
    expect(OFFLINE_EDITOR).toBe("/editor/?offline=1");
  });
});

describe("the Editor and Admin site and the Kerf sign-in page", () => {
  it("use the sign-in page only when the Kerf Server's marker is on the page", () => {
    expect(signInPageFor("editor", "/sign-in")).toBe("/sign-in?app=editor");
    expect(signInPageFor("admin", " /sign-in ")).toBe("/sign-in?app=admin");
    expect(signInPageFor("editor", null)).toBeNull(); // Vite, a file, the Editor on its own
    expect(signInPageFor("editor", "")).toBeNull();
    expect(signInPageFor("editor", "//evil.example/x")).toBeNull();
    expect(signInPageFor("editor", "https://evil.example/")).toBeNull();
    expect(signInPageFor("editor", "javascript:alert(1)")).toBeNull();
  });
  it("leave the sign-in page a message, read once", () => {
    const st = new MemStorage();
    let went = "";
    goToSignInPage("/sign-in?app=editor", "Sign-in was cancelled.", { st, go: (u) => { went = u; } });
    expect(went).toBe("/sign-in?app=editor");
    expect(st.getItem(PROBLEM_KEY)).toBe("Sign-in was cancelled.");
    expect(takeProblem(st)).toBe("Sign-in was cancelled.");
    expect(takeProblem(st)).toBe("");
    goToSignInPage("/sign-in?app=admin", "", { expired: true, st, go: (u) => { went = u; } });
    expect(went).toBe("/sign-in?app=admin&link=expired");
    expect(st.getItem(PROBLEM_KEY)).toBeNull();
  });
});

describe("the Editor's DINO redirect URI is fixed to /", () => {
  const cfg: SsoConfig = {
    issuer: "https://dino.example", authorizeUrl: "https://dino.example/oauth/authorize", tokenUrl: "https://dino.example/oauth/token", revokeUrl: "https://dino.example/oauth/revoke",
    clientIds: { editor: "kerf-editor", admin: "kerf-admin" }, scopes: [],
  };
  const net = () => {
    const bodies: string[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      if (url === cfg.tokenUrl) { bodies.push(String(init.body)); return new Response(JSON.stringify({ access_token: "jwt", refresh_token: "r", expires_in: 900 }), { status: 200 }); }
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ role: "pupil", id: "u-1" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { f, bodies };
  };
  it("starts on /sign-in and finishes on /editor/ with the same <origin>/", async () => {
    const st = new MemStorage();
    let went = "";
    await beginSignIn("editor", "https://kerf.school", cfg, { origin: "https://kerf.school", pathname: "/sign-in" }, (u) => { went = u; }, st);
    const q = new URL(went).searchParams;
    expect(q.get("redirect_uri")).toBe("https://kerf.school/");
    expect(q.get("client_id")).toBe("kerf-editor");
    const n = net();
    await finishSignIn("editor", `?code=C&state=${q.get("state")}`, { origin: "https://kerf.school", pathname: "/editor/" }, n.f, st, 0);
    expect(new URLSearchParams(n.bodies[0]).get("redirect_uri")).toBe("https://kerf.school/");
  });
  it("the Admin site's stays /admin/ when started from /sign-in", async () => {
    let went = "";
    await beginSignIn("admin", "", cfg, { origin: "https://kerf.school", pathname: "/sign-in" }, (u) => { went = u; }, new MemStorage());
    expect(new URL(went).searchParams.get("redirect_uri")).toBe("https://kerf.school/admin/");
    expect(new URL(went).searchParams.get("client_id")).toBe("kerf-admin");
  });
});

describe("the theme switch", () => {
  it("is light unless dark was chosen, and survives storage that throws", () => {
    const st = new MemStorage();
    expect(readTheme(st)).toBe("light");
    saveTheme(st, otherTheme("light"));
    expect(st.getItem(THEME_KEY)).toBe("dark");
    expect(readTheme(st)).toBe("dark");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(readTheme(broken)).toBe("light");
    expect(() => saveTheme(broken, "dark")).not.toThrow();
    expect(readTheme(null)).toBe("light");
  });
});

describe("registering a school (shared 0.2.40)", () => {
  const ok = { schoolName: "  Westfield   High ", name: "Sam Taylor", email: " head@westfield.example ", agreed: true };
  it("tidies a good form into what the server is sent", () => {
    expect(checkRegistration(ok)).toEqual({ ok: true, body: { schoolName: "Westfield High", name: "Sam Taylor", email: "head@westfield.example" } });
  });
  it("names the first problem and its box", () => {
    expect(checkRegistration({ ...ok, schoolName: " " })).toMatchObject({ ok: false, field: "schoolName" });
    expect(checkRegistration({ ...ok, schoolName: "x".repeat(129) })).toMatchObject({ ok: false, field: "schoolName" });
    expect(checkRegistration({ ...ok, name: "" })).toMatchObject({ ok: false, field: "name" });
    expect(checkRegistration({ ...ok, name: "sam@westfield.example" })).toMatchObject({ ok: false, field: "name" });
    expect(checkRegistration({ ...ok, email: "" })).toMatchObject({ ok: false, field: "email" });
    expect(checkRegistration({ ...ok, email: "not an email" })).toMatchObject({ ok: false, field: "email", message: "That is not an email address." });
    expect(checkRegistration({ ...ok, email: "a@b" })).toMatchObject({ ok: false, field: "email" });
    expect(checkRegistration({ ...ok, agreed: false })).toMatchObject({ ok: false, field: "agreed" });
    expect(checkRegistration({ schoolName: "", name: "", email: "", agreed: false })).toMatchObject({ field: "schoolName" });
  });
  it("is open unless the server says registration: false", () => {
    expect(registrationOpen({ mode: "planner", registration: true })).toBe(true);
    expect(registrationOpen({ mode: "planner" })).toBe(true); // an older server
    expect(registrationOpen(null)).toBe(true);
    expect(registrationOpen({ registration: false })).toBe(false);
  });
  it("shows the sent view, the closed view, or the form with the message", () => {
    expect(viewAfter(null)).toBe("sent");
    expect(viewAfter("registration_closed")).toBe("closed");
    expect(viewAfter("too_many_attempts")).toBe("form");
  });
  it("a confirmation link on /sign-in sets up the school and opens the Admin site", () => {
    expect(planSignIn(`?register=${TOKEN}`)).toEqual({ view: "busy", role: "staff", app: "admin", token: TOKEN, register: true });
    expect(planSignIn(`?register=${TOKEN}&app=editor`)).toMatchObject({ app: "admin", register: true });
    expect(planSignIn("?register=short")).toEqual({ view: "expired", role: "staff", app: "admin", token: null, register: true });
    expect(planSignIn("?register=<script>aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ view: "expired", token: null });
    expect(destinationFor("admin")).toBe("/admin/");
  });
});
