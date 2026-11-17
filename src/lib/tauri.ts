import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

/** False when the UI runs in a plain browser (`npm run dev`): no Rust, no window API. */
export const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const appWindow: Window | null = IN_TAURI ? getCurrentWindow() : null;

export const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac OS");
