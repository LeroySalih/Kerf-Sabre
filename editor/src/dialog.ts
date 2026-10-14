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

/** Resolves with the entered values, or null if the dialog was cancelled. Native validation covers min/max/step. */
export function openDialog(title: string, fields: DialogField[], opts: { intro?: string; ok?: string } = {}): Promise<Record<string, DialogValue> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const h = document.createElement("h2");
    h.textContent = title;
    form.append(h);
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

    let result: Record<string, DialogValue> | null = null;
    form.addEventListener("submit", () => {
      result = {};
      for (const f of fields) {
        const el = inputs.get(f.key)!;
        result[f.key] = f.type === "number" ? parseFloat(el.value) : el.value;
      }
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    dlg.showModal();
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
