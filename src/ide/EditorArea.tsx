import { useEffect, useMemo, useRef } from "react";
import type { Ide, Tab } from "../lib/derive";
import { agentHue, agentName, isPaletteStep } from "../lib/derive";
import { baseName, pathKey, relativeTo } from "../lib/format";
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
  const cur = ide.current;
  return (
    <section className="editor-area">
      {cur && cur.kind === "tool" && cur.cat === "ask" && <AskDialog step={cur} head={head} />}
      {cur && isPaletteStep(cur) && <PaletteBar step={cur} />}
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
      {tab.kind === "file" ? <FileIcon name={tab.title} /> : <span className="tab-web" aria-hidden="true">◍</span>}
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
  if (tab.kind === "browser") return <BrowserView step={step} detail={detail} />;
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

// ---------- the browser (WebFetch, WebSearch) ----------

function BrowserView({ step, detail }: { step: Step; detail: Detail | null | undefined }) {
  const search = step.tool === "WebSearch";
  const address = search ? (detail?.query ?? step.label) : (detail?.url ?? step.label);
  const out = detail?.output ?? "";
  // A search's result text carries its links as JSON: `Links: [{"title":…,"url":…}]`.
  const { links, summary } = useMemo(() => {
    if (!search) return { links: [] as { title: string; url: string }[], summary: out };
    const m = /^Links: (\[.*\])\s*$/m.exec(out);
    let links: { title: string; url: string }[] = [];
    if (m) {
      try {
        links = JSON.parse(m[1]);
      } catch {
        /* not JSON after all */
      }
    }
    const summary = out
      .replace(/^Web search results for query:.*$/m, "")
      .replace(/^Links: \[.*\]\s*$/m, "")
      .trim();
    return { links, summary };
  }, [out, search]);
  return (
    <div className="tab-body">
      <div className="browser-bar">
        <span className="browser-nav" aria-hidden="true">
          ‹ › ↻
        </span>
        <div className="browser-address" title={address}>
          {search ? <span className="browser-search">Search</span> : <span className="browser-lock">https</span>}
          <span className="ellipsis">{search ? address : address.replace(/^https?:\/\//, "")}</span>
        </div>
        {step.state === "run" && <span className="spinner" />}
      </div>
      {step.state === "run" && <div className="browser-loading" />}
      <div className="browser-page">
        {detail === undefined ? null : step.state === "run" ? (
          <p className="dim">{search ? "Searching…" : "Loading the page…"}</p>
        ) : detail?.error ? (
          <div className="browser-error">
            <div className="browser-error-code">{detail.httpStatus ? `HTTP ${detail.httpStatus}` : "Couldn't load"}</div>
            <b>This page couldn't be loaded.</b>
            {detail.httpStatus && detail.httpStatus >= 500 && <p>The site refused or failed the request. Many sites turn away automated readers like Claude's.</p>}
            <pre>{detail.error}</pre>
          </div>
        ) : (
          <>
            {!search && detail?.prompt && <div className="browser-asked">Reading for: {detail.prompt}</div>}
            {links.length > 0 && (
              <div className="serp">
                {links.map((l, k) => (
                  <div key={k} className="serp-item" title={l.url}>
                    <div className="serp-host">{l.url.replace(/^https?:\/\//, "").split("/")[0]}</div>
                    <div className="serp-title">{l.title}</div>
                    <div className="serp-url ellipsis">{l.url}</div>
                  </div>
                ))}
              </div>
            )}
            {summary && <Markdown text={summary} className="browser-md" />}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- a question for you (AskUserQuestion), as a dialog ----------

export function AskDialog({ step, head }: { step: Step; head: Head | null }) {
  const d = useDetail(step);
  const waiting = step.state === "run";
  return (
    <div className="ask-overlay">
      <div className="ask-dialog" role="dialog" aria-label="Claude is asking">
        <div className="ask-dialog-head">
          <span className="ask-dialog-icon">?</span>
          <span>{step.agent > 0 ? `${agentName(head, step.agent)} asks` : "Claude asks"}</span>
          <span className="nw-fill" />
          {waiting ? <span className="ask-wait">Waiting for your answer…</span> : step.state === "err" ? <span className="ask-wait err">Dismissed</span> : <span className="ask-done">Answered</span>}
        </div>
        {(d?.questions ?? []).map((q, k) => {
          const answer = d?.answers?.[q.question];
          const labels = (q.options ?? []).map((o) => o.label);
          return (
            <div key={k} className="ask-q">
              {q.header && <div className="ask-h">{q.header}</div>}
              <div className="ask-text">{q.question}</div>
              <div className="ask-opts">
                {(q.options ?? []).map((o, j) => {
                  const chosen = !!answer && answer.includes(o.label);
                  return (
                    <div key={j} className={`ask-opt${chosen ? " chosen" : ""}`}>
                      <span className="ask-radio">{chosen ? "●" : "○"}</span>
                      <span>
                        <b>{o.label}</b>
                        {o.description && <span className="ask-desc"> {o.description}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
              {answer && !labels.some((l) => answer.includes(l)) && <div className="ask-a">Answered: {answer}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- a command run from the palette (Skill, ToolSearch) ----------

export function PaletteBar({ step }: { step: Step }) {
  const d = useDetail(step);
  const input = (d?.input ?? {}) as Record<string, unknown>;
  const what = step.tool === "Skill" ? `Skill: ${String(input.skill ?? step.label)}` : `${step.tool}: ${String(input.query ?? step.label)}`;
  const args = step.tool === "Skill" && typeof input.args === "string" ? input.args : null;
  const result = (d?.output ?? "").split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="palette-wrap">
      <div className="palette" role="dialog" aria-label="Command">
        <div className="palette-input">
          <span className="palette-prompt">&gt;</span>
          <span className="ellipsis">{what}</span>
          {step.state === "run" && <span className="spinner" />}
        </div>
        {args && <div className="palette-row dim ellipsis">{args}</div>}
        {result && step.state !== "run" && <div className={`palette-row ellipsis${step.state === "err" ? " o-err" : ""}`}>{result}</div>}
      </div>
    </div>
  );
}
