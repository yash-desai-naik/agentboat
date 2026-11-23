import { useEffect, useMemo, useRef, useState } from "react";
import { ago, bytes } from "../lib/format";
import { listSessions, openSession, useSession } from "../lib/store";
import type { SessionEntry } from "../lib/types";
import { IN_TAURI } from "../lib/tauri";
import { openInClaudeCode } from "../lib/attention";
import { Terminal } from "./Icons";
import { ScrollJump } from "./ScrollJump";
import { settings, useSettings } from "../lib/settings";
import { Extras } from "./Onboarding";

const STATUS: Record<string, string> = { busy: "Working", waiting: "Needs you", idle: "Idle" };

/** Every session you can watch: running ones first, then recent ones. Refreshed while open. */
export function SessionList({ onOpened, autoFocus }: { onOpened?: () => void; autoFocus?: boolean }) {
  const [list, setList] = useState<SessionEntry[] | null>(null);
  const [limit, setLimit] = useState(80);
  const [older, setOlder] = useState(0);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const { head } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      listSessions(limit)
        .then((p) => {
          if (stop) return;
          setList(p.sessions);
          setOlder(p.older);
        })
        .catch(() => !stop && setList([]));
    void load();
    const t = window.setInterval(load, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [limit]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? []).filter((s) => {
      const hay = `${s.title ?? ""} ${s.lastPrompt ?? ""} ${s.folder} ${s.cwd ?? ""} ${s.branch ?? ""} ${s.name ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [list, q]);

  useEffect(() => setSel(0), [q]);

  const open = (s: SessionEntry) => {
    void openSession(s.path);
    onOpened?.();
  };

  const live = shown.filter((s) => s.live);
  const recent = shown.filter((s) => !s.live);

  return (
    <div
      className="session-list"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => Math.min(shown.length - 1, v + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => Math.max(0, v - 1));
        } else if (e.key === "Enter" && shown[sel]) {
          e.preventDefault();
          open(shown[sel]);
        }
      }}
    >
      <input ref={input} className="sl-filter" placeholder="Filter by title, prompt, folder or branch" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      <ScrollJump target={scroll} />
      <div className="sl-scroll" ref={scroll}>
        {!IN_TAURI && <p className="side-empty">Run AgentBoat as the desktop app to see your sessions.</p>}
        {list === null && IN_TAURI && <p className="side-empty">Looking for sessions…</p>}
        {list && list.length === 0 && (
          <p className="side-empty">
            No Claude Code sessions yet. Run <code>claude</code> in a project folder and the session shows up here right away.
          </p>
        )}
        {list && list.length > 0 && shown.length === 0 && <p className="side-empty">No sessions match.</p>}
        {live.length > 0 && <div className="sl-group">Running now</div>}
        {live.map((s) => (
          <Row key={s.path} s={s} selected={shown.indexOf(s) === sel} current={head?.id === s.id} onOpen={() => open(s)} />
        ))}
        {recent.length > 0 && <div className="sl-group">Recent</div>}
        {recent.map((s) => (
          <Row key={s.path} s={s} selected={shown.indexOf(s) === sel} current={head?.id === s.id} onOpen={() => open(s)} />
        ))}
        {older > 0 && list && (
          <button className="sl-older" onClick={() => setLimit((l) => l + 100)}>
            Show older sessions <span className="dim">({older} more)</span>
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ s, selected, current, onOpen }: { s: SessionEntry; selected: boolean; current: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const status = s.live ? (s.status === "busy" ? "working" : s.status === "waiting" ? "waiting" : "idle") : "ended";
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className={`sl-row-wrap${selected ? " selected" : ""}`} data-path={s.cwd ?? undefined} data-session={s.id} data-cwd={s.cwd ?? undefined}>
    <button ref={ref} className={`sl-row${selected ? " selected" : ""}${current ? " current" : ""}`} onClick={onOpen} title={s.path}>
      <span className={`st-dot s-${status}`} />
      <span className="sl-main">
        <span className="sl-title ellipsis">{s.title ?? s.lastPrompt ?? "Untitled session"}</span>
        <span className="sl-sub ellipsis">
          <b>{s.folder}</b>
          {s.branch && <> · {s.branch}</>}
          {s.lastPrompt && s.title && <> · “{s.lastPrompt}”</>}
        </span>
      </span>
      <span className="sl-meta">
        <span>{s.live ? STATUS[s.status ?? ""] ?? "Running" : ago(s.modified)}</span>
        <span className="dim">{note ?? bytes(s.size)}</span>
      </span>
    </button>
      <button
        className="sl-occ"
        title={s.live ? "Open in Claude Code: bring its terminal to the front" : "Open in Claude Code: resume it in a new terminal"}
        aria-label="Open in Claude Code"
        onClick={() =>
          void openInClaudeCode(s.id, s.cwd)
            .then((how) => setNote(how === "focused" ? "In front" : "Resumed"))
            .catch((e) => setNote(String(e)))
        }
      >
        <Terminal size={14} />
      </button>
    </div>
  );
}

export function SessionPicker({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="picker" role="dialog" aria-label="Open a session">
        <SessionList onOpened={onClose} autoFocus />
      </div>
    </div>
  );
}

export function Welcome() {
  const { phase, error } = useSession();
  // First run: a welcome, the two optional extras, and a tour once a session opens.
  const first = !useSettings().onboarded;
  return (
    <div className={`welcome${first ? " first" : ""}`}>
      <div className="welcome-inner">
        <div className="welcome-head">
          <img src="/icon.svg" width={44} height={44} alt="" />
          <div>
            {first ? (
              <>
                <h1>Welcome to AgentBoat</h1>
                <p>
                  See any Claude Code session as an IDE, live as Claude works or replayed step by step. It only watches: nothing is ever changed. Pick a
                  session below and a short tour shows you around.{" "}
                  <button className="link-btn" onClick={() => settings.set({ onboarded: true, toured: true })}>
                    Skip the tour
                  </button>
                </p>
              </>
            ) : (
              <>
                <h1>Watch a Claude Code session</h1>
                <p>Pick a session to see it as an IDE: files opening and changing, commands in the terminal, git in Source Control. Running sessions update live; finished ones replay step by step. Nothing is ever changed.</p>
              </>
            )}
          </div>
        </div>
        {first && <Extras />}
        {phase === "error" && <div className="editor-banner err">{error}</div>}
        {phase === "loading" ? <p className="side-empty">Reading the transcript…</p> : <SessionList autoFocus />}
      </div>
    </div>
  );
}
