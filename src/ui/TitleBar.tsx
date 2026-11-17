import { useEffect, useState } from "react";
import { appWindow, IS_MAC } from "../lib/tauri";
import { useSession } from "../lib/store";
import { settings, useSettings } from "../lib/settings";
import { Chevron, PanelBottom, PanelLeft, PanelRight, Timeline } from "./Icons";

export function TitleBar({ onPick }: { onPick: () => void }) {
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
      <div className="brand" data-tauri-drag-region>
        <img src="/icon.svg" width={16} height={16} alt="" data-tauri-drag-region />
        <span data-tauri-drag-region>Ccboat</span>
      </div>
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
