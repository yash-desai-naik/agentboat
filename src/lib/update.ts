import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { settings } from "./settings";
import { IN_TAURI } from "./tauri";

/**
 * Updates, as in Fileboat: Rust (src-tauri/src/update.rs) asks GitHub's latest release for a newer
 * version and installs it; this module schedules the checks and holds what the UI shows. Checks
 * run ~20 s after start-up and once a day while "Check for updates automatically" is on, and
 * whenever you press "Check for updates".
 */

/** A newer AgentBoat release. */
export interface UpdateInfo {
  version: string;
  current: string;
  /** Release notes, Markdown. */
  notes: string;
  date: string | null;
}

export type UpdatePhase = "idle" | "checking" | "uptodate" | "downloading" | "installing" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** The update on offer, if any. */
  info: UpdateInfo | null;
  /** Show the notice in the corner (closed with Later / Skip; opened again by a new check). */
  noticeOpen: boolean;
  downloaded: number;
  total: number | null;
  error: string | null;
}

let state: UpdateState = { phase: "idle", info: null, noticeOpen: false, downloaded: 0, total: null, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A check that only speaks up when there's something new (and not a version you skipped). */
async function quietCheck() {
  if (!settings.get().checkUpdates || state.phase === "downloading" || state.phase === "installing") return;
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (info && info.version !== settings.get().skippedUpdate) set({ info, noticeOpen: true, phase: "idle", error: null });
    else if (info) set({ info });
  } catch {
    /* offline or GitHub unreachable: try again tomorrow */
  }
}

export function startUpdateChecks() {
  if (!IN_TAURI) return;
  void listen<{ downloaded: number; total: number | null }>("update:progress", (e) =>
    set({ phase: "downloading", downloaded: e.payload.downloaded, total: e.payload.total }),
  );
  void listen("update:installing", () => set({ phase: "installing" }));
  // After a reload, an update found earlier is still on offer (shown in About, no pop-up).
  void invoke<UpdateInfo | null>("update_status")
    .then((info) => info && !state.info && set({ info }))
    .catch(() => {});
  window.setTimeout(() => {
    void quietCheck();
    window.setInterval(() => void quietCheck(), 24 * 60 * 60 * 1000);
  }, 20_000);
}

let upToDateTimer: number | undefined;

/** "Check for updates": the notice shows the result either way. */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  set({ phase: "checking", error: null, noticeOpen: true });
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (info) {
      set({ phase: "idle", info, noticeOpen: true });
    } else {
      set({ phase: "uptodate", info: null });
      window.clearTimeout(upToDateTimer);
      upToDateTimer = window.setTimeout(() => state.phase === "uptodate" && set({ phase: "idle", noticeOpen: false }), 5000);
    }
    return info;
  } catch (err) {
    set({ phase: "error", error: errorText(err) });
    return null;
  }
}

/** Download, verify and install; AgentBoat starts again on the new version. */
export async function installUpdate() {
  set({ phase: "downloading", downloaded: 0, total: null, error: null, noticeOpen: true });
  try {
    await invoke("update_install");
  } catch (err) {
    set({ phase: "error", error: errorText(err) });
  }
}

export function closeNotice() {
  set({ noticeOpen: false, phase: state.phase === "error" || state.phase === "uptodate" ? "idle" : state.phase });
}

/** Don't announce this version again (a manual check still shows it). */
export function skipUpdate() {
  if (state.info) settings.set({ skippedUpdate: state.info.version });
  set({ noticeOpen: false });
}

export function openReleasesPage() {
  void invoke("open_releases_page").catch(() => {});
}
