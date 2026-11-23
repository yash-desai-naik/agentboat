import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Ide } from "../lib/derive";
import { duration, modelName, shortTool, tokens } from "../lib/format";
import { setWatch, useSession } from "../lib/store";
import { agentName } from "../lib/derive";
import type { Head, Meta } from "../lib/types";
import { Advisor, Bolt, Branch, Checklist, Pencil, Shield } from "../ui/Icons";
import { useNow } from "../lib/clock";
import { settings, useSettings } from "../lib/settings";
import { contextWindow, resetTime, useLimitsInstalled, useUsage, type Cap, type Usage } from "../lib/usage";

const STATUS_TEXT: Record<string, string> = {
  working: "Working",
  waiting: "Needs you",
  idle: "Idle",
  active: "Active",
  ended: "Ended",
};

/** The items that can be turned off from the bar's right-click menu, in the bar's order. */
const STATUS_ITEMS: [id: string, label: string][] = [
  ["status", "Session state"],
  ["branch", "Branch"],
  ["errors", "Failed tool calls"],
  ["running", "Running tool"],
  ["mode", "Permission mode"],
  ["context", "Context"],
  ["limit5h", "5-hour limit"],
  ["limit7d", "Weekly limit"],
  ["model", "Model"],
  ["effort", "Reasoning effort"],
  ["advisor", "Advisor"],
];

/** The permission mode in words, with its icon; nothing for the default. */
function permissionLabel(m: string | null): { text: string; icon: React.ReactNode } | null {
  switch (m) {
    case null:
    case "default":
      return null;
    case "acceptEdits":
      return { text: "accept edits", icon: <Pencil size={13} /> };
    case "bypassPermissions":
      return { text: "bypass permissions", icon: <Shield size={13} off /> };
    case "plan":
      return { text: "plan mode", icon: <Checklist size={13} /> };
    case "auto":
      return { text: "auto mode", icon: <Bolt size={13} /> };
    default:
      return { text: m, icon: <Shield size={13} /> };
  }
}

