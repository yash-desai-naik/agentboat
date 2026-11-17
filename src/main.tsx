import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import { openSession, startUpdates } from "./lib/store";
import { appWindow, IN_TAURI } from "./lib/tauri";
import { startMotion } from "./lib/motion";
import "./styles.css";
import "./ide.css";
import "./panels.css";

// Light or dark with the system, switching live.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

startUpdates();
startMotion();
createRoot(document.getElementById("root")!).render(<App />);

// Reopen the session watched last, if its transcript is still there.
if (IN_TAURI) {
  let last: string | null = null;
  try {
    last = localStorage.getItem("ccb.last");
  } catch {
    /* none */
  }
  if (last) void openSession(last);
}

// The window starts hidden; show it after the first paint so there's no white flash.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    void appWindow?.show().then(() => appWindow?.setFocus()).catch(() => {});
  }),
);
