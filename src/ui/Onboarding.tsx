import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settings, useSettings } from "../lib/settings";
import { hookStatus, setHook, type HookStatus } from "../lib/attention";
import { limitsStatus, refreshLimitsInstalled, setLimits, type LimitsStatus } from "../lib/usage";
import { IN_TAURI } from "../lib/tauri";
import { Dialog } from "./Dialog";

// ---------- the two optional extras, offered on the first-run welcome ----------

/**
 * "Answer prompts" and "Show usage limits", each one click away. They are the only things
 * AgentBoat writes outside its own folder, so nothing is turned on without asking.
 */
export function Extras() {
  const [hook, setHookSt] = useState<HookStatus | null>(null);
  const [lim, setLim] = useState<LimitsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    void hookStatus().then(setHookSt).catch(() => {});
    void limitsStatus().then(setLim).catch(() => {});
  };
  useEffect(load, []);
  if (!IN_TAURI) return null;
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
    load();
    void refreshLimitsInstalled();
  };
  const rows = [
    {
      key: "hook",
      name: "Answer prompts in AgentBoat",
      desc: "Approve permissions, answer Claude's questions and sign off on plans from any session, right here.",
      on: hook?.installed,
      set: (on: boolean) => setHook(on),
    },
    {
      key: "limits",
      name: "Show usage limits",
      desc: "Your 5-hour and weekly usage, with when each resets, in the status bar.",
      on: lim?.installed,
      set: (on: boolean) => setLimits(on),
    },
  ];
  return (
    <div className="extras">
      <div className="extras-head">
        <b>Two optional extras</b>
        <span className="dim">Each adds one entry to Claude Code's settings.json. Turn them off any time from the AgentBoat menu.</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="extras-row">
          <div className="extras-text">
            <div className="extras-name">{r.name}</div>
            <div className="extras-desc">{r.desc}</div>
          </div>
          {r.on ? (
            <span className="extras-on">
              <span className="st-dot s-idle" /> On
              <button className="link-btn" disabled={busy !== null} onClick={() => void run(r.key, () => r.set(false))}>
                Turn off
              </button>
            </span>
          ) : (
            <button className="btn primary small-btn" disabled={busy !== null || r.on === undefined} onClick={() => void run(r.key, () => r.set(true))}>
              {busy === r.key ? "Turning on…" : "Turn on"}
            </button>
          )}
        </div>
      ))}
      {err && <div className="ny-callout err">{err}</div>}
    </div>
  );
}

// ---------- the tour ----------

interface Stop {
  /** What to point at; a stop whose target isn't on screen is skipped. */
  target: string;
  title: string;
  body: ReactNode;
  /** Make the target appear first (the timeline is hidden by default). */
  prepare?: () => void;
}

function stops(hookOn: boolean, limitsOn: boolean): Stop[] {
  return [
    {
      target: ".timeline",
      title: "Rewind anything",
      prepare: () => settings.set({ showTimeline: true }),
      body: (
        <>
          Every step of the session is a mark here. Drag to scrub, or use <kbd>←</kbd> <kbd>→</kbd> to step, <kbd>Shift</kbd>+<kbd>←</kbd>{" "}
          <kbd>→</kbd> to jump prompt to prompt, <kbd>Space</kbd> to play and <kbd>End</kbd> to go live. <kbd>Ctrl</kbd>+<kbd>T</kbd> hides it.
        </>
      ),
    },
    {
      target: ".chat",
      title: "What Claude said and did",
      prepare: () => settings.set({ showChat: true }),
      body: "Your prompts, Claude's replies and every tool call, in order. Click any line and the whole IDE jumps to that moment.",
    },
    {
      target: ".ny-bell",
      title: "Needs you",
      body: hookOn
        ? "Every session waiting on you, from all of them at once. Answer permissions, questions and plans right here."
        : "Every session waiting on you, from all of them at once. Turn on Answer prompts in the AgentBoat menu to answer them here too.",
    },
    {
      target: ".team-toggle",
      title: "Team view",
      body: (
        <>
          When Claude runs subagents, see every agent's screen at once (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>).
        </>
      ),
    },
    {
      target: ".statusbar",
      title: "The meters",
      body: limitsOn
        ? "The session's state and branch, how full the context is, and your 5-hour and weekly usage with when each resets."
        : "The session's state and branch, and how full the context is. Turn on Show usage limits in the AgentBoat menu to see your 5-hour and weekly usage here too.",
    },
    {
      target: ".brand",
      title: "That's the tour",
      body: (
        <>
          Take it again from this menu. Press <kbd>?</kbd> any time for every keyboard shortcut.
        </>
      ),
    },
  ];
}

const GAP = 12;
const CARD_W = 320;

