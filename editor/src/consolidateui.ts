// The "Import pupils' files" window: pick a class, see the files waiting in its queue, tick the ones to bring into the open file.
import { makeDraggable } from "./dialog";
import { QUEUE_QUERY, describeFile, filesForClass, materialWarning } from "./consolidate";
import { classPupils, listClasses, listJobsByStatus, type ClassInfo, type JobSummary, type Session } from "./server";

export interface ConsolidateChoice { jobs: JobSummary[]; labels: boolean }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

/** Resolves with the files chosen (and whether to label them), or null if cancelled. `materialName` turns a preset id into its label. */
export function chooseFiles(session: Session, materialName: (id: string) => string): Promise<ConsolidateChoice | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "kdialog wide";
    const h = el("h2", { textContent: "Import pupils’ files" });
    dlg.append(h);
    makeDraggable(dlg, h);
    dlg.append(el("p", { className: "hint", textContent: "Brings the files waiting in the queue for a class into the open file, each as one group you can move around. The files stay in the queue." }));

    const classSel = el("select", { id: "cons-class" });
    const status = el("p", { className: "hint", role: "status" });
    const list = el("div", { className: "klist" });
    const warn = el("p", { className: "kwarn" });
    const labels = el("input", { type: "checkbox", checked: true });
    const all = el("button", { type: "button", textContent: "Select all" });
    const none = el("button", { type: "button", textContent: "Select none" });
    const ok = el("button", { type: "button", className: "on", textContent: "Import", disabled: true });
    const cancel = el("button", { type: "button", textContent: "Cancel" });

    dlg.append(
      el("label", { className: "krowfield" }, "Class ", classSel),
      status,
      el("div", { className: "krow left" }, all, none),
      list,
      warn,
      el("label", { className: "kcheck" }, labels, " Put each pupil’s name above their file (on the Ignore layer, so it is never cut)"),
      el("div", { className: "krow" }, cancel, ok),
    );

    let queue: JobSummary[] | null = null;
    let shown: JobSummary[] = [];
    const boxes: HTMLInputElement[] = [];
    const chosen = () => shown.filter((_, i) => boxes[i]!.checked);
    const refresh = () => {
      const c = chosen();
      ok.disabled = !c.length;
      ok.textContent = c.length ? `Import ${c.length} file${c.length === 1 ? "" : "s"}` : "Import";
      warn.textContent = materialWarning(c, materialName);
    };
    const render = () => {
      list.replaceChildren();
      boxes.length = 0;
      for (const j of shown) {
        const box = el("input", { type: "checkbox", checked: true });
        box.addEventListener("change", refresh);
        boxes.push(box);
        list.append(el("label", { className: "kitem" }, box, " ", describeFile(j, materialName)));
      }
      refresh();
    };
    const pick = async (code: string) => {
      shown = []; render();
      if (!code) return;
      status.textContent = "Loading…";
      try {
        const [pupils, jobs] = await Promise.all([classPupils(session, code), queue ? Promise.resolve(queue) : listJobsByStatus(session, QUEUE_QUERY)]);
        queue = jobs;
        shown = filesForClass(jobs, pupils);
        status.textContent = shown.length ? `${shown.length} file${shown.length === 1 ? "" : "s"} in the queue for this class.` : "Nothing from this class is waiting in the queue.";
        render();
      } catch (e) {
        status.textContent = `Could not load the queue: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    classSel.addEventListener("change", () => void pick(classSel.value));
    all.addEventListener("click", () => { boxes.forEach((b) => (b.checked = true)); refresh(); });
    none.addEventListener("click", () => { boxes.forEach((b) => (b.checked = false)); refresh(); });

    let answer: ConsolidateChoice | null = null;
    ok.addEventListener("click", () => { answer = { jobs: chosen(), labels: labels.checked }; dlg.close(); });
    cancel.addEventListener("click", () => dlg.close());
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(answer); });
    dlg.showModal();

    status.textContent = "Loading classes…";
    listClasses(session).then((cs: ClassInfo[]) => {
      classSel.replaceChildren(new Option(cs.length ? "Choose a class…" : "No classes", ""), ...cs.map((c) => new Option(c.label ? `${c.code} – ${c.label}` : c.code, c.code)));
      status.textContent = cs.length ? "" : "You have no classes yet.";
      if (cs.length === 1) { classSel.value = cs[0]!.code; void pick(cs[0]!.code); }
    }, (e) => { status.textContent = `Could not load classes: ${e instanceof Error ? e.message : String(e)}`; });
  });
}
