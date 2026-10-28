// A small modal parameter dialog on the native <dialog> element.
export type DialogValue = number | string;

export interface DialogField {
  key: string;
  label: string;
  type: "number" | "select" | "text" | "password";
  value: DialogValue;
  min?: number;
  max?: number;
  /** Whole numbers only (counts). Other number fields accept any decimal. */
  integer?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
}

export interface DialogOptions {
  intro?: string;
  ok?: string;
  /**
   * A live preview. Called with the values every time one changes (and once at the start), and with null when the values are not
   * usable or the dialog closes, so the caller can draw and clear its preview. A returned string is shown in the dialog (a count, or what is wrong).
   * A dialog with a preview has no dimmed backdrop, and starts at the side, so the drawing underneath can be seen.
   */
  onChange?: (values: Record<string, DialogValue> | null) => string | void;
}

/** Let a dialog be dragged by its title, so what is underneath can be seen. Stays within the window. */
export function makeDraggable(dlg: HTMLElement, handle: HTMLElement): void {
  handle.classList.add("kdrag");
  handle.title = "Drag to move this window";
  const place = (left: number, top: number) => {
    const r = dlg.getBoundingClientRect();
    dlg.style.position = "fixed";
    dlg.style.margin = "0";
    dlg.style.inset = "auto";
    dlg.style.left = `${Math.min(Math.max(left, 80 - r.width), window.innerWidth - 80)}px`;
    dlg.style.top = `${Math.min(Math.max(top, 0), window.innerHeight - 40)}px`;
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = dlg.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    place(r.left, r.top);
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  (dlg as HTMLElement & { placeAt?: (l: number, t: number) => void }).placeAt = place;
}

/** Resolves with the entered values, or null if the dialog was cancelled. Native validation covers min/max/step. */
export function openDialog(title: string, fields: DialogField[], opts: DialogOptions = {}): Promise<Record<string, DialogValue> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const h = document.createElement("h2");
    h.textContent = title;
    form.append(h);
    makeDraggable(dlg, h);
    if (opts.onChange) dlg.classList.add("seethrough");
    if (opts.intro) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = opts.intro;
      form.append(p);
    }
    const grid = document.createElement("div");
    grid.className = "kgrid";
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const f of fields) {
      const label = document.createElement("label");
      label.append(document.createTextNode(f.label));
      let el: HTMLInputElement | HTMLSelectElement;
      if (f.type === "select") {
        el = document.createElement("select");
        for (const o of f.options ?? []) el.add(new Option(o.label, o.value));
        el.value = String(f.value);
      } else if (f.type === "text" || f.type === "password") {
        el = document.createElement("input");
        el.type = f.type;
        el.autocomplete = "off";
        el.spellcheck = false;
        el.value = String(f.value);
      } else {
        el = document.createElement("input");
        el.type = "number";
        el.required = true;
        if (f.min !== undefined) el.min = String(f.min);
        if (f.max !== undefined) el.max = String(f.max);
        el.step = f.integer ? "1" : "any"; // a step would also reject typed values that are not multiples of it
        el.value = String(f.value);
      }
      el.name = f.key;
      if (f.hint) el.title = f.hint;
      label.append(el);
      grid.append(label);
      inputs.set(f.key, el);
    }
    form.append(grid);
    const status = document.createElement("p");
    status.className = "hint kstatus";
    status.setAttribute("role", "status");
    if (opts.onChange) form.append(status);
    const row = document.createElement("div");
    row.className = "krow";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "on";
    ok.textContent = opts.ok ?? "OK";
    row.append(cancel, ok);
    form.append(row);
    dlg.append(form);
    document.body.append(dlg);

    /** The values as they are now, or null if a number field is empty or not a number. */
    const current = (): Record<string, DialogValue> | null => {
      const v: Record<string, DialogValue> = {};
      for (const f of fields) {
        const el = inputs.get(f.key)!;
        const val = f.type === "number" ? parseFloat(el.value) : el.value;
        if (typeof val === "number" && !Number.isFinite(val)) return null;
        v[f.key] = val;
      }
      return v;
    };
    const update = () => { if (opts.onChange) status.textContent = opts.onChange(current()) ?? ""; };
    form.addEventListener("input", update);
    form.addEventListener("change", update);

    let result: Record<string, DialogValue> | null = null;
    form.addEventListener("submit", () => {
      result = {};
      for (const f of fields) {
        const el = inputs.get(f.key)!;
        result[f.key] = f.type === "number" ? parseFloat(el.value) : el.value;
      }
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { opts.onChange?.(null); dlg.remove(); resolve(result); });
    dlg.showModal();
    if (opts.onChange) { // start at the right-hand side, out of the way of the drawing, and show the first preview
      const r = dlg.getBoundingClientRect();
      (dlg as HTMLElement & { placeAt?: (l: number, t: number) => void }).placeAt?.(window.innerWidth - r.width - 24, 130);
      update();
    }
    (inputs.values().next().value as HTMLElement | undefined)?.focus();
  });
}

/** A message dialog with an OK button and, optionally, a list of lines. */
export function infoDialog(title: string, lines: string[], opts: { intro?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog";
    const h = document.createElement("h2");
    h.textContent = title;
    dlg.append(h);
    makeDraggable(dlg, h);
    if (opts.intro) {
      const p = document.createElement("p");
      p.textContent = opts.intro;
      dlg.append(p);
    }
    if (lines.length) {
      const ul = document.createElement("ul");
      for (const l of lines) ul.append(Object.assign(document.createElement("li"), { textContent: l }));
      dlg.append(ul);
    }
    const ok = document.createElement("button");
    ok.className = "on";
    ok.textContent = "OK";
    ok.addEventListener("click", () => dlg.close());
    dlg.append(ok);
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    dlg.showModal();
    ok.focus();
  });
}
