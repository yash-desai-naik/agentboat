import { useEffect, useRef, useState } from "react";
import { agentHue, agentName } from "../lib/derive";
import { clock, duration } from "../lib/format";
import { goLive, isLive, seek, setPlaying, setWatch, stepBy, turnBy, useSession } from "../lib/store";
import { settings, useSettings } from "../lib/settings";
import type { Step } from "../lib/types";
import { Live, Pause, Play, StepBack, StepFwd, TurnBack, TurnFwd } from "../ui/Icons";

/** Colour of a step's mark, from the theme. */
function markVar(s: Step): string {
  if (s.kind === "prompt") return "--tl-prompt";
  if (s.kind === "say") return "--tl-say";
  if (s.kind === "interrupt") return "--tl-err";
  if (s.kind === "compact") return "--tl-say";
  if (s.state === "err") return "--tl-err";
  switch (s.cat) {
    case "read":
      return "--tl-read";
    case "edit":
    case "write":
      return "--tl-edit";
    case "shell":
      return "--tl-shell";
    case "git":
      return "--tl-git";
    case "search":
      return "--tl-search";
    case "advisor":
      return "--tl-advisor";
    default:
      return "--tl-other";
  }
}

/** Which mark wins when many steps share a pixel column. */
function weight(s: Step): number {
  if (s.kind === "prompt") return 9;
  if (s.state === "err" || s.kind === "interrupt") return 8;
  if (s.cat === "git" || s.cat === "advisor" || s.cat === "workflow") return 7;
  if (s.cat === "edit" || s.cat === "write") return 6;
  if (s.cat === "shell") return 5;
  if (s.cat === "read") return 4;
  if (s.cat === "search") return 3;
  if (s.kind === "say") return 1;
  return 2;
}

const PAD = 8;
/** The main track's height; lanes for subagents go below it. */
const MAIN_H = 30;

