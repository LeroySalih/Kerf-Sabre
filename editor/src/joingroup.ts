// Pupils ask to join a group; a teacher approves (shared 0.2.45). The pupil types the group code their teacher gave them and waits;
// the request shows on the group's page on the Admin site. The words and the server calls live here (tested in tests/joingroup.test.ts).
import { request, type Session } from "./server";

export type JoinStatus = "pending" | "approved" | "declined";
/** One of the pupil's own requests (`GET /me/join-requests`). */
export interface JoinRequestDoc { id: number; groupCode: string; groupLabel?: string | null; status: JoinStatus; createdAt?: string | null; decidedAt?: string | null }
/** A pupil waiting to join a group, as its teacher sees them (`GET /classes/{code}/join-requests`). */
export interface WaitingPupil { id: number; pupilId: string; displayName?: string; createdAt?: string | null; archived?: boolean }

const CODE = /^[A-Za-z0-9_-]{1,32}$/;

/** What the pupil typed as a group code, tidied (spaces dropped, capitals), or null when it cannot be one. */
export function cleanGroupCode(raw: string): string | null {
  const c = raw.replace(/\s+/g, "").toUpperCase();
  return CODE.test(c) ? c : null;
}

export const STATUS_WORD: Record<JoinStatus, string> = { pending: "Waiting", approved: "Joined", declined: "Declined" };

/** The line a pupil reads about one request. */
export function requestLine(r: Pick<JoinRequestDoc, "groupCode" | "groupLabel" | "status">): string {
  const g = r.groupLabel ? `${r.groupCode} (${r.groupLabel})` : r.groupCode;
  if (r.status === "approved") return `Joined ${g}`;
  if (r.status === "declined") return `${g}: your teacher declined. Ask them if this is a mistake.`;
  return `Asked to join ${g}: waiting for your teacher`;
}

/** The badge on a group for its teacher: "" when nobody waits. */
export const waitingText = (n: number | null | undefined): string => (n ? `${n} waiting to join` : "");

/** How a waiting pupil is shown to staff: their name if Kerf has one, else "Pupil <ID>". */
export const waitingLabel = (w: Pick<WaitingPupil, "pupilId" | "displayName">): string => (w.displayName ? `${w.displayName} (${w.pupilId})` : `Pupil ${w.pupilId}`);

type Fetch = typeof fetch;
export const askToJoin = (s: Session, groupCode: string, f: Fetch = fetch): Promise<JoinRequestDoc> => request<JoinRequestDoc>(s, "POST", "/groups/join", { groupCode }, f);
export const myJoinRequests = (s: Session, f: Fetch = fetch): Promise<JoinRequestDoc[]> => request<JoinRequestDoc[]>(s, "GET", "/me/join-requests", undefined, f);
export const groupJoinRequests = (s: Session, code: string, f: Fetch = fetch): Promise<WaitingPupil[]> =>
  request<WaitingPupil[]>(s, "GET", `/classes/${encodeURIComponent(code)}/join-requests`, undefined, f);
export const decideJoinRequest = (s: Session, code: string, id: number, approve: boolean, f: Fetch = fetch): Promise<{ id: number; status: JoinStatus }> =>
  request(s, "POST", `/classes/${encodeURIComponent(code)}/join-requests/${id}/${approve ? "approve" : "decline"}`, undefined, f);
