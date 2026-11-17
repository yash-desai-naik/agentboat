import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Detail, Head, SessionEntry, Step } from "./types";
import { IN_TAURI } from "./tauri";
import { settings } from "./settings";

/**
 * The open session and where in it the view is.
 *
 * `cursor` is the step the IDE shows (everything up to and including it). Following live, the
 * cursor moves to each new step as it arrives, one at a time with time for its animation, and
 * jumps ahead when Claude is faster than the animations, so the view never lags. Playing a replay
 * moves it the same way, paced by the speed setting. `anim` marks the step that just became
 * current through following or playing: views animate only that one, never a step you seek to.
 */

export interface Anim {
  i: number;
  at: number;
  /** How long the step has on screen before the next one (ms). */
  dur: number;
}

export interface SessionState {
  phase: "pick" | "loading" | "ready" | "error";
  error: string | null;
  head: Head | null;
  steps: Step[];
  cursor: number;
  follow: boolean;
  playing: boolean;
  anim: Anim | null;
}

let state: SessionState = {
  phase: "pick",
  error: null,
  head: null,
  steps: [],
  cursor: -1,
  follow: false,
  playing: false,
  anim: null,
};
const subs = new Set<() => void>();

function set(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getSession(): SessionState {
  return state;
}

export const isLive = (h: Head | null) => !!h && h.status !== "ended";

// ---------- opening ----------

let openSeq = 0;

export async function openSession(path: string) {
  const seq = ++openSeq;
  stopDirector();
  clearDetails();
  set({ phase: "loading", error: null, playing: false, anim: null });
  try {
    const r = await invoke<{ head: Head; steps: Step[] }>("open_session", { path });
    if (seq !== openSeq) return;
    const live = isLive(r.head);
    set({
      phase: "ready",
      head: r.head,
      steps: r.steps,
      cursor: r.steps.length - 1,
      follow: live,
      playing: false,
      anim: null,
    });
    try {
      localStorage.setItem("ccb.last", path);
    } catch {
      /* not remembered */
    }
  } catch (e) {
    if (seq !== openSeq) return;
    set({ phase: "error", error: String(e) });
  }
}

export function closeSession() {
  openSeq++;
  stopDirector();
  clearDetails();
  if (IN_TAURI) void invoke("close_session");
  set({ phase: "pick", head: null, steps: [], cursor: -1, follow: false, playing: false, anim: null });
}

export async function listSessions(): Promise<SessionEntry[]> {
  if (!IN_TAURI) return [];
  return invoke<SessionEntry[]>("list_sessions");
}

// ---------- live updates ----------

interface Update {
  session: string;
  head: Head;
  steps: Step[];
}

export function startUpdates() {
  if (!IN_TAURI) return;
  void listen<Update>("ccb:update", (e) => {
    const u = e.payload;
    if (!state.head || u.session !== state.head.id || state.phase !== "ready") return;
    let steps = state.steps;
    if (u.steps.length) {
      steps = steps.slice();
      for (const s of u.steps) steps[s.i] = s;
    }
    set({ head: u.head, steps });
    if (state.follow) kick();
  });
}

// ---------- moving the cursor ----------

/** You moved: stop following and playing, no animation. */
export function seek(i: number) {
  const last = state.steps.length - 1;
  const c = Math.max(0, Math.min(last, i));
  stopDirector();
  set({ cursor: c, follow: false, playing: false, anim: null });
}

export function stepBy(d: number) {
  seek(state.cursor + d);
}

/** The previous or next prompt of yours (main session). */
export function turnBy(d: number) {
  const { steps, cursor } = state;
  if (d < 0) {
    // From inside a turn, back goes to its own prompt first.
    for (let i = cursor - 1; i >= 0; i--) if (steps[i].kind === "prompt" && steps[i].agent === 0) return seek(i);
    return seek(0);
  }
  for (let i = cursor + 1; i < steps.length; i++) if (steps[i].kind === "prompt" && steps[i].agent === 0) return seek(i);
  seek(steps.length - 1);
}

export function goLive() {
  stopDirector();
  set({ follow: true, playing: false, cursor: state.steps.length - 1, anim: null });
}

export function setPlaying(on: boolean) {
  stopDirector();
  if (!on) return set({ playing: false });
  const atEnd = state.cursor >= state.steps.length - 1;
  set({ playing: true, follow: false, cursor: atEnd ? 0 : state.cursor, anim: null });
  kick();
}

// ---------- the director: following and playing ----------

let timer = 0;

function stopDirector() {
  window.clearTimeout(timer);
  timer = 0;
}

/** Time a step gets on screen, by kind, before the next. */
function dwell(s: Step): number {
  const t = settings.get().typing;
  if (t === "off") return 160;
  const f = t === "fast" ? 0.5 : 1;
  let ms = 260;
  if (s.kind === "tool") {
    if (s.cat === "edit" || s.cat === "write") ms = 1100;
    else if (s.cat === "shell" || s.cat === "git") ms = 850;
    else if (s.cat === "read") ms = 450;
    else ms = 350;
  } else if (s.kind === "say") ms = 650;
  else if (s.kind === "prompt") ms = 600;
  return ms * f;
}

function kick() {
  if (timer) return;
  advance();
}

function advance() {
  timer = 0;
  const { steps, cursor, follow, playing } = state;
  const last = steps.length - 1;
  if (!(follow || playing) || cursor >= last) {
    if (playing && cursor >= last) set({ playing: false });
    return;
  }
  let next = cursor + 1;
  // Following live: never more than a few steps behind Claude.
  if (follow && last - cursor > 4) next = last - 1;
  const step = steps[next];
  let dur = dwell(step);
  if (playing) {
    const sp = settings.get().speed;
    if (settings.get().pacing === "real" && next < last) {
      const gap = steps[next + 1].ts - step.ts;
      dur = Math.max(dur, Math.min(gap, 2500));
    }
    dur = dur / sp;
  }
  set({ cursor: next, anim: { i: next, at: performance.now(), dur } });
  timer = window.setTimeout(advance, Math.max(40, dur));
}

// ---------- details ----------

const details = new Map<string, Detail | null>();
const wanted = new Map<string, { session: string; i: number }>();
let detailsVersion = 0;
const detailSubs = new Set<() => void>();
let flushQueued = false;

function clearDetails() {
  details.clear();
  wanted.clear();
}

const keyOf = (s: Step) => `${s.i}:${s.v}`;

function requestDetail(s: Step) {
  const k = keyOf(s);
  if (details.has(k) || wanted.has(k) || !state.head) return;
  wanted.set(k, { session: state.head.id, i: s.i });
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flush);
  }
}

