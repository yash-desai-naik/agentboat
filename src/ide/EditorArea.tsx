import { useEffect, useMemo, useRef } from "react";
import type { Ide, Tab } from "../lib/derive";
import { agentHue, agentName } from "../lib/derive";
import { baseName, pathKey, relativeTo, shortTool } from "../lib/format";
import { type Anim, useDetail, seek, useSession } from "../lib/store";
import type { Detail, Head, Hunk, Step } from "../lib/types";
import { CodeEditor, type Typing } from "./CodeEditor";
import { Markdown } from "./Markdown";
import { FileIcon } from "./FileIcon";
import { Close } from "../ui/Icons";

/** The typing animation for a step, while it's the one that just became current. */
export function typingFor(anim: Anim | null, i: number): Typing | null {
  if (!anim || anim.i !== i) return null;
  return { at: anim.at, dur: anim.dur };
}

export function EditorArea({ ide, head, steps }: { ide: Ide; head: Head | null; steps: Step[] }) {
  const { anim } = useSession();
  const active = ide.tabs.find((t) => t.id === ide.activeTab) ?? null;
  return (
    <section className="editor-area">
      <div className="tabstrip" role="tablist">
        {ide.tabs.map((t) => (
          <TabButton key={t.id} tab={t} active={t.id === ide.activeTab} step={steps[t.step]} />
        ))}
        <div className="tabstrip-fill" />
      </div>
      {active ? (
        <TabBody key={active.id} tab={active} step={steps[active.step]} head={head} anim={anim} />
      ) : (
        <EmptyEditor head={head} />
      )}
    </section>
  );
}

function TabButton({ tab, active, step }: { tab: Tab; active: boolean; step: Step | undefined }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tab.step]);
  const dirty = step && (step.cat === "edit" || step.cat === "write") && step.state !== "err";
  return (
    <button
      ref={ref}
      className={`tab${active ? " active" : ""}${step?.state === "run" ? " running" : ""}`}
      role="tab"
      aria-selected={active}
      title={tab.path ?? tab.title}
      onClick={() => seek(tab.step)}
    >
      {tab.kind === "file" ? <FileIcon name={tab.title} /> : <span className="tab-out">⟩</span>}
      <span className={`tab-title${dirty ? " modified" : ""}`}>{tab.title}</span>
      {tab.agent > 0 && <span className="agent-pip" style={{ ["--hue" as string]: agentHue(tab.agent) }} />}
      <span className="tab-close" aria-hidden="true">
        <Close size={10} />
      </span>
    </button>
  );
}

function EmptyEditor({ head }: { head: Head | null }) {
  return (
    <div className="editor-empty">
      <div className="editor-empty-mark">ccboat</div>
      <p>Files open here as Claude reads and changes them.</p>
      {head?.meta.cwd && <p className="dim mono">{head.meta.cwd}</p>}
    </div>
  );
}

