import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentHue, agentName, agentProgress, type AgentProgress } from "../lib/derive";
import { clock, duration, shortTool } from "../lib/format";
import { type Anim, seek, setWatch, useSession } from "../lib/store";
import { settings, useSettings } from "../lib/settings";
import type { Head, Step } from "../lib/types";
import { Chat, StepIcon } from "../ui/Icons";
import { Markdown } from "./Markdown";
import { frameDue } from "../lib/motion";

/** The conversation as it stood at the cursor: your prompts, Claude's replies, and each tool call. */
export function ChatPanel({ head, steps, cursor }: { head: Head | null; steps: Step[]; cursor: number }) {
  const { anim, watch } = useSession();
  const { chatScope } = useSettings();
  const [limit, setLimit] = useState(250);
  const box = useRef<HTMLDivElement>(null);

  const shown: Step[] = [];
  for (let i = Math.min(cursor, steps.length - 1); i >= 0 && shown.length < limit; i--) {
    const s = steps[i];
    if (watch > 0 ? s.agent !== watch : chatScope === "main" && s.agent !== 0) continue;
    shown.push(s);
  }
  shown.reverse();
  const more = shown.length >= limit && shown[0]?.i > 0;

  // Agents started from each Agent step, to show their progress on its row.
  const agentOf = new Map<number, number>();
  head?.agents.forEach((a, k) => {
    if (a.step !== null) agentOf.set(a.step, k + 1);
  });

  // How many steps each subagent had taken by the cursor, for its Agent row.
  const agentRun = (n: number | undefined): AgentProgress | null => (n ? agentProgress(steps, cursor, head, n) : null);
  const agentSteps = (n: number | undefined): number | null => {
    if (!n) return null;
    let c = 0;
    for (let i = 0; i <= cursor && i < steps.length; i++) if (steps[i].agent === n) c++;
    return c;
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cursor, steps.length, chatScope]);

  const atEnd = cursor >= steps.length - 1;
  const live = head && head.status !== "ended" && atEnd;
  const thinking = live && (head.status === "working" || head.status === "active") && head.meta.lastBlock === "thinking";

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="panel-title">
          <Chat size={14} /> {watch > 0 ? agentName(head, watch) : "Claude"}
        </span>
        <span className="chat-fill" />
        {watch > 0 ? (
          <button className="seg-solo" onClick={() => setWatch(0)} title="Back to the main session (Esc)">
            ← Claude
          </button>
        ) : (
        <div className="seg" role="group" aria-label="Show">
          <button aria-pressed={chatScope === "main"} onClick={() => settings.set({ chatScope: "main" })} title="The main session only">
            Session
          </button>
          <button aria-pressed={chatScope === "all"} onClick={() => settings.set({ chatScope: "all" })} title="Subagents' steps too">
            + Agents
          </button>
        </div>
        )}
      </div>
      <div className="chat-list" ref={box}>
        {more && (
          <button className="chat-more" onClick={() => setLimit((l) => l + 250)}>
            Show earlier
          </button>
        )}
        {shown.map((s) => (
          <ChatItem key={s.i} step={s} head={head} current={s.i === cursor} anim={anim?.i === s.i ? anim : null} agentSteps={agentSteps(agentOf.get(s.i))} agentRun={agentRun(agentOf.get(s.i))} />
        ))}
        {live && head.status === "waiting" && (
          <div className="chat-state waiting">
            <span className="pulse" /> Waiting for you{head.waitingFor ? `: ${head.waitingFor}` : ""}
          </div>
        )}
        {thinking && (
          <div className="chat-state thinking">
            <span className="shimmer">Thinking…</span>
          </div>
        )}
      </div>
    </aside>
  );
}

const ChatItem = memo(function ChatItem({
  step,
  head,
  current,
  anim,
  agentSteps,
  agentRun,
}: {
  step: Step;
  head: Head | null;
  current: boolean;
  anim: Anim | null;
  agentSteps: number | null;
  agentRun: AgentProgress | null;
}) {
  const cls = `chat-item ${step.kind}${current ? " current" : ""}`;
  const chip =
    step.agent > 0 ? (
      <span className="agent-chip" style={{ ["--hue" as string]: agentHue(step.agent) }}>
        {agentName(head, step.agent)}
      </span>
    ) : null;
  switch (step.kind) {
    case "prompt":
      return (
        <div className={cls} onClick={() => seek(step.i)}>
          <div className="who">
            {chip ?? "You"} <span className="when">{clock(step.ts)}</span>
          </div>
          <div className="bubble">{step.text ?? step.label}</div>
        </div>
      );
    case "say":
      return (
        <div className={cls} onClick={() => seek(step.i)}>
          {chip && <div className="who">{chip}</div>}
          <SayText step={step} anim={anim} />
        </div>
      );
    case "interrupt":
      return (
        <div className={cls} onClick={() => seek(step.i)}>
          {step.label}
        </div>
      );
    case "compact":
      return (
        <div className={cls} onClick={() => seek(step.i)}>
          <span>{step.label}</span>
        </div>
      );
    default: {
      const took = step.end && step.end > step.ts ? duration(step.end - step.ts) : null;
      const agentInfo = agentSteps !== null ? `${agentSteps} step${agentSteps === 1 ? "" : "s"}` : null;
      return (
        <div
          className={`${cls} tool cat-${step.cat}${step.agent > 0 ? " sub" : ""}`}
          onClick={() => seek(step.i)}
          title={step.label}
          data-path={step.path ?? undefined}
        >
          <span className={`state ${step.state}`}>
            <StepIcon cat={step.cat} kind={step.kind} size={13} />
          </span>
          <span className="tool-name">{toolName(step)}</span>
          {chip}
          <span className="tool-label">{step.label}</span>
          {step.delta && (step.cat === "edit" || step.cat === "write") && (
            <span className="delta">
              <span className="plus">+{step.delta[0]}</span> <span className="minus">−{step.delta[1]}</span>
            </span>
          )}
          {agentInfo && <span className="tool-meta">{agentInfo}</span>}
          {agentRun ? (
            // The agent's own progress, not its Agent call's (a background agent's call returns at once).
            agentRun.state === "running" || agentRun.state === "starting" ? (
              <span className="spinner" title={agentRun.state === "starting" ? "Starting" : "Working"} />
            ) : (
              <span className="tool-meta">{agentRun.state}</span>
            )
          ) : step.state === "run" ? (
            <span className="spinner" />
          ) : (
            took && <span className="tool-meta">{took}</span>
          )}
        </div>
      );
    }
  }
});

function toolName(s: Step): string {
  if (s.cat === "git" && s.git) return `git ${s.git.primary}`;
  if (s.cat === "mcp") return shortTool(s.tool).split(":")[0];
  return s.tool ?? s.cat;
}

/** A reply, typed out while it's the step that just arrived. */
function SayText({ step, anim }: { step: Step; anim: Anim | null }) {
  const text = step.text ?? step.label;
  const { typing } = useSettings();
  const animate = !!anim && anim.i === step.i && typing !== "off" && performance.now() - anim.at < anim.dur;
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) {
      setN(text.length);
      return;
    }
    const total = Math.max(120, anim!.dur * 0.8);
    let raf = 0;
    const last = { t: 0 };
    const frame = () => {
      const now = performance.now();
      const p = Math.min(1, (now - anim!.at) / total);
      if (p < 1 && !frameDue(last, now)) {
        raf = requestAnimationFrame(frame);
        return;
      }
      setN(Math.round(text.length * p));
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, text]);
  if (n < text.length) return <div className="md typing">{text.slice(0, n)}</div>;
  return <Markdown text={text} />;
}
