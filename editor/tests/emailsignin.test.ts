import { describe, expect, it } from "vitest";
import { askForReset, changePassword, cleanLinkFromAddress, endEmailSignIn, finishEmailSignIn, finishRegistration, passwordSignIn, readLinkToken, restoreEmailSignIn, signInPageForLink } from "../src/emailsignin";
import { schoolChoices } from "../src/staffpassword";

class Mem implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "A".repeat(43);

describe("email sign-in", () => {
  it("reads only a well-formed link token", () => {
    expect(readLinkToken(`?signin=${TOKEN}`)).toBe(TOKEN);
    expect(readLinkToken("?signin=short")).toBeNull();
    expect(readLinkToken("?signin=<script>aaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(readLinkToken("?station=station-1")).toBeNull();
  });

  it("trades the link and the chosen password for a session kept in this tab, and restores and ends it", async () => {
    const calls: [string, string, string | null][] = [];
    const bodies: unknown[] = [];
    let alive = true;
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url, (init?.headers as Record<string, string> | undefined)?.Authorization ?? null]);
      if (url.endsWith("/auth/email/finish")) { bodies.push(JSON.parse(String(init?.body))); return json({ token: "kt_session", role: "teacher", id: "st-1", name: "Ms Art", expiresAt: "2026-11-24T20:00:00Z" }); }
      if (url.endsWith("/auth/me")) return alive ? json({ role: "teacher", id: "st-1", school: "westfield-high", plan: "free", method: "password", features: { laser: false, activities: false } }) : json({ code: "unauthorized", message: "no" }, 401);
      if (url.endsWith("/auth/logout")) { alive = false; return json({}); }
      return json({}, 404);
    }) as typeof fetch;
    const st = new Mem();
    const s = await finishEmailSignIn("admin", "", TOKEN, "violet canal biscuit", f, st);
    expect(bodies).toEqual([{ token: TOKEN, password: "violet canal biscuit" }]);
    expect(s).toMatchObject({ token: "kt_session", role: "teacher", school: "westfield-high", email: true, password: true, name: "Ms Art", features: { laser: false } });
    expect(JSON.parse(st.getItem("kerf.email.admin")!)).toEqual({ token: "kt_session", baseUrl: "" }); // never the password
    expect((await restoreEmailSignIn("admin", f, st))?.id).toBe("st-1");
    await endEmailSignIn("admin", s, f, st);
    expect(st.getItem("kerf.email.admin")).toBeNull();
    expect(calls.at(-1)).toEqual(["POST", "/api/v1/auth/logout", "Bearer kt_session"]);
    st.setItem("kerf.email.admin", JSON.stringify({ token: "kt_session", baseUrl: "" }));
    expect(await restoreEmailSignIn("admin", f, st)).toBeNull(); // the server says it is over: forgotten
    expect(st.getItem("kerf.email.admin")).toBeNull();
  });

  it("asks for a reset link and passes on the server's answer", async () => {
    let sent: unknown = null, where = "";
    const f = (async (u: string, init?: RequestInit) => { where = u; sent = JSON.parse(String(init?.body)); return json({ message: "If that address has a Kerf account, a link to set a new password is on its way." }); }) as typeof fetch;
    expect(await askForReset("", " art@school.example ", "editor", f)).toMatch(/^If that address/);
    expect(where).toBe("/api/v1/auth/password/forgot");
    expect(sent).toEqual({ email: "art@school.example", app: "editor" });
  });

  it("signs in with email and password, and asks which school when there are several", async () => {
    const sent: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/staff/login")) {
        const b = JSON.parse(String(init?.body)) as { school?: string };
        sent.push(b);
        if (!b.school) return json({ code: "choose_school", message: "Choose the school.", details: [{ school: "westfield-high", name: "Westfield High" }, { school: "eastfield", name: "Eastfield" }] }, 409);
        return json({ token: "kt_pw", role: "teacher", id: "st-2", expiresAt: "2026-11-24T20:00:00Z" });
      }
      if (url.endsWith("/auth/me")) return json({ role: "teacher", id: "st-2", school: "eastfield", method: "password" });
      return json({}, 404);
    }) as typeof fetch;
    const st = new Mem();
    const e = await passwordSignIn("admin", "", { email: " art@school.example", password: "violet canal biscuit" }, f, st).catch((x: unknown) => x);
    expect(schoolChoices(e)).toEqual([{ school: "westfield-high", name: "Westfield High" }, { school: "eastfield", name: "Eastfield" }]);
    expect(st.getItem("kerf.email.admin")).toBeNull();
    const s = await passwordSignIn("admin", "", { email: "art@school.example", password: "violet canal biscuit", school: "eastfield" }, f, st);
    expect(sent).toEqual([{ email: "art@school.example", password: "violet canal biscuit" }, { email: "art@school.example", password: "violet canal biscuit", school: "eastfield" }]);
    expect(s).toMatchObject({ school: "eastfield", password: true, email: true });
    expect(JSON.parse(st.getItem("kerf.email.admin")!)).toEqual({ token: "kt_pw", baseUrl: "" });
  });

  it("keeps the server's words for a wrong password", async () => {
    const f = (async () => json({ code: "bad_login", message: "That email address or password is not right." }, 401)) as typeof fetch;
    await expect(passwordSignIn("admin", "", { email: "a@b.example", password: "x" }, f, new Mem())).rejects.toThrow("That email address or password is not right.");
  });

  it("changes the password", async () => {
    let sent: unknown = null;
    const f = (async (_u: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return json({ message: "Your password has been changed." }); }) as typeof fetch;
    expect(await changePassword({ baseUrl: "", token: "kt", role: "teacher", id: "st-1" }, "old one", "a brand new password", f)).toMatch(/changed/);
    expect(sent).toEqual({ current: "old one", new: "a brand new password" });
  });

  it("sends a link opened on the Admin site or the Editor to the sign-in page", () => {
    expect(signInPageForLink(TOKEN, "editor")).toBe(`/sign-in?signin=${TOKEN}&app=editor`);
  });
});