export function StatusBar({ ide, head, onLimits }: { ide: Ide; head: Head | null; onLimits: () => void }) {
  const usage = useUsage(head?.id ?? null);
  const limitsOn = useLimitsInstalled();
  const effort = head?.meta.effort ?? usage?.effort ?? null;
  // The bar's own tooltip: the item under the pointer (see StatusTip).
  const [tipEl, setTipEl] = useState<HTMLElement | null>(null);
  const tipTimer = useRef<number | null>(null);
  const onTipOver = (e: React.MouseEvent<HTMLElement>) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    const el = t && e.currentTarget.contains(t) ? t : null;
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    // A short pause before the first tip, as a native one has; moving between items is instant.
    if (el && !tipEl) tipTimer.current = window.setTimeout(() => setTipEl(el), 350);
    else setTipEl(el);
  };
  const onTipLeave = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTipEl(null);
  };
  const { follow, playing, cursor, steps, watch } = useSession();
  const { showTimeline, hiddenStatus } = useSettings();
  const shown = (id: string) => !hiddenStatus.includes(id);
  // The right-click menu: which items show (as VS Code's status bar has).
  const [menu, setMenu] = useState<{ x: number; y: number; item: string | null } | null>(null);
  const onMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    onTipLeave();
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-sb]")?.dataset.sb ?? null;
    setMenu({ x: e.clientX, y: e.clientY, item });
  };
  const now = useNow();
  const status = head?.status ?? "ended";
  const atEnd = cursor >= steps.length - 1;
  const running = ide.running[0];
  const mode = permissionLabel(head?.meta.permissionMode ?? null);
  // When the view isn't showing the present (replaying, or an earlier step) and the timeline that
  // would say so is hidden. Following live is the normal state and needs no label.
  const where = showTimeline || follow ? null : playing ? "replay" : atEnd ? null : "past";
  const turnErrors = (() => {
    let n = 0;
    for (let i = Math.min(cursor, steps.length - 1); i >= 0; i--) {
      const s = steps[i];
      if (s.kind === "prompt" && s.agent === 0) break;
      if (s.state === "err" && s.kind === "tool") n++;
    }
    return n;
  })();
  return (
    <footer className={`statusbar s-${status}`} onMouseOver={onTipOver} onMouseLeave={onTipLeave} onContextMenu={onMenu}>
      {shown("status") && (
        <span className={`sb-item sb-status s-${status}`} data-sb="status" data-tip={head?.waitingFor ? `Waiting for: ${head.waitingFor}` : undefined}>
          <span className="sb-dot" /> {STATUS_TEXT[status] ?? status}
          {status === "waiting" && head?.waitingFor ? `: ${head.waitingFor}` : ""}
        </span>
      )}
      {where && (
        <button className={`sb-where w-${where}`} onClick={() => settings.set({ showTimeline: true })} data-tip="Show the timeline (Ctrl+T)">
          {where === "replay" ? "▶ Replay" : `❚❚ Step ${cursor + 1} of ${steps.length}`}
        </button>
      )}
      {ide.branch && shown("branch") && (
        <span className="sb-item" data-sb="branch" data-tip="Branch">
          <Branch size={13} /> {ide.branch}
          {ide.ahead > 0 && <span data-tip="Commits not pushed"> ↑{ide.ahead}</span>}
        </span>
      )}
      {turnErrors > 0 && shown("errors") && (
        <span className="sb-item sb-err" data-sb="errors" data-tip="Failed tool calls this turn">
          ✕ {turnErrors}
        </span>
      )}
      {running && shown("running") && (
        <span className="sb-item sb-running ellipsis" data-sb="running">
          <span className="spinner" /> {shortTool(running.tool)}
          {running.label && !running.label.startsWith(shortTool(running.tool)) ? `: ${running.label}` : ""}
          {follow && atEnd ? ` · ${duration(now - running.ts)}` : ""}
          {ide.running.length > 1 ? ` (+${ide.running.length - 1})` : ""}
        </span>
      )}
      {watch > 0 && (
        <button className="sb-where" onClick={() => setWatch(0)} data-tip="Back to Claude's screen (Esc)">
          👁 {agentName(head, watch)}
        </button>
      )}
      <span className="sb-fill" />
      {mode && shown("mode") && (
        <span className="sb-item" data-sb="mode" data-tip="Permission mode">
          {mode.icon} {mode.text}
        </span>
      )}
      {head && head.meta.contextTokens > 0 && shown("context") && <ContextMeter used={head.meta.contextTokens} model={head.meta.model} usage={usage} />}
      <Limits usage={usage} on={limitsOn} now={now} onSetup={onLimits} shown={shown} />
      {head?.meta.model && shown("model") && (
        <span className="sb-item sb-model" data-sb="model" data-tip={head.meta.model + (head.meta.version ? ` · Claude Code ${head.meta.version}` : "")}>
          <span className="sb-chip sb-chip-main">
            <ClaudeStar spin={status === "working" || status === "active"} /> {modelName(head.meta.model)}
          </span>
          {effort && shown("effort") && (
            <span className="sb-effort" data-sb="effort" data-tip="Reasoning effort of the last reply">
              {" "}
              · {effort}
            </span>
          )}
        </span>
      )}
      {head?.meta.advisorModel && shown("advisor") && (
        <span className="sb-item sb-advisor" data-sb="advisor" data-tip={advisorTip(head.meta)}>
          <span className="sb-chip sb-chip-advisor">
            <Advisor size={12} /> {modelName(head.meta.advisorModel)}
          </span>
        </span>
      )}
      {tipEl && !menu && <StatusTip el={tipEl} />}
      {menu && <StatusMenu {...menu} hidden={hiddenStatus} onClose={() => setMenu(null)} />}
    </footer>
  );
}

