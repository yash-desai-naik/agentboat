import { useEffect, useRef, useState } from "react";
import { agentHue, agentKind, agentName, agentProgress } from "../lib/derive";
import { setWatch } from "../lib/store";
import type { Head, Step } from "../lib/types";
import { Chevron, Eye } from "./Icons";

/**
 * Whose screen the IDE shows: Claude (the main session) or one subagent, as "Follow participant"
 * in a shared editor. Lists every agent started by the cursor with its state.
 */
export function WatchMenu({ head, steps, cursor, watch }: { head: Head | null; steps: Step[]; cursor: number; watch: number }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  const agents = (head?.agents ?? [])
    .map((_, k) => ({ n: k + 1, p: agentProgress(steps, cursor, head, k + 1) }))
    .filter((a) => a.p.started);
  if (agents.length === 0 && watch === 0) return null;
  const pick = (n: number) => {
    setOpen(false);
    setWatch(n);
  };
  return (
    <div className="watch-menu" ref={box}>
      <button className={`watch-btn${watch ? " on" : ""}`} style={{ ["--hue" as string]: agentHue(watch) }} onClick={() => setOpen(!open)} title="Whose screen to watch">
        <Eye size={13} />
        <span className="ellipsis">{watch ? agentName(head, watch) : "Claude"}</span>
        <Chevron size={10} open />
      </button>
      {open && (
        <div className="watch-list" role="menu">
          <button role="menuitem" className={watch === 0 ? "current" : ""} onClick={() => pick(0)}>
            <span className="presence-dot small" style={{ ["--hue" as string]: agentHue(0) }}>
              C
            </span>
            <span className="ellipsis">Claude (main session)</span>
          </button>
          {agents.map(({ n, p }) => (
            <button key={n} role="menuitem" className={watch === n ? "current" : ""} onClick={() => pick(n)}>
              <span className="presence-dot small" style={{ ["--hue" as string]: agentHue(n) }}>
                {n}
              </span>
              <span className="ellipsis">{agentName(head, n)}</span>
              <span className="watch-state">{p.state === "running" || p.state === "starting" ? <span className="spinner" /> : p.state}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The bar that says whose screen this is, while following an agent. */
export function WatchBar({ head, steps, cursor, watch }: { head: Head | null; steps: Step[]; cursor: number; watch: number }) {
  if (!watch) return null;
  const p = agentProgress(steps, cursor, head, watch);
  return (
    <div className="watch-bar" style={{ ["--hue" as string]: agentHue(watch) }}>
      <Eye size={13} />
      <span>
        Watching <b>{agentName(head, watch)}</b>'s screen
      </span>
      <span className="dim">
        {agentKind(head, watch)} · {p.count} step{p.count === 1 ? "" : "s"}
        {p.later > 0 ? ` · ${p.later} more later` : ""} · {p.state}
      </span>
      <span className="watch-fill" />
      <button className="watch-back" onClick={() => setWatch(0)} title="Back to the main session (Esc)">
        Back to Claude
      </button>
    </div>
  );
}
