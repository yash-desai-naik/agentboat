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
  /** The team grid (a tile per agent at work) in place of the editor (Ctrl+Shift+T). */
  showTeam: boolean;
  /** Wrap long lines in the editor (Alt+Z, as in VS Code). */
  wordWrap: boolean;
  /** Look for a newer release on GitHub at start-up and once a day. */
  checkUpdates: boolean;
  /** A version you chose to skip: not announced again (a manual check still shows it). */
  skippedUpdate: string;
  /** Needs you: open the panel when a session starts waiting on you. */
  needsYouOpen: boolean;
  /** ...and bring AgentBoat to the front. */
  needsYouFront: boolean;
  /** List sessions that finish their turn, not only ones waiting on a prompt. */
  needsYouDone: boolean;
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
  showTeam: false,
  wordWrap: false,
  checkUpdates: true,
  skippedUpdate: "",
  needsYouOpen: true,
  needsYouFront: false,
  needsYouDone: true,
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
