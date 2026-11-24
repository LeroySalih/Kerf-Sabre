import { describe, expect, it } from "vitest";
import { askToJoin, cleanGroupCode, decideJoinRequest, groupJoinRequests, myJoinRequests, requestLine, waitingLabel, waitingText } from "../src/joingroup";

describe("asking to join a group (shared 0.2.43)", () => {
  it("tidies the group code a pupil types", () => {
    expect(cleanGroupCode(" 9b-dt ")).toBe("9B-DT");
    expect(cleanGroupCode("9b dt")).toBe("9BDT");
    expect(cleanGroupCode("")).toBeNull();
    expect(cleanGroupCode("9B/DT")).toBeNull();
    expect(cleanGroupCode("x".repeat(33))).toBeNull();
  });
  it("says where each request is", () => {
    expect(requestLine({ groupCode: "9B-DT", status: "pending" })).toBe("Asked to join 9B-DT: waiting for your teacher");
    expect(requestLine({ groupCode: "9B-DT", groupLabel: "Year 9 DT", status: "approved" })).toBe("Joined 9B-DT (Year 9 DT)");
    expect(requestLine({ groupCode: "9B-DT", status: "declined" })).toMatch(/^9B-DT: your teacher declined/);
  });
  it("shows staff how many wait, and who", () => {
    expect(waitingText(0)).toBe("");
    expect(waitingText(undefined)).toBe("");
    expect(waitingText(3)).toBe("3 waiting to join");
    expect(waitingLabel({ pupilId: "D100" })).toBe("Pupil D100");
    expect(waitingLabel({ pupilId: "D100", displayName: "Dina Ode" })).toBe("Dina Ode (D100)");
  });
  it("calls the server", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => { calls.push(`${init?.method} ${url} ${init?.body ?? ""}`.trim()); return new Response("[]", { status: 200 }); }) as typeof fetch;
    const s = { baseUrl: "", token: "t", role: "pupil", id: "D100" };
    await askToJoin(s, "9B-DT", f);
    await myJoinRequests(s, f);
    await groupJoinRequests(s, "W9 B", f);
    await decideJoinRequest(s, "W9B", 7, true, f);
    await decideJoinRequest(s, "W9B", 8, false, f);
    expect(calls).toEqual(['POST /api/v1/groups/join {"groupCode":"9B-DT"}', "GET /api/v1/me/join-requests", "GET /api/v1/classes/W9%20B/join-requests",
      "POST /api/v1/classes/W9B/join-requests/7/approve", "POST /api/v1/classes/W9B/join-requests/8/decline"]);
  });
  it("keeps the server's words when a code is wrong", async () => {
    const f = (async () => new Response(JSON.stringify({ code: "not_found", message: "There is no group with the code NOPE in your school." }), { status: 404 })) as typeof fetch;
    await expect(askToJoin({ baseUrl: "", token: "t", role: "pupil", id: "D100" }, "NOPE", f)).rejects.toMatchObject({ status: 404, message: "There is no group with the code NOPE in your school." });
  });
});
