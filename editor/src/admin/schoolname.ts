// Renaming the school (Admin site, School page; shared 0.2.47). The same rules as the server's `clean_school_name`:
// trimmed, 1 to 128 characters, no line breaks or other control characters. The school ID and school code never change.

export const SCHOOL_NAME_MAX = 128;

/** The cleaned name, or what is wrong with it (in the words shown to the admin). */
export function checkSchoolName(raw: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (!name) return { error: "Give the school a name." };
  // Python's isprintable(): no control or format characters, and no spaces other than the ordinary one.
  if ([...name].some((c) => c !== " " && /[\p{C}\p{Z}]/u.test(c))) return { error: "The school's name cannot have line breaks or other control characters." };
  if ([...name].length > SCHOOL_NAME_MAX) return { error: `The school's name can be up to ${SCHOOL_NAME_MAX} characters.` };
  return { name };
}