/** A few callouts pointing at the real controls. Esc or "Skip tour" ends it at any stop. */
export function Tour({ onEnd }: { onEnd: () => void }) {
  // Two stops are worded by whether the extras are on (checked as the tour starts).
  const [hookOn, setHookOn] = useState(false);
  const [limitsOn, setLimitsOn] = useState(false);
  useEffect(() => {
    if (!IN_TAURI) return;
    void hookStatus().then((h) => setHookOn(h.installed)).catch(() => {});
    void limitsStatus().then((l) => setLimitsOn(l.installed)).catch(() => {});
  }, []);
  const all = useMemo(() => stops(hookOn, limitsOn), [hookOn, limitsOn]);
  const [i, setI] = useState(0);
  const dir = useRef(1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const stop = all[i];

  const go = (to: number) => {
    if (to >= all.length) return onEnd();
    if (to < 0) return;
    dir.current = to >= i ? 1 : -1;
    setPos(null);
    setI(to);
  };

  // Show the target (if it needs showing), then follow it as the layout settles or the window resizes.
  useEffect(() => {
    stop.prepare?.();
    let tries = 0;
    const measure = () => {
      const el = document.querySelector(stop.target);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        setRect((old) => (old && old.x === r.x && old.y === r.y && old.width === r.width && old.height === r.height ? old : r));
      } else if (++tries > 4) {
        // Not on screen (no subagents, for one): skip it in the direction we were going.
        const next = i + dir.current;
        if (next >= 0 && next < all.length) setI(next);
        else onEnd();
      }
    };
    measure();
    const t = window.setInterval(measure, 120);
    return () => window.clearInterval(t);
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Place the card beside the target: below, above, left or right, whichever fits, kept on screen.
  useLayoutEffect(() => {
    if (!rect || !card.current) return;
    const h = card.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampX = (x: number) => Math.max(GAP, Math.min(vw - CARD_W - GAP, x));
    const clampY = (y: number) => Math.max(GAP, Math.min(vh - h - GAP, y));
    const midX = rect.left + rect.width / 2 - CARD_W / 2;
    const midY = rect.top + rect.height / 2 - h / 2;
    let p: { left: number; top: number };
    if (rect.bottom + GAP + h < vh - GAP) p = { left: clampX(midX), top: rect.bottom + GAP };
    else if (rect.top - GAP - h > GAP) p = { left: clampX(midX), top: rect.top - GAP - h };
    else if (rect.left - GAP - CARD_W > GAP) p = { left: rect.left - GAP - CARD_W, top: clampY(midY) };
    else if (rect.right + GAP + CARD_W < vw - GAP) p = { left: rect.right + GAP, top: clampY(midY) };
    else p = { left: clampX(vw / 2 - CARD_W / 2), top: clampY(vh / 2 - h / 2) };
    setPos((old) => (old && old.left === p.left && old.top === p.top ? old : p));
  }, [rect, i]);

  // The keys belong to the tour while it's open: the session doesn't step behind it.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onEnd();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        go(i + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(i - 1);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  const pad = 4;
  const last = i === all.length - 1;
  return (
    <div className="tour" role="dialog" aria-label={`Tour: ${stop.title}`}>
      {/* The dimmed window with a hole over the target (an SVG: huge box-shadows don't paint in WebView2). */}
      <svg className="tour-dim" width="100%" height="100%" aria-hidden>
        <path
          fillRule="evenodd"
          d={
            `M0 0H${window.innerWidth}V${window.innerHeight}H0Z` +
            (rect ? `M${rect.left - pad} ${rect.top - pad}h${rect.width + pad * 2}v${rect.height + pad * 2}h${-(rect.width + pad * 2)}Z` : "")
          }
        />
      </svg>
      {rect && (
        <div
          className="tour-spot"
          style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
        />
      )}
      <div ref={card} className="tour-card" style={{ width: CARD_W, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
        <div className="tour-step dim">
          {i + 1} of {all.length}
        </div>
        <div className="tour-title">{stop.title}</div>
        <div className="tour-body">{stop.body}</div>
        <div className="tour-actions">
          {!last && (
            <button className="link-btn" onClick={onEnd}>
              Skip tour
            </button>
          )}
          <span className="ny-fill" />
          {i > 0 && (
            <button className="btn small-btn" onClick={() => go(i - 1)}>
              Back
            </button>
          )}
          <button className="btn primary small-btn" autoFocus onClick={() => go(i + 1)}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- keyboard shortcuts ----------

const KEYS: [string[][], string][] = [
  [[["←"], ["→"]], "Step back / forward"],
  [[["Shift", "←"], ["Shift", "→"]], "Previous / next prompt"],
  [[["Space"]], "Play / pause the replay"],
  [[["End"]], "Go live: follow Claude"],
  [[["Home"]], "First step"],
  [[["Ctrl", "O"]], "Open another session"],
  [[["Ctrl", "T"]], "Show / hide the timeline"],
  [[["Ctrl", "Shift", "T"]], "Team view: every agent's screen"],
  [[["Esc"]], "Back to Claude's screen, when following an agent"],
  [[["Ctrl", "B"], ["Ctrl", "J"], ["Ctrl", "L"]], "Side bar / terminal / Claude panel"],
  [[["Alt", "Z"]], "Wrap long lines in the editor"],
  [[["?"]], "This list"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={480}>
      <table className="keys">
        <tbody>
          {KEYS.map(([combos, what]) => (
            <tr key={what}>
              <td className="keys-k">
                {combos.map((c, ci) => (
                  <span key={ci}>
                    {ci > 0 && <span className="dim"> / </span>}
                    {c.map((k, ki) => (
                      <span key={ki}>
                        {ki > 0 && "+"}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

// ---------- one note for people coming from Ccboat ----------

/** Shown once to someone whose Ccboat moved in (its data folder is still there). */
export function MovedNotice({ onTour }: { onTour: () => void }) {
  const s = useSettings();
  const [from, setFrom] = useState(false);
  useEffect(() => {
    if (IN_TAURI && !settings.get().ccboatNoticeSeen) void invoke<boolean>("came_from_ccboat").then(setFrom).catch(() => {});
  }, []);
  if (!from || s.ccboatNoticeSeen) return null;
  const seen = () => settings.set({ ccboatNoticeSeen: true });
  return (
    <div className="update-notice moved-notice" role="status">
      <div className="update-title">Ccboat is now AgentBoat</div>
      <div className="update-sub">Same app, new name. Your settings, the prompt hook and the status line came along.</div>
      <div className="update-actions">
        <button
          className="btn primary small-btn"
          onClick={() => {
            seen();
            onTour();
          }}
        >
          Take the tour
        </button>
        <button className="btn small-btn" onClick={seen}>
          OK
        </button>
      </div>
    </div>
  );
}
