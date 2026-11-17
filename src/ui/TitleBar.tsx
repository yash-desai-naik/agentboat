import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { checkForUpdates, useUpdate } from "../lib/update";
import { appWindow, IS_MAC } from "../lib/tauri";
import { useSession } from "../lib/store";
import { settings, useSettings } from "../lib/settings";
import { Chevron, PanelBottom, PanelLeft, PanelRight, Timeline } from "./Icons";

export function TitleBar({ onPick, onAbout }: { onPick: () => void; onAbout: () => void }) {
  const { head, phase } = useSession();
  const s = useSettings();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (!appWindow) return;
    const w = appWindow;
    const refresh = () => w.isMaximized().then(setMaximized).catch(() => {});
    refresh();
    void w.onResized(refresh).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  const title = head?.title ?? head?.name ?? (phase === "loading" ? "Opening…" : "No session open");
  const folder = head?.meta.cwd ? head.meta.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : null;

  return (
    <header className={IS_MAC ? "titlebar mac" : "titlebar"} data-tauri-drag-region>
      <AppMenu onAbout={onAbout} />
      <div className="tb-fill" data-tauri-drag-region />
      <button className="session-switch" onClick={onPick} title="Open another session (Ctrl+O)">
        {head && <span className={`st-dot s-${head.status}`} />}
        {folder && <span className="ss-folder">{folder}</span>}
        {folder && <span className="ss-sep">—</span>}
        <span className="ss-title">{title}</span>
        <Chevron size={11} open />
      </button>
      <div className="tb-fill" data-tauri-drag-region />
      {head && (
        <div className="layout-toggles">
          <button className="icon-btn" aria-pressed={s.showSidebar} title="Side bar (Ctrl+B)" onClick={() => settings.set({ showSidebar: !s.showSidebar })}>
            <PanelLeft />
          </button>
          <button className="icon-btn" aria-pressed={s.showPanel} title="Terminal panel (Ctrl+J)" onClick={() => settings.set({ showPanel: !s.showPanel })}>
            <PanelBottom />
          </button>
          <button className="icon-btn" aria-pressed={s.showTimeline} title="Timeline and replay (Ctrl+T)" onClick={() => settings.set({ showTimeline: !s.showTimeline })}>
            <Timeline />
          </button>
          <button className="icon-btn" aria-pressed={s.showChat} title="Claude panel (Ctrl+L)" onClick={() => settings.set({ showChat: !s.showChat })}>
            <PanelRight />
          </button>
        </div>
      )}
      {!IS_MAC && (
        <div className="caption-buttons">
          <button className="caption-btn" title="Minimize" onClick={() => appWindow?.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" aria-hidden="true">
              <path d="M0 5.5h10" />
            </svg>
          </button>
          <button className="caption-btn" title={maximized ? "Restore Down" : "Maximize"} onClick={() => appWindow?.toggleMaximize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" aria-hidden="true">
              {maximized ? (
                <>
                  <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
                  <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
                </>
              ) : (
                <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
              )}
            </svg>
          </button>
          <button className="caption-btn close" title="Close" onClick={() => appWindow?.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" fill="none" aria-hidden="true">
              <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}

/** "Ccboat ▾": the app's menu (updates, About, GitHub). A dot marks an update on offer. */
function AppMenu({ onAbout }: { onAbout: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const update = useUpdate();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className="app-menu-wrap" ref={box}>
      <button className={`brand${open ? " open" : ""}`} onClick={() => setOpen(!open)} title="Ccboat menu" aria-haspopup="menu" aria-expanded={open}>
        <img src="/icon.svg" width={16} height={16} alt="" />
        <span>Ccboat</span>
        {update.info && <span className="brand-dot" title={`Version ${update.info.version} is available`} />}
        <Chevron size={10} open />
      </button>
      {open && (
        <div className="app-menu" role="menu">
          {update.info ? (
            <button role="menuitem" onClick={pick(onAbout)}>
              Update to {update.info.version}…
            </button>
          ) : (
            <button role="menuitem" onClick={pick(() => void checkForUpdates())}>
              Check for updates
            </button>
          )}
          <button role="menuitem" onClick={pick(onAbout)}>
            About Ccboat
          </button>
          <div className="app-menu-sep" />
          <button role="menuitem" onClick={pick(() => void invoke("open_repo_page").catch(() => {}))}>
            Ccboat on GitHub
          </button>
          <button role="menuitem" onClick={pick(() => void invoke("open_releases_page").catch(() => {}))}>
            Releases and changelog
          </button>
        </div>
      )}
    </div>
  );
}
