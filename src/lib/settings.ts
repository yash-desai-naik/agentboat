import { useSyncExternalStore } from "react";

/** View preferences, remembered in local storage (per machine; nothing here is shared). */
export interface Settings {
  /** How edits, commands and replies appear while following or playing. */
  typing: "normal" | "fast" | "off";
  /** Replay speed. */
  speed: number;
  /** `real`: replay keeps the session's own pauses (long ones shortened); `even`: steady steps. */
  pacing: "real" | "even";
  /** The Claude panel: the main session only, or subagents' steps too. */
  chatScope: "main" | "all";
  sidebarWidth: number;
  chatWidth: number;
  panelHeight: number;
  showChat: boolean;
  showPanel: boolean;
  showSidebar: boolean;
  /** The timeline (scrubber and replay controls) under the editor; shown on demand. */
  showTimeline: boolean;
}

const DEFAULTS: Settings = {
  typing: "normal",
  speed: 1,
  pacing: "real",
  chatScope: "main",
  sidebarWidth: 260,
  chatWidth: 380,
  panelHeight: 250,
  showChat: true,
  showPanel: true,
  showSidebar: true,
  showTimeline: false,
};

const KEY = "ccb.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private storage or bad JSON: defaults */
  }
  return { ...DEFAULTS };
}

let current = load();
const subs = new Set<() => void>();

export const settings = {
  get: () => current,
  set(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* not remembered */
    }
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

export function useSettings(): Settings {
  return useSyncExternalStore(settings.subscribe, settings.get);
}
