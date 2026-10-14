import { describe, expect, it } from "vitest";
import { ServerError, cutterCommand, normaliseBase, request, sendJob, signIn } from "../src/server";

const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("server client", () => {
  it("normalises the address", () => {
    expect(normaliseBase(" https://kerf.school/ ")).toBe("https://kerf.school");
    expect(normaliseBase("https://kerf.school/api/v1")).toBe("https://kerf.school");
    expect(normaliseBase("")).toBe("");
  });

  it("sends the bearer token to /api/v1 and parses the answer", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id: "job-1", status: "submitted" }), { status: 201 }); }) as unknown as typeof fetch;
    const r = await sendJob({ baseUrl: "https://k", token: "kp_abc", role: "pupil", id: "P1" }, { id: "x" } as never, f);
    expect(r.id).toBe("job-1");
    expect(seen!.url).toBe("https://k/api/v1/jobs");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer kp_abc");
    expect(seen!.init.method).toBe("POST");
  });

  it("turns server errors into readable ones", async () => {
    await expect(request({ baseUrl: "", token: "t" }, "POST", "/jobs", {}, reply(422, { code: "open_cut_path", message: "2 shapes are not closed" }))).rejects.toMatchObject({ message: "2 shapes are not closed", status: 422, code: "open_cut_path" });
    await expect(request({ baseUrl: "", token: "t" }, "GET", "/jobs", undefined, reply(401, { code: "unauthorized", message: "x" }))).rejects.toThrow(/token/);
  });

  it("explains a network failure", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(request({ baseUrl: "", token: "t" }, "GET", "/jobs", undefined, down)).rejects.toMatchObject({ code: "network" });
  });

  it("signs in with any role (a station token opens Station mode)", async () => {
    const s = await signIn("https://k/", "kp_1", reply(200, { role: "pupil", id: "P001" }));
    expect(s).toEqual({ baseUrl: "https://k", token: "kp_1", role: "pupil", id: "P001" });
    expect((await signIn("", "ks_1", reply(200, { role: "station", id: "station-1" }))).role).toBe("station");
    await expect(signIn("", "bad", reply(401, { code: "unauthorized", message: "x" }))).rejects.toBeInstanceOf(ServerError);
  });
});

import { ordinal, queueText } from "../src/server";
describe("queue text", () => {
  it("says where a job is in the queue", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "112th"]);
    expect(queueText(17, 1)).toBe("Ticket 17, you are next");
    expect(queueText(17, 3, 360)).toBe("Ticket 17, 3rd in the queue, about 6 min of cutting before yours");
    expect(queueText(17, null)).toBe("Ticket 17");
    expect(queueText(null, null)).toBe("");
  });
});

import { loginWithPin, parseIds, pinsCsv } from "../src/server";
describe("class login", () => {
  it("posts the class code, ID and PIN and returns a pupil session", async () => {
    let sent: { url: string; body: string } | undefined;
    const f = (async (url: string, init: RequestInit) => { sent = { url, body: String(init.body) }; return new Response(JSON.stringify({ token: "kp_x", role: "pupil", id: "P001", classCode: "9B-DT", expiresAt: "2026-10-14T20:00:00Z" }), { status: 200 }); }) as unknown as typeof fetch;
    const s = await loginWithPin("https://k/", " 9b-dt ", " P001 ", " 12345 ", f);
    expect(sent!.url).toBe("https://k/api/v1/auth/login");
    expect(JSON.parse(sent!.body)).toEqual({ classCode: "9b-dt", pupilId: "P001", pin: "12345" });
    expect(s).toMatchObject({ token: "kp_x", role: "pupil", id: "P001", classCode: "9B-DT", expiresAt: "2026-10-14T20:00:00Z" });
  });
  it("shows the server's own words for a wrong PIN or a lockout", async () => {
    const wrong = (async () => new Response(JSON.stringify({ code: "bad_login", message: "That class code, pupil ID or PIN is not right." }), { status: 401 })) as unknown as typeof fetch;
    await expect(loginWithPin("", "a", "b", "c", wrong)).rejects.toMatchObject({ message: "That class code, pupil ID or PIN is not right.", status: 401 });
    const locked = (async () => new Response(JSON.stringify({ code: "locked", message: "Too many wrong PINs." }), { status: 429 })) as unknown as typeof fetch;
    await expect(loginWithPin("", "a", "b", "c", locked)).rejects.toMatchObject({ code: "locked", status: 429 });
    const down = (async () => { throw new TypeError("x"); }) as unknown as typeof fetch;
    await expect(loginWithPin("", "a", "b", "c", down)).rejects.toMatchObject({ code: "network" });
  });
  it("splits pasted pupil IDs and writes the PIN sheet", () => {
    expect(parseIds("P1, P2;P3\nP2\n  P4  \n\n")).toEqual(["P1", "P2", "P3", "P4"]);
    expect(pinsCsv([{ pupilId: "P1", pin: "12345" }, { pupilId: "P2", pin: "00042" }])).toBe("pupilId,pin\nP1,12345\nP2,00042\n");
  });
});

describe("cutterCommand", () => {
  it("the real Cutter starts with run_cutter.bat and the address, token and laser", () => {
    expect(cutterCommand("http://192.168.1.20:8000/", "ks_abc-DEF_123", "station-1")).toBe("run_cutter.bat --url http://192.168.1.20:8000 --token ks_abc-DEF_123 --station station-1");
    expect(cutterCommand("https://kerf.school/api/v1", "ks_x", "bsk-laser-2", "real", "windows")).toBe("run_cutter.bat --url https://kerf.school --token ks_x --station bsk-laser-2");
  });
  it("the pretend Cutter is a Python script: python on Windows, python3 elsewhere", () => {
    expect(cutterCommand("http://h:8000", "ks_x", "station-1", "pretend", "windows")).toBe("python fake_cutter.py --url http://h:8000 --token ks_x --station station-1");
    expect(cutterCommand("http://h:8000", "ks_x", "station-1", "pretend", "unix")).toBe("python3 fake_cutter.py --url http://h:8000 --token ks_x --station station-1");
  });
  it("quotes anything with odd characters so it cannot break out of the command", () => {
    const c = cutterCommand("http://h:8000", "ks_a b;rm -rf $HOME", "s\"1", "pretend", "unix");
    expect(c).toContain('--token "ks_a b;rm -rf \\$HOME"');
    expect(c).toContain('--station "s\\"1"');
  });
});