async function flush() {
  flushQueued = false;
  if (!wanted.size || !IN_TAURI) return;
  const batch = [...wanted.entries()];
  const session = batch[0][1].session;
  const ids = batch.map(([, w]) => w.i);
  try {
    const out = await invoke<(Detail | null)[]>("step_details", { session, ids });
    if (state.head?.id !== session) return;
    batch.forEach(([k], n) => details.set(k, out[n] ?? null));
  } catch {
    batch.forEach(([k]) => details.set(k, null));
  }
  batch.forEach(([k]) => wanted.delete(k));
  // Keep the cache bounded: drop the oldest entries.
  while (details.size > 600) {
    const first = details.keys().next().value;
    if (first === undefined) break;
    details.delete(first);
  }
  detailsVersion++;
  detailSubs.forEach((f) => f());
}

function subscribeDetails(f: () => void) {
  detailSubs.add(f);
  return () => {
    detailSubs.delete(f);
  };
}

/** A step's detail: undefined while loading, null when it has none. */
export function useDetail(s: Step | null | undefined): Detail | null | undefined {
  useSyncExternalStore(subscribeDetails, () => detailsVersion);
  if (!s) return undefined;
  const k = keyOf(s);
  if (details.has(k)) return details.get(k);
  requestDetail(s);
  return undefined;
}

/** Several steps' details (the terminal's history). */
export function useDetails(list: Step[]): (Detail | null | undefined)[] {
  useSyncExternalStore(subscribeDetails, () => detailsVersion);
  return list.map((s) => {
    const k = keyOf(s);
    if (details.has(k)) return details.get(k);
    requestDetail(s);
    return undefined;
  });
}
