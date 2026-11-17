import { useSyncExternalStore } from "react";
import { isPaused } from "./motion";

/** One shared one-second clock for every "running 12s" on screen; stopped while hidden. */
let now = Date.now();
let timer = 0;
const subs = new Set<() => void>();

function tick() {
  now = Date.now();
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  if (!timer) timer = window.setInterval(() => !document.hidden && !isPaused() && tick(), 1000);
  return () => {
    subs.delete(f);
    if (!subs.size) {
      window.clearInterval(timer);
      timer = 0;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
