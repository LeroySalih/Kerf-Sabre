// The /register page's decisions, without the page (proprietary site code; tested in tests/site.test.ts). Shared 0.2.40.

export interface RegisterForm { schoolName: string; name: string; email: string; agreed: boolean }
export type RegisterField = keyof RegisterForm;
export type RegisterCheck =
  | { ok: true; body: { schoolName: string; name: string; email: string } }
  | { ok: false; field: RegisterField; message: string };
export type RegisterView = "form" | "sent" | "closed";

const EMAIL = /^[^@\s<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const tidy = (v: string): string => v.replace(/\s+/g, " ").trim();

/** Checks the form before it is sent (the server checks again). The first problem wins, so the page can put the cursor there. */
export function checkRegistration(f: RegisterForm): RegisterCheck {
  const schoolName = tidy(f.schoolName);
  const name = tidy(f.name);
  const email = f.email.trim();
  if (!schoolName) return { ok: false, field: "schoolName", message: "Fill in your school's name." };
  if (schoolName.length > 128) return { ok: false, field: "schoolName", message: "The school's name is too long (at most 128 characters)." };
  if (!name) return { ok: false, field: "name", message: "Fill in your name." };
  if (name.length > 128) return { ok: false, field: "name", message: "Your name is too long (at most 128 characters)." };
  if (name.includes("@")) return { ok: false, field: "name", message: "Put your name here, not your email address." };
  if (!email) return { ok: false, field: "email", message: "Fill in your school email address." };
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, field: "email", message: "That is not an email address." };
  if (!f.agreed) return { ok: false, field: "agreed", message: "Tick the box to say you work at this school and may sign it up." };
  return { ok: true, body: { schoolName, name, email } };
}

/** What `GET /auth/config` says: registration is open unless the server says `registration: false`. */
export const registrationOpen = (config: unknown): boolean =>
  !(config && typeof config === "object" && (config as { registration?: unknown }).registration === false);

/** The view to show after the server answered a registration: sent, closed (`registration_closed`), or the form again with the message. */
export const viewAfter = (code: string | null): RegisterView => (code === null ? "sent" : code === "registration_closed" ? "closed" : "form");
