// Pupil Cards (docs/ACCOUNTS.md): one small card per pupil with what they type to sign in (school code, group code, pupil ID,
// two-word password) and, if the teacher gave one, their name. Passwords are only known when they are made or reset, so cards are
// printed straight after adding pupils or making new passwords. Proprietary service screen (like the Admin site). Tested in
// tests/pupilcards.test.ts.

export interface PupilLine { id?: string; name?: string }
export interface Card { pupilId: string; password: string; displayName?: string | null }
export interface CardSheet { schoolName: string; schoolCode: string; groupCode: string; groupLabel?: string | null; signInUrl: string; cards: Card[] }

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What a teacher pastes, one pupil per line: `ID`, `ID, Name`, `, Name` or just `First Last` (a name with a space; Kerf makes
 * the ID). A single word is read as an ID, so write `, Zoe` for a one-word name. Tabs work like commas (pasting from a spreadsheet). */
export function parsePupilLines(text: string): { pupils: PupilLine[]; bad: string[] } {
  const pupils: PupilLine[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cut = line.search(/[,\t;]/);
    let id = "", name = "";
    if (cut >= 0) { id = line.slice(0, cut).trim(); name = line.slice(cut + 1).replace(/[,\t;]+/g, " ").trim(); }
    else if (/\s/.test(line)) name = line;
    else id = line;
    if (id && !ID.test(id)) { bad.push(line); continue; }
    if (!id && !name) continue;
    pupils.push({ ...(id ? { id } : {}), ...(name ? { name } : {}) });
  }
  return { pupils, bad };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The printable page: eight cards to an A4 sheet, cut along the dashed lines. Everything is escaped (names come from teachers). */
export function cardsHtml(sheet: CardSheet): string {
  const card = (c: Card) => `<article class="card">
<header><span class="logo" aria-hidden="true">K</span><span class="brand">Kerf</span><span class="school">${esc(sheet.schoolName)}</span></header>
<h2>${esc(c.displayName || `Pupil ${c.pupilId}`)}</h2>
<dl>
<dt>School code</dt><dd class="mono">${esc(sheet.schoolCode)}</dd>
<dt>Group code</dt><dd class="mono">${esc(sheet.groupCode)}</dd>
<dt>Pupil ID</dt><dd class="mono">${esc(c.pupilId)}</dd>
<dt>Password</dt><dd class="mono pw">${esc(c.password)}</dd>
</dl>
<p class="how">Go to <b>${esc(sheet.signInUrl)}</b>, choose <b>I'm a pupil</b> and type these in. Keep this card safe.</p>
</article>`;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Pupil Cards: ${esc(sheet.groupCode)}</title><style>
@page { size: A4; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Atkinson Hyperlegible", "Segoe UI", Arial, sans-serif; color: #18181b; }
.bar { display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: #f4f4f5; border-bottom: 1px solid #e4e4e7; font-size: 15px; }
.bar button { font: inherit; font-weight: 700; min-height: 40px; padding: 0 16px; border-radius: 8px; border: 0; background: #f97316; color: #18181b; cursor: pointer; }
.sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 0; padding: 0; }
.card { height: 68mm; padding: 6mm 7mm; border: 1px dashed #a1a1aa; break-inside: avoid; display: flex; flex-direction: column; gap: 2mm; }
header { display: flex; align-items: center; gap: 2mm; font-size: 10pt; }
.logo { display: inline-flex; width: 6mm; height: 6mm; border-radius: 1.5mm; background: #f97316; color: #18181b; font-weight: 700; align-items: center; justify-content: center; font-size: 9pt; }
.brand { font-weight: 700; }
.school { margin-left: auto; color: #52525b; }
h2 { margin: 1mm 0; font-size: 15pt; line-height: 1.15; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 1mm 4mm; font-size: 11pt; }
dt { color: #52525b; }
dd { margin: 0; font-weight: 700; }
.mono { font-family: "DejaVu Sans Mono", Consolas, monospace; letter-spacing: 0.04em; }
.pw { font-size: 13pt; }
.how { margin: auto 0 0; font-size: 8.5pt; color: #3f3f46; }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><b>${sheet.cards.length} Pupil Card${sheet.cards.length === 1 ? "" : "s"} for ${esc(sheet.groupCode)}${sheet.groupLabel ? ` (${esc(sheet.groupLabel)})` : ""}</b>
<span>These passwords are shown only now. Print the cards before closing this page.</span><button type="button" onclick="window.print()">Print</button></div>
<main class="sheet">${sheet.cards.map(card).join("\n")}</main>
</body></html>`;
}

/** Opens the cards in a new tab, ready to print. False if the browser blocked the new tab. */
export function openCards(sheet: CardSheet): boolean {
  const url = URL.createObjectURL(new Blob([cardsHtml(sheet)], { type: "text/html;charset=utf-8" }));
  const w = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return !!w;
}
