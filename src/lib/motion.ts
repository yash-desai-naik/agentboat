/**
 * Keeps looping animations cheap. WebView2 costs about the same per frame drawn whatever moves
 * (measured for Agentsboat), so:
 *
 * - Loops are stepped in CSS (a few changes a second, never 60 fps), and their start times are
 *   pinned to a shared one-second grid here, so every loop on screen changes on the same frames:
 *   ten blinking dots cost what one does.
 * - While the window is minimized or the page hidden, every animation is paused. WebView2 keeps a
 *   minimized window's page "visible", so the window itself is asked.
 *
 * The typing animations (edits, commands, replies) are driven by requestAnimationFrame and
 * throttle themselves with `frameDue`.
 */

import { appWindow } from "./tauri";

const GRID_MS = 1000;
let paused = false;
const listeners = new Set<(paused: boolean) => void>();

function isLoop(a: Animation): boolean {
  return a.effect?.getTiming().iterations === Infinity;
}

function align(a: Animation) {
  if (!isLoop(a) || a.startTime === null) return;
  const t = Number(a.startTime);
  const pinned = Math.floor(t / GRID_MS) * GRID_MS;
  if (pinned !== t) a.startTime = pinned;
}

function apply(next: boolean) {
  if (next === paused) return;
  paused = next;
  document.documentElement.dataset.motion = next ? "paused" : "run";
  for (const a of document.getAnimations()) {
    if (next) a.pause();
    else {
      a.play();
      align(a);
    }
  }
  listeners.forEach((f) => f(next));
}

export function isPaused() {
  return paused;
}

export function onPause(f: (paused: boolean) => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** For requestAnimationFrame loops: whether enough time has passed to draw again (≈30 fps). */
export function frameDue(last: { t: number }, now: number, everyMs = 33): boolean {
  if (now - last.t < everyMs) return false;
  last.t = now;
  return true;
}

export function startMotion() {
  // A loop that starts (an element appears) joins the grid, or stays still while paused.
  document.addEventListener(
    "animationstart",
    (e) => {
      const el = e.target as Element;
      for (const a of el.getAnimations()) {
        if (paused) a.pause();
        else align(a);
      }
    },
    true,
  );
  const check = () => {
    if (document.hidden) return apply(true);
    if (!appWindow) return apply(false);
    void appWindow
      .isMinimized()
      .then((m) => apply(m || document.hidden))
      .catch(() => {});
  };
  document.addEventListener("visibilitychange", check);
  if (appWindow) {
    void appWindow.onResized(check);
    void appWindow.onFocusChanged(check);
  }
  check();
}