describe("Pupil Card sign-in", () => {
  it("sends the four answers and keeps the session for the Editor in this tab", async () => {
    let sent: unknown = null;
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/pupil")) { sent = JSON.parse(String(init?.body)); return json({ token: "kp_card", role: "pupil", id: "20417", expiresAt: "2026-11-24T20:00:00Z" }); }
      if (url.endsWith("/auth/me")) return json({ role: "pupil", id: "20417", school: "westfield-high" });
      return json({}, 404);
    }) as typeof fetch;
    const st = new Mem();
    const { cardSignIn } = await import("../src/emailsignin");
    const s = await cardSignIn("", { schoolCode: " k7rpx ", groupCode: "9b-dt", pupilId: "20417 ", password: "Tiger River" }, f, st);
    expect(sent).toEqual({ schoolCode: "k7rpx", groupCode: "9b-dt", pupilId: "20417", password: "Tiger River" });
    expect(s).toMatchObject({ role: "pupil", id: "20417", email: true, token: "kp_card" });
    expect(JSON.parse(st.getItem("kerf.email.editor")!).token).toBe("kp_card");
  });

  it("passes on the server's message when the card is wrong", async () => {
    const f = (async () => json({ code: "bad_login", message: "That school code, group code, pupil ID or password is not right. Check your Pupil Card." }, 401)) as typeof fetch;
    const { cardSignIn } = await import("../src/emailsignin");
    await expect(cardSignIn("", { schoolCode: "A", groupCode: "B", pupilId: "C", password: "d" }, f, new Mem())).rejects.toThrow(/Check your Pupil Card/);
  });
});

describe("a new school's registration link (shared 0.2.40)", () => {
  it("makes the school, keeps the admin's session for the Admin site in this tab", async () => {
    const sent: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/register/finish")) { sent.push(JSON.parse(String(init?.body))); return json({ token: "ka_new", role: "admin", id: "st-9", name: "Sam Taylor", school: "westfield-high" }); }
      if (url.endsWith("/auth/me")) return json({ role: "admin", id: "st-9", school: "westfield-high", plan: "free", schoolCode: "K7QHM" });
      return json({}, 404);
    }) as typeof fetch;
    const st = new Mem();
    const s = await finishRegistration("", TOKEN, "violet canal biscuit", f, st);
    expect(sent).toEqual([{ token: TOKEN, password: "violet canal biscuit" }]);
    expect(s).toMatchObject({ role: "admin", school: "westfield-high", plan: "free", name: "Sam Taylor", email: true });
    expect(JSON.parse(st.getItem("kerf.email.admin")!)).toEqual({ token: "ka_new", baseUrl: "" });
  });
  it("passes on the server's words for a spent link", async () => {
    const f = (async () => json({ code: "link_invalid", message: "That link has expired or has already been used." }, 401)) as typeof fetch;
    await expect(finishRegistration("", TOKEN, "violet canal biscuit", f, new Mem())).rejects.toMatchObject({ status: 401, code: "link_invalid", message: "That link has expired or has already been used." });
  });
  it("takes the link out of the address", () => {
    const seen: string[] = [];
    cleanLinkFromAddress({ pathname: "/sign-in", search: `?register=${TOKEN}` } as Location, { replaceState: (_a: unknown, _b: string, u: string) => seen.push(u) } as unknown as History);
    expect(seen).toEqual(["/sign-in"]);
  });
});
