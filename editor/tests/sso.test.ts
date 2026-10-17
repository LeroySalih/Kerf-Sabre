import { describe, expect, it } from "vitest";
import { Renewer, SsoError, beginSignIn, buildAuthorizeUrl, endSignIn, fetchAuthConfig, finishSignIn, pkceChallenge, randomString, readCallback, redirectUriFor, restoreSignIn, type SsoConfig } from "../src/sso";

const cfg: SsoConfig = {
  issuer: "https://dino.example", authorizeUrl: "https://dino.example/oauth/authorize", tokenUrl: "https://dino.example/oauth/token", revokeUrl: "https://dino.example/oauth/revoke",
  clientIds: { editor: "kerf-editor", admin: "kerf-admin" }, scopes: ["profile"],
};
const loc = { origin: "https://kerf.school", pathname: "/" };

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

type Call = { url: string; method: string; body: string; auth: string | null };
/** A fake DINO + Kerf server. */
function fakeNet(opts: { tokenStatus?: number; me?: unknown; name?: string | null } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? ""), auth: headers.Authorization ?? null });
    if (url === cfg.tokenUrl) {
      if (opts.tokenStatus && opts.tokenStatus >= 400) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "nope" }), { status: opts.tokenStatus });
      n++;
      return new Response(JSON.stringify({ access_token: `jwt-${n}`, refresh_token: `refresh-${n}`, token_type: "Bearer", expires_in: 900 }), { status: 200 });
    }
    if (url === cfg.revokeUrl) return new Response("", { status: 200 });
    if (url.endsWith("/api/v1/auth/me")) return new Response(JSON.stringify(opts.me ?? { role: "pupil", id: "u-1", school: "main" }), { status: 200 });
    if (url.endsWith("/api/v1/auth/profile")) return new Response(JSON.stringify({ name: opts.name === undefined ? "Ada Lovelace" : opts.name }), { status: 200 });
    if (url.endsWith("/api/v1/auth/config")) return new Response(JSON.stringify({ mode: "both", sso: cfg }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function signedInWith(net: ReturnType<typeof fakeNet>, st: MemStorage) {
  let went = "";
  await beginSignIn("editor", "", cfg, loc, (u) => { went = u; }, st);
  const r = (await finishSignIn("editor", `?code=C&state=${new URL(went).searchParams.get("state")}`, loc, net.f, st, 0))!;
  return { session: r.session };
}

describe("the person's name", () => {
  it("is kept on the session, in memory, once DINO has said it (never an email)", async () => {
    const st = new MemStorage();
    const net = fakeNet({ name: "Ada Lovelace" });
    const { session } = await signedInWith(net, st);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.name).toBe("Ada Lovelace");
    expect(JSON.stringify([...Array(st.length)].map((_, i) => st.getItem(st.key(i)!)))).not.toContain("Ada"); // not written to the tab's storage
  });
  it("is left empty when DINO cannot say", async () => {
    const net = fakeNet({ name: null });
    const { session } = await signedInWith(net, new MemStorage());
    await new Promise((r) => setTimeout(r, 0));
    expect(session.name).toBeUndefined();
  });
});

describe("PKCE and URLs", () => {
  it("matches the RFC 7636 example", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("makes long, different random strings", () => {
    const a = randomString(48), b = randomString(48);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });
  it("builds the authorize URL with S256 and the scope", () => {
    const u = new URL(buildAuthorizeUrl({ cfg, clientId: "kerf-editor", redirectUri: "https://kerf.school/", challenge: "CH", state: "ST" }));
    expect(u.origin + u.pathname).toBe(cfg.authorizeUrl);
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: "kerf-editor", redirect_uri: "https://kerf.school/", code_challenge: "CH", code_challenge_method: "S256", state: "ST", scope: "profile" });
  });
  it("redirects back to the page itself (Editor and Admin differ)", () => {
    expect(redirectUriFor({ origin: "https://k", pathname: "/" })).toBe("https://k/");
    expect(redirectUriFor({ origin: "https://k", pathname: "/admin/" })).toBe("https://k/admin/");
  });
  it("reads what DINO sends back", () => {
    expect(readCallback("")).toBeNull();
    expect(readCallback("?code=abc")).toBeNull(); // no state: not ours
    expect(readCallback("?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
    expect(readCallback("?error=access_denied&error_description=No&state=s")).toEqual({ error: "access_denied", description: "No" });
  });
});

describe("auth config", () => {
  it("is pins-only when the server is older or offline", async () => {
    expect(await fetchAuthConfig("", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toEqual({ mode: "pins", sso: null });
    expect(await fetchAuthConfig("", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toEqual({ mode: "pins", sso: null });
  });
  it("reads planner/both", async () => {
    expect((await fetchAuthConfig("https://kerf.school/", fakeNet().f)).mode).toBe("both");
  });
  it("ignores a half-formed answer", async () => {
    const f = (async () => new Response(JSON.stringify({ mode: "planner", sso: null }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchAuthConfig("", f)).toEqual({ mode: "pins", sso: null });
  });
});

describe("sign-in round trip", () => {
  it("goes to DINO, comes back, and trades the code (PKCE) for a session", async () => {
    const st = new MemStorage();
    let went = "";
    await beginSignIn("editor", "https://kerf.school", cfg, loc, (u) => { went = u; }, st);
    const q = new URL(went).searchParams;
    expect(q.get("client_id")).toBe("kerf-editor");
    expect(JSON.stringify([...st.m.values()])).not.toContain("access_token");

    const net = fakeNet();
    const r = await finishSignIn("editor", `?code=CODE&state=${q.get("state")}`, loc, net.f, st, 1_000_000);
    expect(r!.session).toMatchObject({ token: "jwt-1", role: "pupil", id: "u-1", sso: true, baseUrl: "https://kerf.school" });
    const tokenCall = net.calls.find((c) => c.url === cfg.tokenUrl)!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("CODE");
    expect(form.get("redirect_uri")).toBe("https://kerf.school/");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(await pkceChallenge(form.get("code_verifier")!)).toBe(q.get("code_challenge"));
    expect(net.calls.find((c) => c.url.endsWith("/auth/me"))!.auth).toBe("Bearer jwt-1");
    expect(r!.tokens.expiresAt).toBe(1_000_000 + 900_000);
  });

  it("refuses a return whose state is not the one we sent, and uses the attempt once", async () => {
    const st = new MemStorage();
    await beginSignIn("editor", "", cfg, loc, () => {}, st);
    const net = fakeNet();
    await expect(finishSignIn("editor", "?code=C&state=forged", loc, net.f, st)).rejects.toThrow(SsoError);
    expect(net.calls.some((c) => c.url === cfg.tokenUrl)).toBe(false);
    await expect(finishSignIn("editor", "?code=C&state=forged", loc, net.f, st)).rejects.toThrow(/did not start here/);
  });

  it("keeps the Editor and Admin attempts apart", async () => {
    const st = new MemStorage();
    let went = "";
    await beginSignIn("admin", "", cfg, { origin: "https://kerf.school", pathname: "/admin/" }, (u) => { went = u; }, st);
    await expect(finishSignIn("editor", `?code=C&state=${new URL(went).searchParams.get("state")}`, loc, fakeNet().f, st)).rejects.toThrow();
  });

  it("says so when the user cancels", async () => {
    await expect(finishSignIn("editor", "?error=access_denied&state=s", loc, fakeNet().f, new MemStorage())).rejects.toThrow(/cancelled/);
  });

  it("is not a sign-in return on an ordinary load", async () => {
    expect(await finishSignIn("editor", "", loc, fakeNet().f, new MemStorage())).toBeNull();
  });

  it("shows DINO's reason when the token request is refused", async () => {
    const st = new MemStorage();
    let went = "";
    await beginSignIn("editor", "", cfg, loc, (u) => { went = u; }, st);
    await expect(finishSignIn("editor", `?code=C&state=${new URL(went).searchParams.get("state")}`, loc, fakeNet({ tokenStatus: 400 }).f, st)).rejects.toThrow(/nope/);
  });
});

describe("staying signed in", () => {
  async function signedIn(st: MemStorage, net = fakeNet()) {
    let went = "";
    await beginSignIn("editor", "", cfg, loc, (u) => { went = u; }, st);
    return { net, r: (await finishSignIn("editor", `?code=C&state=${new URL(went).searchParams.get("state")}`, loc, net.f, st, 0))! };
  }

  it("keeps only the refresh token in sessionStorage, never the access token", async () => {
    const st = new MemStorage();
    await signedIn(st);
    const all = JSON.stringify([...st.m.entries()]);
    expect(all).toContain("refresh-1");
    expect(all).not.toContain("jwt-1");
  });

  it("restores after a reload and rotates the refresh token", async () => {
    const st = new MemStorage();
    await signedIn(st);
    const net = fakeNet();
    const r = await restoreSignIn("editor", net.f, st, 0);
    expect(r!.session.token).toBe("jwt-1"); // a fresh fake: its first token
    expect(new URLSearchParams(net.calls[0]!.body).get("refresh_token")).toBe("refresh-1");
    expect(st.getItem("kerf.sso.refresh.editor")).toContain("refresh-1");
  });

  it("restores nothing when there is nothing, or when DINO says no (and forgets it)", async () => {
    expect(await restoreSignIn("editor", fakeNet().f, new MemStorage())).toBeNull();
    const st = new MemStorage();
    await signedIn(st);
    expect(await restoreSignIn("editor", fakeNet({ tokenStatus: 400 }).f, st)).toBeNull();
    expect(st.getItem("kerf.sso.refresh.editor")).toBeNull();
  });

  it("renews a minute before expiry and updates the session in place", async () => {
    const st = new MemStorage();
    const { net, r } = await signedIn(st);
    const timers: { fn: () => void; ms: number }[] = [];
    let now = 0;
    const renewer = new Renewer("editor", r.session, r.tokens, () => { throw new Error("lost"); }, net.f, st, () => now, ((fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }) as unknown as typeof setTimeout, (() => {}) as unknown as typeof clearTimeout);
    expect(timers[0]!.ms).toBe(840_000);
    now = 840_000;
    await renewer.renew();
    expect(r.session.token).toBe("jwt-2");
    expect(timers).toHaveLength(2);
    expect(st.getItem("kerf.sso.refresh.editor")).toContain("refresh-2");
  });

  it("calls setTimeout and clearTimeout as plain functions (a browser throws \"Illegal invocation\" if `this` is anything but the window)", async () => {
    const st = new MemStorage();
    const { net, r } = await signedIn(st);
    const strict = (name: string, fn: (...a: unknown[]) => unknown) => function (this: unknown, ...a: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError(`Illegal invocation: ${name} was called on ${Object.prototype.toString.call(this)}`);
      return fn(...a);
    };
    const timers: { fn: () => void }[] = [];
    const setT = strict("setTimeout", (fn) => { timers.push({ fn: fn as () => void }); return timers.length; }) as unknown as typeof setTimeout;
    const clearT = strict("clearTimeout", () => undefined) as unknown as typeof clearTimeout;
    const renewer = new Renewer("editor", r.session, r.tokens, () => { throw new Error("lost"); }, net.f, st, () => 0, setT, clearT);
    expect(timers).toHaveLength(1);
    renewer.stop(); // calls clearTimeout
  });

  it("reports when DINO ends the sign-in", async () => {
    const st = new MemStorage();
    const { r } = await signedIn(st);
    let lost = "";
    const renewer = new Renewer("editor", r.session, r.tokens, (why) => { lost = why; }, fakeNet({ tokenStatus: 400 }).f, st, () => 0, (() => 1) as unknown as typeof setTimeout, (() => {}) as unknown as typeof clearTimeout);
    await renewer.renew();
    expect(lost).toMatch(/Sign in again/);
    expect(st.getItem("kerf.sso.refresh.editor")).toBeNull();
  });

  it("tries again soon, not sign-out, when only the network is down", async () => {
    const st = new MemStorage();
    const { r } = await signedIn(st);
    const timers: number[] = [];
    let lost = false;
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const renewer = new Renewer("editor", r.session, r.tokens, () => { lost = true; }, down, st, () => 0, ((_: () => void, ms: number) => { timers.push(ms); return 1; }) as unknown as typeof setTimeout, (() => {}) as unknown as typeof clearTimeout);
    await renewer.renew();
    expect(lost).toBe(false);
    expect(timers.at(-1)).toBe(15_000);
  });

  it("sign-out revokes the refresh token and forgets it", async () => {
    const st = new MemStorage();
    const { net } = await signedIn(st);
    await endSignIn("editor", net.f, st);
    const rev = net.calls.find((c) => c.url === cfg.revokeUrl)!;
    expect(new URLSearchParams(rev.body).get("token")).toBe("refresh-1");
    expect(new URLSearchParams(rev.body).get("client_id")).toBe("kerf-editor");
    expect(st.getItem("kerf.sso.refresh.editor")).toBeNull();
  });
});
