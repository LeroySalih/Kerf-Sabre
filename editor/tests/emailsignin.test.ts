import { describe, expect, it } from "vitest";
import { askForLink, endEmailSignIn, finishEmailSignIn, readLinkToken, restoreEmailSignIn } from "../src/emailsignin";

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

  it("trades the link for a session kept in this tab, and restores and ends it", async () => {
    const calls: [string, string, string | null][] = [];
    let alive = true;
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url, (init?.headers as Record<string, string> | undefined)?.Authorization ?? null]);
      if (url.endsWith("/auth/email/finish")) return json({ token: "kt_session", role: "teacher", id: "st-1", name: "Ms Art", expiresAt: "2026-11-24T20:00:00Z" });
      if (url.endsWith("/auth/me")) return alive ? json({ role: "teacher", id: "st-1", school: "westfield-high", plan: "free", features: { laser: false, activities: false } }) : json({ code: "unauthorized", message: "no" }, 401);
      if (url.endsWith("/auth/logout")) { alive = false; return json({}); }
      return json({}, 404);
    }) as typeof fetch;
    const st = new Mem();
    const s = await finishEmailSignIn("admin", "", TOKEN, f, st);
    expect(s).toMatchObject({ token: "kt_session", role: "teacher", school: "westfield-high", email: true, name: "Ms Art", features: { laser: false } });
    expect(JSON.parse(st.getItem("kerf.email.admin")!)).toEqual({ token: "kt_session", baseUrl: "" });
    expect((await restoreEmailSignIn("admin", f, st))?.id).toBe("st-1");
    await endEmailSignIn("admin", s, f, st);
    expect(st.getItem("kerf.email.admin")).toBeNull();
    expect(calls.at(-1)).toEqual(["POST", "/api/v1/auth/logout", "Bearer kt_session"]);
    st.setItem("kerf.email.admin", JSON.stringify({ token: "kt_session", baseUrl: "" }));
    expect(await restoreEmailSignIn("admin", f, st)).toBeNull(); // the server says it is over: forgotten
    expect(st.getItem("kerf.email.admin")).toBeNull();
  });

  it("asks for a link and passes on the server's answer", async () => {
    let sent: unknown = null;
    const f = (async (_u: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return json({ message: "If that address belongs to a Kerf account, a sign-in link is on its way." }); }) as typeof fetch;
    expect(await askForLink("", " art@school.example ", "editor", f)).toMatch(/^If that address/);
    expect(sent).toEqual({ email: "art@school.example", app: "editor" });
  });
});
