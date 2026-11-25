import { describe, expect, it } from "vitest";
import { ServerError } from "../src/server";
import { RULES, checkForgot, checkNewPassword, checkSignIn, schoolChoices } from "../src/staffpassword";

describe("choosing a password (shared 0.2.47)", () => {
  it("accepts a good one typed twice", () => {
    expect(checkNewPassword("violet canal biscuit", "violet canal biscuit", "art@school.example")).toBeNull();
    expect(checkNewPassword("abc".repeat(40), "abc".repeat(40))).toBeNull(); // 120 characters is fine
  });
  it("says what is wrong, first problem first", () => {
    expect(checkNewPassword("", "")).toMatch(/Choose a password/);
    expect(checkNewPassword("short", "short")).toBe("Use at least 10 characters. Three random words work well.");
    expect(checkNewPassword("y".repeat(129), "y".repeat(129))).toMatch(/at most 128/);
    expect(checkNewPassword("art@school.example", "art@school.example", "art@school.example")).toMatch(/email address/);
    expect(checkNewPassword("school.example", "school.example", "art@school.example")).toMatch(/email address/);
    expect(checkNewPassword("Password123", "Password123")).toMatch(/too easy/);
    expect(checkNewPassword("aaaaaaaaaaaa", "aaaaaaaaaaaa")).toMatch(/too easy/);
    expect(checkNewPassword("violet canal biscuit", "violet canal biscuits")).toMatch(/not the same/);
  });
  it("shows the rules", () => {
    expect(RULES[0]).toMatch(/At least 10 characters/);
  });
});

describe("the sign-in boxes", () => {
  it("need an email address and a password", () => {
    expect(checkSignIn("", "x")).toEqual({ message: "Type your school email address.", field: "email" });
    expect(checkSignIn("not an email", "x")).toMatchObject({ field: "email" });
    expect(checkSignIn("art@school.example", "")).toEqual({ message: "Type your password.", field: "password" });
    expect(checkSignIn(" art@school.example ", "anything")).toBeNull();
  });
  it("Forgot your password? needs the email box", () => {
    expect(checkForgot("")).toMatch(/first/);
    expect(checkForgot("nope")).toMatch(/not an email/);
    expect(checkForgot("art@school.example")).toBeNull();
  });
  it("reads the schools to choose from", () => {
    const e = new ServerError("Choose", 409, "choose_school", [{ school: "a", name: "A School" }, { school: "b" }, { nonsense: 1 }] as unknown as { path: string; message: string }[]);
    expect(schoolChoices(e)).toEqual([{ school: "a", name: "A School" }, { school: "b", name: "b" }]);
    expect(schoolChoices(new ServerError("x", 401, "bad_login"))).toBeNull();
    expect(schoolChoices(new Error("x"))).toBeNull();
  });
});
