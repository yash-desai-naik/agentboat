import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Ide } from "../lib/derive";
import { agentHue, agentName } from "../lib/derive";
import { stripAnsi } from "../lib/format";
import { type Anim, seek, useDetails, useSession } from "../lib/store";
import { useSettings } from "../lib/settings";
import type { Detail, Head, Step } from "../lib/types";
import { Terminal } from "../ui/Icons";
import { frameDue } from "../lib/motion";

/** Commands shown per terminal (older ones scroll away, as in a real terminal). */
const HISTORY = 40;
/** Output lines shown per command. */
const MAX_LINES = 500;

export function TerminalPanel({ ide, head, steps }: { ide: Ide; head: Head | null; steps: Step[] }) {
  const { anim } = useSession();
  // You can look at another terminal; the next command anywhere brings the view back to it.
  const [picked, setPicked] = useState<number | null>(null);
  const lastShell = ide.current && (ide.current.cat === "shell" || ide.current.cat === "git") ? ide.current.i : -1;
  useEffect(() => setPicked(null), [lastShell]);
  const terminals = [...ide.shells.keys()].sort((a, b) => a - b);
  const shown = picked !== null && ide.shells.has(picked) ? picked : ide.activeShell;
  const list = (ide.shells.get(shown) ?? []).slice(-HISTORY).map((i) => steps[i]);

  return (
    <section className="panel">
      <div className="panel-tabs">
        <span className="panel-title">
          <Terminal size={14} /> Terminal
        </span>
        <div className="term-tabs">
          {terminals.length === 0 && <span className="dim">No commands yet</span>}
          {terminals.map((n) => {
            const busy = (ide.shells.get(n) ?? []).some((i) => steps[i].state === "run" && !steps[i].bg && ide.running.includes(steps[i]));
            return (
              <button key={n} className={`term-tab${n === shown ? " active" : ""}`} onClick={() => setPicked(n)} title={agentName(head, n)}>
                {n > 0 && <span className="agent-pip" style={{ ["--hue" as string]: agentHue(n) }} />}
                <span className="term-tab-name">{n === 0 ? (shellName(steps, ide.shells.get(0)) ?? "claude") : agentName(head, n)}</span>
                {busy && <span className="spinner" />}
              </button>
            );
          })}
        </div>
      </div>
      <TerminalBody list={list} anim={anim} branch={ide.branch} current={ide.current?.i ?? -1} />
    </section>
  );
}

function shellName(steps: Step[], ids: number[] | undefined): string | null {
  if (!ids?.length) return null;
  const t = steps[ids[ids.length - 1]].tool;
  return t === "PowerShell" ? "pwsh" : "bash";
}

function TerminalBody({ list, anim, branch, current }: { list: Step[]; anim: Anim | null; branch: string | null; current: number }) {
  const details = useDetails(list);
  const box = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const last = list[list.length - 1];
  // Keep the newest command in view, as a terminal does.
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.i, last?.v, details[details.length - 1], tick]);
  return (
    <div className="terminal" ref={box}>
      {list.map((s, k) => (
        <TermEntry key={s.i} step={s} d={details[k]} anim={anim} branch={branch} current={s.i === current} onGrow={() => setTick((t) => t + 1)} />
      ))}
      {list.length > 0 && last.state !== "run" && <PromptLine d={details[details.length - 1]} step={last} branch={branch} cursor />}
    </div>
  );
}

function promptFor(step: Step, d: Detail | null | undefined, branch: string | null) {
  const cwd = d?.cwd ?? "";
  if (step.tool === "PowerShell") return { ps: true, text: `PS ${cwd.replace(/\//g, "\\")}>` };
  const unix = cwd.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, l: string) => `/${l.toLowerCase()}`);
  return { ps: false, text: unix, branch };
}

