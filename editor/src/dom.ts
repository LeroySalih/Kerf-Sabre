// Tiny DOM helpers shared by the dialogs.
export type Kid = string | Node;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

export function btn(label: string, fn: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", { type: "button", class: cls }, label);
  b.addEventListener("click", fn);
  return b;
}

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A modal dialog that removes itself when closed. */
export function modal(cls = "kdialog"): { dlg: HTMLDialogElement; show: () => Promise<void> } {
  const dlg = el("dialog", { class: cls });
  return {
    dlg,
    show: () => new Promise<void>((resolve) => {
      document.body.append(dlg);
      dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
      dlg.showModal();
    }),
  };
}

/** "5 Nov, 15:00" for a due date; "" for none. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * A list that runs from where it starts down to the bottom of the window and scrolls inside itself, so no row is ever
 * off the screen (every queue: the Admin site's Queue and Processed files, the Station page). Call `fit` after each
 * redraw; `stop` removes the resize listener.
 */
export function fillWindow(box: HTMLElement, gap = 24, min = 200): { fit: () => void; stop: () => void } {
  box.classList.add("qc-scroll");
  const fit = () => { if (box.isConnected) box.style.maxHeight = `${Math.max(min, Math.floor(window.innerHeight - box.getBoundingClientRect().top - gap))}px`; };
  window.addEventListener("resize", fit);
  return { fit, stop: () => window.removeEventListener("resize", fit) };
}