/** Right-click on the bar: hide the item under the pointer, or tick which items show. */
function StatusMenu({ x, y, item, hidden, onClose }: { x: number; y: number; item: string | null; hidden: string[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    b.style.left = `${Math.max(4, Math.min(x, window.innerWidth - b.offsetWidth - 4))}px`;
    b.style.top = `${Math.max(4, Math.min(y, window.innerHeight - b.offsetHeight - 4))}px`;
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  const set = (next: string[]) => {
    settings.set({ hiddenStatus: next });
    onClose();
  };
  const toggle = (id: string) => set(hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);
  const label = item ? STATUS_ITEMS.find(([id]) => id === item)?.[1] : undefined;
  return createPortal(
    <div ref={box} className="ctx-menu sb-menu" role="menu"
      // A portal's events still bubble to the bar: keep them from reopening the menu or showing tips.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseOver={(e) => e.stopPropagation()}
    >
      {item && label && (
        <>
          <button role="menuitem" onClick={() => toggle(item)}>
            Hide {label}
          </button>
          <div className="app-menu-sep" />
        </>
      )}
      {STATUS_ITEMS.map(([id, name]) => (
        <button key={id} role="menuitemcheckbox" aria-checked={!hidden.includes(id)} onClick={() => toggle(id)}>
          <span className="sb-check">{hidden.includes(id) ? "" : "✓"}</span>
          {name}
        </button>
      ))}
      {hidden.length > 0 && (
        <>
          <div className="app-menu-sep" />
          <button role="menuitem" onClick={() => set([])}>
            Show all
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Claude Code's own spinner glyphs, run forward then back. */
const STAR_FRAMES = (() => {
  // U+FE0E keeps ✳ a text glyph: Windows would draw it as a colour emoji.
  const f = ["·", "✢", "✳︎", "✶", "✻", "✽"];
  return [...f, ...[...f].reverse()];
})();

/** The model's star: still while Claude waits, turning as Claude Code's spinner does while it works. */
function ClaudeStar({ spin }: { spin: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!spin || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => setFrame((n) => (n + 1) % STAR_FRAMES.length), 120);
    return () => window.clearInterval(t);
  }, [spin]);
  return (
    <span className={`sb-star${spin ? " spin" : ""}`} aria-hidden="true">
      {spin ? STAR_FRAMES[frame] : "✻"}
    </span>
  );
}

/** The advisor's setup and what it has cost so far. */
function advisorTip(m: Meta): string {
  const name = modelName(m.advisorModel);
  const calls =
    m.advisorCalls === 0
      ? "Not called yet"
      : `${m.advisorCalls} call${m.advisorCalls === 1 ? "" : "s"} (subagents' included): ${tokens(m.advisorInputTokens)} tokens read, ${tokens(m.advisorOutputTokens)} written`;
  return `Advisor: Claude consults ${name} when it decides to (set with /advisor). ${calls}.`;
}

const hot = (pct: number) => (pct >= 80 ? " hot" : "");

function Meter({ pct }: { pct: number }) {
  return (
    <span className={`sb-meter${hot(pct)}`} aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

/** Context in use at the last request, as a share of the window, with a bar. */
function ContextMeter({ used, model, usage }: { used: number; model: string | null; usage: Usage | null }) {
  const { size, exact } = contextWindow(usage, model, used);
  const pct = (100 * used) / size;
  const note = exact ? "" : " (window size estimated: turn on Show usage limits for the exact one)";
  return (
    <span className={`sb-item sb-ctx${hot(pct)}`} data-sb="context" data-tip={`Context in use at the last request: ${tokens(used)} of ${exact ? "" : "about "}${tokens(size)} tokens${note}`}>
      ctx <Meter pct={pct} /> {exact ? "" : "≈"}
      {Math.round(pct)}%
    </span>
  );
}

/** The account's 5-hour and 7-day usage with when each resets; a way to turn them on when off. */
function Limits({ usage, on, now, onSetup, shown }: { usage: Usage | null; on: boolean | null; now: number; onSetup: () => void; shown: (id: string) => boolean }) {
  const caps = ([
    ["5h", "5-hour limit", usage?.fiveHour ?? null],
    ["7d", "Weekly limit", usage?.sevenDay ?? null],
  ] as [string, string, Cap | null][]).filter(([key]) => shown(`limit${key}`));
  if (caps.length === 0) return null;
  if (!caps.some(([, , c]) => c)) {
    if (on)
      return (
        <span className="sb-item dim" data-tip="Usage limits appear after the next reply in any session">
          5h · 7d …
        </span>
      );
    return (
      <button className="sb-where sb-limits-off" onClick={onSetup} data-tip="Show the 5-hour and weekly usage limits">
        5h · 7d
      </button>
    );
  }
  const asOf = usage?.limitsAt ? ` (as of ${resetTime(usage.limitsAt)})` : "";
  return (
    <>
      {caps.map(([key, name, c]) => {
        if (!c) return null;
        const reset = c.resetsAt ?? 0;
        if (reset && reset <= now)
          return (
            <span key={key} className="sb-item dim" data-sb={`limit${key}`} data-tip={`${name}: reset at ${resetTime(reset)}; new figures come with the next reply`}>
              {key} reset
            </span>
          );
        return (
          <span key={key} className={`sb-item sb-cap${hot(c.usedPct)}`} data-sb={`limit${key}`} data-tip={`${name}: ${Math.round(c.usedPct)}% used${reset ? `, resets ${resetTime(reset)}` : ""}${asOf}`}>
            {key} <Meter pct={c.usedPct} /> {Math.round(c.usedPct)}%{reset ? <span className="sb-reset"> {resetTime(reset)}</span> : null}
          </span>
        );
      })}
    </>
  );
}

/**
 * The status bar's tooltip. Native ones (`title`) vanish after a few seconds and whenever the bar
 * redraws (it does every second), so the bar draws its own: above the hovered item, kept inside the
 * window, for as long as the pointer stays, with the item's text as it is now.
 */
function StatusTip({ el }: { el: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null);
  const text = el.isConnected ? el.dataset.tip : undefined;
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !text) return;
    const r = el.getBoundingClientRect();
    const w = b.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    b.style.left = `${left}px`;
    b.style.bottom = `${window.innerHeight - r.top + 6}px`;
  });
  if (!text) return null;
  return (
    <div ref={box} className="sb-tip" role="tooltip">
      {text}
    </div>
  );
}
