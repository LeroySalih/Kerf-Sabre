// Staff passwords (shared 0.2.47): the checks the forms make before asking the server, which checks them again (server/kerf_server/
// services_staffpw.py). Staff sign in with their school email + password; email only checks the address. Pure, tested in
// tests/staffpassword.test.ts. A password is never stored, logged or shown by any of this.
import { ServerError } from "./server";

export const MIN_LEN = 10;
export const MAX_LEN = 128;
/** What the Choose a password view shows. */
export const RULES = [
  `At least ${MIN_LEN} characters. Three random words work well, like "violet canal biscuit".`,
  "Not your email address, and not a common password.",
];
/** A few of the commonest long passwords (the server has the same short list). */
const COMMON = new Set(["password123", "password1234", "qwerty1234", "qwertyuiop", "1234567890", "kerf123456", "iloveyou12", "letmein123", "welcome123"]);

/** The first problem with a new password, or null. `email` (when known) may not be used as the password. */
export function checkNewPassword(password: string, repeat: string, email = ""): string | null {
  if (!password) return `Choose a password. Use at least ${MIN_LEN} characters.`;
  if (password.length < MIN_LEN) return `Use at least ${MIN_LEN} characters. Three random words work well.`;
  if (password.length > MAX_LEN) return `Use at most ${MAX_LEN} characters.`;
  const folded = password.toLowerCase();
  if (email && email.toLowerCase().includes(folded)) return "Do not use your email address as your password. Three random words work well.";
  if (COMMON.has(folded) || new Set(folded).size < 3) return "That password is too easy to guess. Three random words work well.";
  if (repeat !== password) return "The two passwords are not the same. Type it again in both boxes.";
  return null;
}

/** The first problem with the sign-in boxes, and which box gets the cursor; null when both are filled in. */
export function checkSignIn(email: string, password: string): { message: string; field: "email" | "password" } | null {
  const e = email.trim();
  if (!e) return { message: "Type your school email address.", field: "email" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { message: "That is not an email address.", field: "email" };
  if (!password) return { message: "Type your password.", field: "password" };
  return null;
}

/** "Forgot your password?" needs the email box filled in first. */
export function checkForgot(email: string): string | null {
  const e = email.trim();
  if (!e) return "Type your school email address first, then press Forgot your password? again.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "That is not an email address.";
  return null;
}

export interface SchoolChoice { school: string; name: string }

/** The schools to choose from when the same email and password are good at more than one (`409 choose_school`). */
export function schoolChoices(e: unknown): SchoolChoice[] | null {
  if (!(e instanceof ServerError) || e.code !== "choose_school" || !Array.isArray(e.details)) return null;
  const out = (e.details as unknown[]).flatMap((d) => {
    const x = d as { school?: unknown; name?: unknown };
    return typeof x.school === "string" ? [{ school: x.school, name: typeof x.name === "string" && x.name ? x.name : x.school }] : [];
  });
  return out.length ? out : null;
}