function Breadcrumb({ path, cwd, extra }: { path: string; cwd: string | null; extra?: React.ReactNode }) {
  const rel = relativeTo(path, cwd);
  const parts = (rel ?? path.replace(/\\/g, "/")).split("/").filter(Boolean);
  return (
    <div className="breadcrumb">
      {rel !== null && cwd && (
        <>
          <span className="crumb root">{baseName(cwd)}</span>
          <span className="crumb-sep">›</span>
        </>
      )}
      {parts.map((p, k) => (
        <span key={k} className="crumb-wrap">
          <span className={k === parts.length - 1 ? "crumb last" : "crumb"}>{p}</span>
          {k < parts.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
      <span className="breadcrumb-fill" />
      {extra}
    </div>
  );
}

function TabBody({ tab, step, head, anim }: { tab: Tab; step: Step | undefined; head: Head | null; anim: Anim | null }) {
  const detail = useDetail(step);
  if (!step) return null;
  if (tab.kind === "output") return <OutputView step={step} detail={detail} head={head} />;
  const cwd = head?.meta.cwd ?? null;
  const fromShell = step.cat === "shell" || step.cat === "git";
  const verb = fromShell ? "Written from the terminal" : step.cat === "read" ? "Read" : step.cat === "write" ? (step.created ? "Created" : "Wrote") : "Edited";
  const extra = (
    <span className={`crumb-step ${step.state}`}>
      {step.agent > 0 && (
        <span className="agent-chip" style={{ ["--hue" as string]: agentHue(step.agent) }}>
          {agentName(head, step.agent)}
        </span>
      )}
      {step.state === "run" ? (step.cat === "read" ? "Reading…" : "Writing…") : step.state === "err" ? (fromShell ? "Command failed" : `${verb === "Read" ? "Read" : "Edit"} failed`) : verb}
      {step.delta && step.cat !== "read" && (
        <>
          <span className="plus">+{step.delta[0]}</span>
          <span className="minus">−{step.delta[1]}</span>
        </>
      )}
    </span>
  );
  return (
    <div className="tab-body">
      <Breadcrumb path={tab.path ?? step.path ?? tab.title} cwd={cwd} extra={extra} />
      {detail?.error && <div className="editor-banner err">{firstLines(detail.error, 4)}</div>}
      <FileContent step={step} path={tab.path ?? step.path ?? ""} detail={detail} typing={typingFor(anim, step.i)} />
    </div>
  );
}

function firstLines(s: string, n: number) {
  return s.split("\n").slice(0, n).join("\n");
}

function FileContent({ step, path, detail, typing }: { step: Step; path: string; detail: Detail | null | undefined; typing: Typing | null }) {
  const name = baseName(path);
  const view = useMemo(() => fileView(step, detail, path), [step, detail, path]);
  if (detail === undefined) return <div className="editor-loading" />;
  if (detail?.image) {
    return (
      <div className="image-view">
        <img src={`data:${detail.image.mediaType};base64,${detail.image.data}`} alt={name} />
      </div>
    );
  }
  if (!view) {
    if (detail?.kind === "shell")
      return (
        <div className="editor-loading dim">
          Written by the command in the terminal; its content isn't part of the command (a copy, a move or a program's output), so it can't be shown.
        </div>
      );
    return <div className="editor-loading dim">{step.state === "run" ? "Waiting for the result…" : "Nothing to show for this step."}</div>;
  }
  // Reads don't animate: the file just opens.
  return <CodeEditor doc={view.doc} original={view.original} name={name} startLine={view.start} typing={step.cat === "read" ? null : typing} />;
}

/** What the editor shows for a file step: the file, or a change to it. */
function fileView(step: Step, d: Detail | null | undefined, path: string): { doc: string; original: string | null; start: number } | null {
  if (!d) return null;
  if (d.kind === "shell") {
    // A file written from the terminal: the heredoc's (or echo's) text, typed in like a new file.
    const key = pathKey(path);
    const f = d.files?.find((x) => pathKey(x.path) === key);
    if (f?.content == null) return null;
    return { doc: f.content, original: "", start: 1 };
  }
  if (d.kind === "read") {
    if (d.content == null) return null;
    return { doc: d.content, original: null, start: d.startLine ?? 1 };
  }
  if (d.kind !== "edit") return null;
  const start = d.startLine ?? 1;
  if (d.after != null) {
    const original = d.before != null ? d.before : d.write || step.created ? "" : null;
    // A new file: shown as it's typed, then plain (an all-green diff says nothing more).
    if (original === "") return { doc: d.after, original: "", start };
    return { doc: d.after, original, start };
  }
  // The file around the edit isn't known: show the edit itself.
  if (d.patch?.length) return patchView(d.patch);
  if (d.edits?.length) {
    return {
      original: d.edits.map((e) => e.old).join("\n\n⋯\n\n"),
      doc: d.edits.map((e) => e.new).join("\n\n⋯\n\n"),
      start: 1,
    };
  }
  return null;
}

/** Diff hunks (as Claude Code logs them) to a before/after pair of the changed regions. */
function patchView(hunks: Hunk[]) {
  const a: string[] = [];
  const b: string[] = [];
  hunks.forEach((h, k) => {
    if (k > 0) {
      a.push("⋯");
      b.push("⋯");
    }
    for (const l of h.lines) {
      const c = l[0];
      const text = l.slice(1);
      if (c !== "+") a.push(text);
      if (c !== "-") b.push(text);
    }
  });
  return { original: a.join("\n"), doc: b.join("\n"), start: hunks[0]?.newStart ?? 1 };
}

// ---------- tool output tabs (web, MCP, skills, questions) ----------

function OutputView({ step, detail, head }: { step: Step; detail: Detail | null | undefined; head: Head | null }) {
  const title = step.cat === "web" ? step.tool : shortTool(step.tool);
  return (
    <div className="tab-body">
      <div className="breadcrumb">
        <span className="crumb root">{step.cat === "mcp" ? "MCP" : step.cat === "web" ? "Web" : "Tool"}</span>
        <span className="crumb-sep">›</span>
        <span className="crumb last">{title}</span>
        <span className="breadcrumb-fill" />
        <span className={`crumb-step ${step.state}`}>
          {step.agent > 0 && (
            <span className="agent-chip" style={{ ["--hue" as string]: agentHue(step.agent) }}>
              {agentName(head, step.agent)}
            </span>
          )}
          {step.state === "run" ? "Running…" : step.state === "err" ? "Failed" : "Done"}
        </span>
      </div>
      <div className="output-view">
        {detail === undefined ? null : !detail ? (
          <p className="dim">No detail.</p>
        ) : (
          <OutputBody step={step} d={detail} />
        )}
      </div>
    </div>
  );
}

function OutputBody({ step, d }: { step: Step; d: Detail }) {
  if (d.kind === "ask") {
    return (
      <div className="ask">
        {(d.questions ?? []).map((q, k) => (
          <div key={k} className="ask-q">
            {q.header && <div className="ask-h">{q.header}</div>}
            <div className="ask-text">{q.question}</div>
            <div className="ask-opts">
              {(q.options ?? []).map((o, j) => {
                const chosen = d.answers && Object.values(d.answers).some((a) => a.includes(o.label));
                return (
                  <div key={j} className={`ask-opt${chosen ? " chosen" : ""}`}>
                    <b>{o.label}</b>
                    {o.description && <span> {o.description}</span>}
                  </div>
                );
              })}
            </div>
            {d.answers?.[q.question] && <div className="ask-a">Answer: {d.answers[q.question]}</div>}
          </div>
        ))}
      </div>
    );
  }
  const input =
    d.kind === "web"
      ? [d.url ?? d.query, d.prompt].filter(Boolean).join("\n\n")
      : typeof d.input === "string"
        ? d.input
        : d.input != null
          ? JSON.stringify(d.input, null, 2)
          : "";
  const out = d.output ?? "";
  const looksMarkdown = /^#{1,3} |\n#{1,3} |\n- |\*\*/.test(out) && !out.trimStart().startsWith("{");
  return (
    <>
      {input && (
        <div className="out-section">
          <div className="out-label">{step.cat === "web" ? (d.url ? "Fetch" : "Search") : "Input"}</div>
          <pre className="out-pre">{input}</pre>
        </div>
      )}
      {d.image && (
        <div className="out-section">
          <img className="out-img" src={`data:${d.image.mediaType};base64,${d.image.data}`} alt="" />
        </div>
      )}
      <div className="out-section">
        <div className="out-label">{step.state === "run" ? "Waiting for the result…" : "Result"}</div>
        {out && (looksMarkdown ? <Markdown text={out} className="out-md" /> : <pre className="out-pre">{prettyJson(out)}</pre>)}
      </div>
    </>
  );
}

function prettyJson(s: string): string {
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return s;
}