export function TimelineBar() {
  const { steps, cursor, follow, playing, head, watch } = useSession();
  const set = useSettings();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ x: number; i: number; lane: number } | null>(null);
  const n = steps.length;
  const live = isLive(head);
  // One lane per subagent under the main track: thinner when there are many.
  const lanes = head?.agents.length ?? 0;
  const laneH = lanes <= 8 ? 6 : lanes <= 16 ? 4 : 3;
  const laneGap = lanes <= 16 ? 2 : 1;
  const laneTop = MAIN_H + 4;
  const canvasH = MAIN_H + (lanes ? 4 + lanes * (laneH + laneGap) : 0);
  const laneY = (k: number) => laneTop + k * (laneH + laneGap);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const xOf = (i: number) => (n <= 1 ? PAD : PAD + (i / (n - 1)) * (width - 2 * PAD));
  const iOf = (x: number) => (n <= 1 ? 0 : Math.round(((x - PAD) / (width - 2 * PAD)) * (n - 1)));

  // Draw the marks: the main session on top, a lane per subagent below; the future dimmed.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = canvasH;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const css = getComputedStyle(c);
    const color = (v: string) => css.getPropertyValue(v).trim() || "#888";
    // Track.
    ctx.fillStyle = color("--tl-track");
    ctx.fillRect(PAD, 13, width - 2 * PAD, 4);
    const cols = new Map<number, Step>();
    // Per lane: its ticks (one per pixel column) and the span from its first to its last step.
    const laneCols: Map<number, Step>[] = Array.from({ length: lanes }, () => new Map());
    const span: [number, number][] = Array.from({ length: lanes }, () => [Infinity, -Infinity]);
    for (const s of steps) {
      const x = Math.round(xOf(s.i));
      if (s.agent === 0) {
        const prev = cols.get(x);
        if (!prev || weight(s) > weight(prev)) cols.set(x, s);
      } else if (s.agent <= lanes) {
        laneCols[s.agent - 1].set(x, s);
        const sp = span[s.agent - 1];
        sp[0] = Math.min(sp[0], x);
        sp[1] = Math.max(sp[1], x);
      }
    }
    const cx = xOf(cursor);
    for (const [x, s] of cols) {
      ctx.globalAlpha = s.i <= cursor ? 1 : 0.35;
      ctx.fillStyle = color(markVar(s));
      if (s.kind === "prompt") ctx.fillRect(x - 1, 2, 2, 26);
      else ctx.fillRect(x, s.kind === "say" ? 11 : 7, 1.5, s.kind === "say" ? 8 : 16);
    }
    for (let k = 0; k < lanes; k++) {
      const hue = agentHue(k + 1);
      const y = laneY(k);
      const [a, b] = span[k];
      if (a === Infinity) continue;
      const mine = watch === k + 1;
      // The span it was at work, then a tick per step.
      ctx.globalAlpha = 1;
      ctx.fillStyle = `hsl(${hue} 50% 50% / ${mine ? 0.42 : 0.16})`;
      ctx.fillRect(a, y, Math.max(2, b - a + 1.5), laneH);
      ctx.fillStyle = `hsl(${hue} 60% ${mine ? 66 : 58}%)`;
      for (const [x, s] of laneCols[k]) {
        ctx.globalAlpha = s.i <= cursor ? 1 : 0.35;
        ctx.fillRect(x, y, 1.5, laneH);
      }
      if (mine) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = `hsl(${hue} 60% 66%)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(a - 0.5, y - 0.5, Math.max(2, b - a + 2.5), laneH + 1);
      }
    }
    ctx.globalAlpha = 1;
    // Played part of the track.
    ctx.fillStyle = color("--tl-played");
    ctx.fillRect(PAD, 13, Math.max(0, cx - PAD), 4);
  }, [steps, cursor, width, lanes, watch]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The lane under a point (0-based agent lane), or -1 for the main track. */
  const laneAt = (y: number) => {
    if (y < laneTop - 2 || !lanes) return -1;
    return Math.max(0, Math.min(lanes - 1, Math.floor((y - laneTop + laneGap / 2) / (laneH + laneGap))));
  };
  /** The step of agent `a` nearest to index `i`. */
  const nearestOf = (a: number, i: number): number | null => {
    let best: number | null = null;
    for (const s of steps) if (s.agent === a && (best === null || Math.abs(s.i - i) < Math.abs(best - i))) best = s.i;
    return best;
  };

  const fromEvent = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, iOf(e.clientX - r.left)));
  };
  const laneOf = (e: React.PointerEvent) => laneAt(e.clientY - canvas.current!.getBoundingClientRect().top);

  const cur = steps[cursor];
  // On a lane, the hover names that agent's step nearest the pointer.
  const hoverStep = hover ? (hover.lane >= 0 ? nearestOf(hover.lane + 1, hover.i) : hover.i) : null;
  const hs = hoverStep !== null ? steps[hoverStep] : null;
  const first = steps[0]?.ts ?? 0;

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="tl-btn" title="Previous prompt (Shift+←)" onClick={() => turnBy(-1)} disabled={!n}>
          <TurnBack size={13} />
        </button>
        <button className="tl-btn" title="Step back (←)" onClick={() => stepBy(-1)} disabled={!n}>
          <StepBack size={13} />
        </button>
        <button className="tl-btn play" title={playing ? "Pause (Space)" : "Play from here (Space)"} onClick={() => setPlaying(!playing)} disabled={!n}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="tl-btn" title="Step forward (→)" onClick={() => stepBy(1)} disabled={!n}>
          <StepFwd size={13} />
        </button>
        <button className="tl-btn" title="Next prompt (Shift+→)" onClick={() => turnBy(1)} disabled={!n}>
          <TurnFwd size={13} />
        </button>
      </div>
      <div className="tl-pos mono" title={cur ? new Date(cur.ts).toLocaleString() : ""}>
        <span className="tl-step">
          {n ? cursor + 1 : 0}
          <span className="dim"> / {n}</span>
        </span>
        <span className="tl-time dim">{cur ? `${clock(cur.ts)} · +${duration(cur.ts - first)}` : ""}</span>
      </div>
      <div className="tl-track" ref={wrap}>
        <canvas
          ref={canvas}
          style={{ width: "100%", height: canvasH }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            const lane = laneOf(e);
            if (lane >= 0) {
              // A lane: that agent's step there, on its screen.
              const at = nearestOf(lane + 1, fromEvent(e));
              if (at !== null) {
                seek(at);
                setWatch(lane + 1);
              }
            } else seek(fromEvent(e));
          }}
          onPointerMove={(e) => {
            const i = fromEvent(e);
            const r = canvas.current!.getBoundingClientRect();
            setHover({ x: e.clientX - r.left, i, lane: laneOf(e) });
            if (e.buttons & 1 && laneOf(e) < 0) seek(i);
          }}
          onPointerLeave={() => setHover(null)}
        />
        {n > 0 && <div className="tl-cursor" style={{ left: xOf(cursor) }} />}
        {hs && hover && (
          <div className="tl-tip" style={{ left: Math.min(Math.max(hover.x, 120), width - 120) }}>
            {hs.agent > 0 && (
              <span className="agent-chip" style={{ ["--hue" as string]: agentHue(hs.agent) }}>
                {agentName(head, hs.agent)}
              </span>
            )}
            <span className="mono dim">#{hs.i + 1} · {clock(hs.ts)}</span>
            <span className="tl-tip-label">
              {hs.kind === "tool" ? <b>{hs.cat === "git" && hs.git ? `git ${hs.git.primary}` : hs.tool} </b> : hs.kind === "prompt" ? <b>You: </b> : null}
              {hs.label}
            </span>
          </div>
        )}
      </div>
      <div className="tl-right">
        <select className="tl-select" value={set.speed} title="Replay speed" onChange={(e) => settings.set({ speed: Number(e.target.value) })}>
          {[0.1, 0.25, 0.5, 1, 2, 4, 8, 16].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <select className="tl-select" value={set.pacing} title="Replay pacing" onChange={(e) => settings.set({ pacing: e.target.value as "real" | "even" })}>
          <option value="real">Real pauses</option>
          <option value="even">Even steps</option>
        </select>
        <select className="tl-select" value={set.typing} title="Typing animation for edits, commands and replies" onChange={(e) => settings.set({ typing: e.target.value as "normal" | "fast" | "off" })}>
          <option value="normal">Typing: normal</option>
          <option value="fast">Typing: fast</option>
          <option value="off">Typing: off</option>
        </select>
        {live ? (
          <button className={`tl-live${follow ? " on" : ""}`} onClick={goLive} title={follow ? "Following Claude live" : "Jump to now and follow Claude (End)"}>
            <Live size={13} /> {follow ? "LIVE" : "Go live"}
          </button>
        ) : (
          <button className="tl-live ended" onClick={() => seek(n - 1)} title="The session has ended. Jump to its last step (End)">
            Ended
          </button>
        )}
      </div>
    </div>
  );
}
