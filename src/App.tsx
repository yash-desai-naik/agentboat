import { useEffect, useMemo, useRef, useState } from "react";
import { derive, type Focus } from "./lib/derive";
import { goLive, getSession, setPlaying, setWatch, stepBy, turnBy, useSession } from "./lib/store";
import { settings, useSettings } from "./lib/settings";
import { TitleBar } from "./ui/TitleBar";
import { SessionPicker, Welcome } from "./ui/SessionPicker";
import { AboutDialog } from "./ui/AboutDialog";
import { UpdateNotice } from "./ui/UpdateNotice";
import { ActivityBar, Sidebar, type View } from "./ide/Sidebar";
import { EditorArea } from "./ide/EditorArea";
import { TerminalPanel } from "./ide/TerminalPanel";
import { NetworkPanel } from "./ide/NetworkPanel";
import { Globe, Terminal } from "./ui/Icons";
import { ChatPanel } from "./ide/ChatPanel";
import { TimelineBar } from "./ide/TimelineBar";
import { StatusBar } from "./ide/StatusBar";
import { Splitter } from "./ui/Splitter";

const VIEW_FOR: Partial<Record<Focus, View>> = {
  editor: "explorer",
  search: "search",
  git: "git",
  tasks: "tasks",
  agents: "agents",
};

export function App() {
  const session = useSession();
  const { head, steps, cursor, phase, follow, playing } = session;
  const s = useSettings();
  const [picking, setPicking] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [view, setView] = useState<View>("explorer");
  const ide = useMemo(() => derive(steps, cursor, head, session.watch), [steps, cursor, head, session.watch]);

  // While following or playing, the side bar shows what Claude is doing, as a developer's would.
  // The bottom panel shows the terminal or the network log, whichever the current step is about
  // (on any move, so clicking a call in the Claude panel shows it).
  const [panelTab, setPanelTab] = useState<"terminal" | "network">("terminal");
  const lastPanelFocus = useRef<Focus | null>(null);
  useEffect(() => {
    if (ide.focus === lastPanelFocus.current) return;
    lastPanelFocus.current = ide.focus;
    if (ide.focus === "network") setPanelTab("network");
    else if (ide.focus === "terminal" || ide.focus === "git") setPanelTab("terminal");
  }, [ide.focus]);
  const lastFocus = useRef<Focus | null>(null);
  useEffect(() => {
    if (!(follow || playing)) return;
    if (ide.focus === lastFocus.current) return;
    lastFocus.current = ide.focus;
    const v = VIEW_FOR[ide.focus];
    if (v) setView(v);
  }, [ide.focus, follow, playing]);

  // Keys: ← → step, Shift+← → prompt, Space play, End live, Ctrl+O sessions, Ctrl+B/J/L panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setPicking(true);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "b") return void (e.preventDefault(), settings.set({ showSidebar: !settings.get().showSidebar }));
      if (ctrl && e.key.toLowerCase() === "j") return void (e.preventDefault(), settings.set({ showPanel: !settings.get().showPanel }));
      if (ctrl && e.shiftKey && e.code === "KeyT") return void (e.preventDefault(), settings.set({ showTeam: !settings.get().showTeam }));
      // Alt+Z: wrap long lines in the editor, as in VS Code (by key position, so any layout works).
      if (e.altKey && !ctrl && !e.shiftKey && e.code === "KeyZ") return void (e.preventDefault(), settings.set({ wordWrap: !settings.get().wordWrap }));
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "t") return void (e.preventDefault(), settings.set({ showTimeline: !settings.get().showTimeline }));
      if (ctrl && e.key.toLowerCase() === "l") return void (e.preventDefault(), settings.set({ showChat: !settings.get().showChat }));
      if (getSession().phase !== "ready") return;
      if (e.key === "Escape" && getSession().watch > 0 && !document.querySelector(".picker-backdrop, .dialog-backdrop, .app-menu")) {
        e.preventDefault();
        setWatch(0);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) turnBy(-1);
        else stepBy(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) turnBy(1);
        else stepBy(1);
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying(!getSession().playing);
      } else if (e.key === "End") {
        e.preventDefault();
        goLive();
      } else if (e.key === "Home") {
        e.preventDefault();
        stepBy(-1e9);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ready = phase === "ready" && head;
  // The team grid takes the editor and terminal area while it's open.
  const teamOn = s.showTeam && (head?.agents.length ?? 0) > 0;
  const cols = [
    "48px",
    s.showSidebar ? `${s.sidebarWidth}px` : "0px",
    "minmax(0, 1fr)",
    s.showChat ? `${s.chatWidth}px` : "0px",
  ].join(" ");

  return (
    <div className="app">
      <TitleBar onPick={() => setPicking(true)} onAbout={() => setAboutOpen(true)} />
      {!ready ? (
        <Welcome />
      ) : (
        <>
          <main className="workbench" style={{ gridTemplateColumns: cols }}>
            <ActivityBar
              view={view}
              ide={ide}
              head={head}
              onView={(v) => {
                if (v === view && s.showSidebar) settings.set({ showSidebar: false });
                else {
                  setView(v);
                  if (!s.showSidebar) settings.set({ showSidebar: true });
                }
              }}
            />
            <div className="sidebar-wrap">
              {s.showSidebar && (
                <>
                  <Sidebar view={view} ide={ide} head={head} steps={steps} />
                  <Splitter dir="x" value={s.sidebarWidth} min={180} max={520} onChange={(v) => settings.set({ sidebarWidth: v })} edge="right" />
                </>
              )}
            </div>
            <div className="center" style={{ gridTemplateRows: s.showPanel && !teamOn ? `minmax(0, 1fr) ${s.panelHeight}px` : "minmax(0, 1fr) 0px" }}>
              <EditorArea ide={ide} head={head} steps={steps} />
              <div className="panel-wrap">
                {s.showPanel && !teamOn && (
                  <>
                    <Splitter dir="y" value={s.panelHeight} min={100} max={700} onChange={(v) => settings.set({ panelHeight: v })} edge="top" />
                    {panelTab === "terminal" ? (
                      <TerminalPanel ide={ide} head={head} steps={steps} switcher={<PanelSwitch tab={panelTab} onTab={setPanelTab} calls={ide.network.length} />} />
                    ) : (
                      <NetworkPanel ide={ide} head={head} steps={steps} switcher={<PanelSwitch tab={panelTab} onTab={setPanelTab} calls={ide.network.length} />} />
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="chat-wrap">
              {s.showChat && (
                <>
                  <Splitter dir="x" value={s.chatWidth} min={260} max={720} onChange={(v) => settings.set({ chatWidth: v })} edge="left" />
                  <ChatPanel head={head} steps={steps} cursor={cursor} />
                </>
              )}
            </div>
          </main>
          {s.showTimeline && <TimelineBar />}
          <StatusBar ide={ide} head={head} />
        </>
      )}
      {picking && <SessionPicker onClose={() => setPicking(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      <UpdateNotice />
    </div>
  );
}

function PanelSwitch({ tab, onTab, calls }: { tab: "terminal" | "network"; onTab: (t: "terminal" | "network") => void; calls: number }) {
  return (
    <div className="panel-switch" role="tablist">
      <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "active" : ""} onClick={() => onTab("terminal")}>
        <Terminal size={14} /> Terminal
      </button>
      <button role="tab" aria-selected={tab === "network"} className={tab === "network" ? "active" : ""} onClick={() => onTab("network")} title="MCP, web and other tool calls">
        <Globe size={14} /> Network
        {calls > 0 && <span className="panel-count">{calls}</span>}
      </button>
    </div>
  );
}
