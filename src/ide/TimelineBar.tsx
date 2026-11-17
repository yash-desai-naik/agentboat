import { useEffect, useRef, useState } from "react";
import { agentHue } from "../lib/derive";
import { clock, duration } from "../lib/format";
import { goLive, isLive, seek, setPlaying, stepBy, turnBy, useSession } from "../lib/store";
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
    default:
      return "--tl-other";
  }
}

/** Which mark wins when many steps share a pixel column. */
function weight(s: Step): number {
  if (s.kind === "prompt") return 9;
  if (s.state === "err" || s.kind === "interrupt") return 8;
  if (s.cat === "git") return 7;
  if (s.cat === "edit" || s.cat === "write") return 6;
  if (s.cat === "shell") return 5;
  if (s.cat === "read") return 4;
  if (s.cat === "search") return 3;
  if (s.kind === "say") return 1;
  return 2;
}

const PAD = 8;

export function TimelineBar() {
  const { steps, cursor, follow, playing, head } = useSession();
  const set = useSettings();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const n = steps.length;
  const live = isLive(head);

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

  // Draw the marks: main session on top, subagents below; the future dimmed.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 30;
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
    const agentCols = new Map<number, Step>();
    for (const s of steps) {
      const x = Math.round(xOf(s.i));
      const m = s.agent === 0 ? cols : agentCols;
      const prev = m.get(x);
      if (!prev || weight(s) > weight(prev)) m.set(x, s);
    }
    const cx = xOf(cursor);
    const draw = (m: Map<number, Step>, top: boolean) => {
      for (const [x, s] of m) {
        const past = s.i <= cursor;
        ctx.globalAlpha = past ? 1 : 0.35;
        if (top) {
          ctx.fillStyle = color(markVar(s));
          if (s.kind === "prompt") ctx.fillRect(x - 1, 2, 2, 26);
          else ctx.fillRect(x, s.kind === "say" ? 11 : 7, 1.5, s.kind === "say" ? 8 : 16);
        } else {
          ctx.fillStyle = `hsl(${agentHue(s.agent)} 55% 55%)`;
          ctx.fillRect(x, 24, 1.5, 5);
        }
      }
    };
    draw(cols, true);
    draw(agentCols, false);
    ctx.globalAlpha = 1;
    // Played part of the track.
    ctx.fillStyle = color("--tl-played");
    ctx.fillRect(PAD, 13, Math.max(0, cx - PAD), 4);
  }, [steps, cursor, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromEvent = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, iOf(e.clientX - r.left)));
  };

  const cur = steps[cursor];
  const hs = hover ? steps[hover.i] : null;
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
          style={{ width: "100%", height: 30 }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            seek(fromEvent(e));
          }}
          onPointerMove={(e) => {
            const i = fromEvent(e);
            const r = canvas.current!.getBoundingClientRect();
            setHover({ x: e.clientX - r.left, i });
            if (e.buttons & 1) seek(i);
          }}
          onPointerLeave={() => setHover(null)}
        />
        {n > 0 && <div className="tl-cursor" style={{ left: xOf(cursor) }} />}
        {hs && hover && (
          <div className="tl-tip" style={{ left: Math.min(Math.max(hover.x, 120), width - 120) }}>
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
          {[0.5, 1, 2, 4, 8, 16].map((s) => (
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