function PromptLine({ step, d, branch, cursor, children }: { step: Step; d: Detail | null | undefined; branch: string | null; cursor?: boolean; children?: React.ReactNode }) {
  const p = promptFor(step, d, branch);
  return (
    <div className="term-line prompt">
      {p.ps ? (
        <span className="t-ps">{p.text} </span>
      ) : (
        <>
          <span className="t-cwd">{p.text}</span>
          {p.branch && <span className="t-branch"> ({p.branch})</span>}
          <span className="t-dollar"> $ </span>
        </>
      )}
      {children}
      {cursor && <span className="t-cursor" />}
    </div>
  );
}

function TermEntry({ step, d, anim, branch, current, onGrow }: { step: Step; d: Detail | null | undefined; anim: Anim | null; branch: string | null; current: boolean; onGrow: () => void }) {
  const { typing } = useSettings();
  const command = d?.command ?? step.label;
  const animate = !!anim && anim.i === step.i && typing !== "off" && performance.now() - anim.at < anim.dur;
  const [typed, setTyped] = useState(animate ? 0 : command.length);
  const [showOut, setShowOut] = useState(!animate);

  useEffect(() => {
    if (!animate) {
      setTyped(command.length);
      setShowOut(true);
      return;
    }
    // Type the command (long ones faster), then show what it printed.
    const typeMs = Math.min(anim!.dur * 0.55, Math.max(150, command.length * (typing === "fast" ? 6 : 14)));
    const t0 = anim!.at;
    let raf = 0;
    const last = { t: 0 };
    setShowOut(false);
    const frame = () => {
      const now = performance.now();
      const p = Math.min(1, (now - t0) / typeMs);
      if (p < 1 && !frameDue(last, now)) {
        raf = requestAnimationFrame(frame);
        return;
      }
      setTyped(Math.round(command.length * p));
      onGrow();
      if (p < 1) raf = requestAnimationFrame(frame);
      else setShowOut(true);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      setTyped(command.length);
      setShowOut(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, command]);

  const out = d ? outputOf(d) : null;
  return (
    <div className={`term-entry${current ? " current" : ""}${step.state === "err" ? " failed" : ""}`} onClick={() => seek(step.i)}>
      {d?.description && <div className="term-line t-comment"># {d.description}</div>}
      <PromptLine step={step} d={d} branch={branch}>
        <span className="t-cmd">{command.slice(0, typed)}</span>
        {typed < command.length && <span className="t-cursor" />}
      </PromptLine>
      {showOut && (
        <>
          {step.state === "run" && !step.bg && (
            <div className="term-line t-running">
              <span className="spinner" /> running…
            </div>
          )}
          {step.bg && <div className="term-line t-dim">[running in the background{d?.taskId ? `: ${d.taskId}` : ""}]</div>}
          {out?.stdout && <pre className="term-out">{out.stdout}</pre>}
          {out?.stderr && <pre className={`term-out ${step.state === "err" ? "t-err" : "t-warn"}`}>{out.stderr}</pre>}
          {d?.interrupted && <div className="term-line t-err">^C (interrupted)</div>}
          {step.state === "err" && !out?.stderr && !out?.stdout && d?.error && <pre className="term-out t-err">{trimOut(d.error)}</pre>}
        </>
      )}
    </div>
  );
}

function trimOut(s: string): string {
  const clean = stripAnsi(s).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = clean.split("\n");
  if (lines.length <= MAX_LINES) return clean;
  const head = lines.slice(0, 60);
  const tail = lines.slice(-(MAX_LINES - 60));
  return [...head, `… ${lines.length - MAX_LINES} lines not shown …`, ...tail].join("\n");
}

function outputOf(d: Detail): { stdout: string; stderr: string } {
  if (d.stdout != null || d.stderr != null) {
    return { stdout: trimOut(d.stdout ?? ""), stderr: trimOut(d.stderr ?? "") };
  }
  const o = d.output ?? "";
  return { stdout: d.isError ? "" : trimOut(o), stderr: d.isError ? trimOut(o) : "" };
}
