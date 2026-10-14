import { describe, expect, it } from "vitest";
import { ServerError, normaliseBase, request, sendJob, signIn } from "../src/server";

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

  it("signs in and refuses a station token", async () => {
    const s = await signIn("https://k/", "kp_1", reply(200, { role: "pupil", id: "P001" }));
    expect(s).toEqual({ baseUrl: "https://k", token: "kp_1", role: "pupil", id: "P001" });
    await expect(signIn("", "ks_1", reply(200, { role: "station", id: "station-1" }))).rejects.toBeInstanceOf(ServerError);
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
