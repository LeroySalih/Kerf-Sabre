// A camera picture that keeps itself fresh: fetches the latest frame every so often and hands over an object URL.
import { cameraUrl, type Session } from "./server";

/** Calls `onFrame(url)` with each new picture (the previous URL is released after the handler returns). Returns a function that stops it. */
export function watchCamera(session: Session, station: string, onFrame: (url: string) => void, ms = 700): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, last: string | null = null;
  const tick = async () => {
    if (stopped) return;
    const u = await cameraUrl(session, station);
    if (u) {
      if (stopped) { URL.revokeObjectURL(u); return; }
      onFrame(u);
      if (last) URL.revokeObjectURL(last);
      last = u;
    }
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); if (last) URL.revokeObjectURL(last); };
}
