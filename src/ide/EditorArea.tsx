import { useEffect, useMemo, useRef } from "react";
import type { Ide, Presence, Tab } from "../lib/derive";
import { agentHue, agentName, isPaletteStep } from "../lib/derive";
import { baseName, duration, modelName, pathKey, relativeTo, tokens } from "../lib/format";
import { type Anim, setWatch, useDetail, useDetails, seek, useSession } from "../lib/store";
import type { Detail, Head, Hunk, Step } from "../lib/types";
import { CodeEditor, type PresenceMark, type Typing } from "./CodeEditor";
import { WatchBar, WatchMenu } from "../ui/WatchMenu";
import { TeamGrid } from "./TeamGrid";
import { settings } from "../lib/settings";
import { useSettings } from "../lib/settings";
import { Markdown } from "./Markdown";
import { FileIcon } from "./FileIcon";
import { Advisor, Close } from "../ui/Icons";

/** The typing animation for a step, while it's the one that just became current. */
export function typingFor(anim: Anim | null, i: number): Typing | null {
  if (!anim || anim.i !== i) return null;
  return { at: anim.at, dur: anim.dur };
}

export function EditorArea({ ide, head, steps }: { ide: Ide; head: Head | null; steps: Step[] }) {
  const { anim } = useSession();
  const active = ide.tabs.find((t) => t.id === ide.activeTab) ?? null;
  const { showTeam } = useSettings();
  // Dialogs and the palette belong to the watched one's screen: its question stays up while it
  // waits for you, a palette command shows while it's the step being viewed.
  const mine = ide.watchCurrent;
  const onIt = !!mine && mine.i === ide.current?.i;
  const presentOn = (key: string | null) => (key ? ide.presence.filter((p) => p.file?.key === key) : []);
  return (
    <section className={`editor-area${ide.watch ? " watching" : ""}`} style={{ ["--hue" as string]: agentHue(ide.watch) }}>
      <WatchBar head={head} steps={steps} cursor={ide.current?.i ?? -1} watch={ide.watch} />
      {mine && mine.kind === "tool" && mine.cat === "ask" && (onIt || mine.state === "run") && <AskDialog step={mine} head={head} />}
      {mine && onIt && isPaletteStep(mine) && <PaletteBar step={mine} />}
      {mine && onIt && mine.kind === "tool" && mine.cat === "advisor" && <AdvisorCard step={mine} head={head} />}
      <div className="tabbar">
      <div className="tabstrip" role="tablist">
        {ide.tabs.map((t) => (
          <TabButton key={t.id} tab={t} active={t.id === ide.activeTab} step={steps[t.step]} present={presentOn(t.path ? pathKey(t.path) : null)} head={head} />
        ))}
        <div className="tabstrip-fill" />
      </div>
        {/* Pinned at the right: only the tabs scroll. */}
        <PresenceStrip presence={ide.presence} head={head} />
        <WatchMenu head={head} steps={steps} cursor={ide.current?.i ?? -1} watch={ide.watch} />
        {(head?.agents.length ?? 0) > 0 && (
          <div className="team-toggle-wrap">
            <button
              className={`team-toggle${showTeam ? " on" : ""}`}
              aria-pressed={showTeam}
              onClick={() => settings.set({ showTeam: !showTeam })}
              title="Team: every agent's screen at once (Ctrl+Shift+T)"
            >
              ⊞ Team
            </button>
          </div>
        )}
      </div>
      {showTeam && (head?.agents.length ?? 0) > 0 ? (
        <TeamGrid head={head} steps={steps} cursor={ide.current?.i ?? -1} watch={ide.watch} />
      ) : active ? (
        <TabBody key={active.id} tab={active} step={steps[active.step]} head={head} anim={anim} present={presentOn(active.path ? pathKey(active.path) : null)} />
      ) : (
        <EmptyEditor head={head} />
      )}
    </section>
  );
}

/** Everyone else at work, as a collaborator's avatar: hover for what they're doing, click to follow. */
function PresenceStrip({ presence, head }: { presence: Presence[]; head: Head | null }) {
  if (!presence.length) return null;
  return (
    <div className="presence-strip" aria-label="Also working">
      {presence.map((p) => {
        const name = agentName(head, p.agent);
        const doing = p.state === "starting" ? "starting" : p.last ? (p.last.kind === "tool" ? `${p.last.tool}: ${p.last.label}` : p.last.label) : "";
        return (
          <button
            key={p.agent}
            className={`presence-dot${p.state === "starting" ? " starting" : ""}`}
            style={{ ["--hue" as string]: agentHue(p.agent) }}
            title={`${name}\n${doing}${p.file ? `\nOn ${baseName(p.file.path)}` : ""}\n\nClick to watch its screen`}
            onClick={() => setWatch(p.agent)}
          >
            {p.agent === 0 ? "C" : p.agent}
          </button>
        );
      })}
    </div>
  );
}

function TabButton({ tab, active, step, present, head }: { tab: Tab; active: boolean; step: Step | undefined; present: Presence[]; head: Head | null }) {
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
      data-path={tab.kind === "file" ? (tab.path ?? undefined) : undefined}
    >
      {tab.kind === "file" ? <FileIcon name={tab.title} /> : <span className="tab-web" aria-hidden="true">◍</span>}
      <span className={`tab-title${dirty ? " modified" : ""}`}>{tab.title}</span>
      {tab.agent > 0 && <span className="agent-pip" style={{ ["--hue" as string]: agentHue(tab.agent) }} />}
      {present.length > 0 && (
        <span className="tab-presence" title={present.map((p) => agentName(head, p.agent)).join("\n") + "\n(also on this file)"}>
          {present.slice(0, 4).map((p) => (
            <span key={p.agent} className="tab-presence-dot" style={{ ["--hue" as string]: agentHue(p.agent) }} />
          ))}
        </span>
      )}
      <span className="tab-close" aria-hidden="true">
        <Close size={10} />
      </span>
    </button>
  );
}

function EmptyEditor({ head }: { head: Head | null }) {
  return (
    <div className="editor-empty">
      <div className="editor-empty-mark">agentboat</div>
      <p>Files open here as Claude reads and changes them.</p>
      {head?.meta.cwd && <p className="dim mono">{head.meta.cwd}</p>}
    </div>
  );
}

function Breadcrumb({ path, cwd, extra }: { path: string; cwd: string | null; extra?: React.ReactNode }) {
  const rel = relativeTo(path, cwd);
  const parts = (rel ?? path.replace(/\\/g, "/")).split("/").filter(Boolean);
  return (
    <div className="breadcrumb" data-path={path}>
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

function TabBody({ tab, step, head, anim, present }: { tab: Tab; step: Step | undefined; head: Head | null; anim: Anim | null; present: Presence[] }) {
  const detail = useDetail(step);
  if (!step) return null;
  if (tab.kind === "browser") return <BrowserView step={step} detail={detail} />;
  const cwd = head?.meta.cwd ?? null;
  const fromShell = step.cat === "shell" || step.cat === "git";
  const shellRead = fromShell && step.files?.some((f) => f.op === "read" && tab.path && pathKey(f.path) === pathKey(tab.path));
  const verb = fromShell ? (shellRead ? "Read from the terminal" : "Written from the terminal") : step.cat === "read" ? "Read" : step.cat === "write" ? (step.created ? "Created" : "Wrote") : "Edited";
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
      <FileContent step={step} path={tab.path ?? step.path ?? ""} detail={detail} typing={typingFor(anim, step.i)} present={present} head={head} />
    </div>
  );
}

function firstLines(s: string, n: number) {
  return s.split("\n").slice(0, n).join("\n");
}

function FileContent({
  step,
  path,
  detail,
  typing,
  present,
  head,
}: {
  step: Step;
  path: string;
  detail: Detail | null | undefined;
  typing: Typing | null;
  present: Presence[];
  head: Head | null;
}) {
  // Where each collaborator on this file is: the lines it read, or the line it changed.
  const theirDetails = useDetails(present.map((p) => p.file!.ref));
  const presenceMarks: PresenceMark[] = present.flatMap((p, k) => {
    const line = presenceLine(theirDetails[k], path);
    return line ? [{ line, label: agentName(head, p.agent), hue: agentHue(p.agent) }] : [];
  });
  const name = baseName(path);
  const { wordWrap } = useSettings();
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
  return <CodeEditor doc={view.doc} original={view.original} name={name} startLine={view.start} typing={step.cat === "read" ? null : typing} wrap={wordWrap} presence={presenceMarks} />;
}

/** What the editor shows for a file step: the file, or a change to it. */
function fileView(step: Step, d: Detail | null | undefined, path: string): { doc: string; original: string | null; start: number } | null {
  if (!d) return null;
  if (d.kind === "shell") {
    const key = pathKey(path);
    const f = d.files?.find((x) => pathKey(x.path) === key);
    // Read from the terminal by a command that only printed it: its output is the file's text.
    if (f?.op === "read" && f.exact) {
      const out = (d.stdout ?? d.output ?? "").replace(/\r\n/g, "\n");
      return { doc: out, original: null, start: f.line ?? 1 };
    }
    // A file written from the terminal: the heredoc's (or echo's) text, typed in like a new file.
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
/** The line of a file another agent is on: the start of what it read, or where it changed it. */
function presenceLine(d: Detail | null | undefined, path: string): number | null {
  if (!d) return null;
  if (d.kind === "read") return d.startLine ?? 1;
  if (d.kind === "edit") {
    if (d.before != null && d.after != null) {
      const a = d.before.replace(/\r\n/g, "\n");
      const b = d.after.replace(/\r\n/g, "\n");
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return (d.startLine ?? 1) + (b.slice(0, i).match(/\n/g)?.length ?? 0);
    }
    if (d.patch?.length) return d.patch[0].newStart;
    return d.startLine ?? 1;
  }
  if (d.kind === "shell") {
    const f = d.files?.find((x) => pathKey(x.path) === pathKey(path));
    if (f) return f.line ?? 1;
  }
  return null;
}

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

// ---------- the advisor: a stronger model Claude consults ----------

/** Why an advisor call failed, by the API's error code. Claude carries on without advice. */
const ADVISOR_ERRORS: Record<string, string> = {
  max_uses_exceeded: "The advisor's call limit for this request was reached",
  too_many_requests: "The advisor was rate-limited",
  overloaded: "The advisor model was overloaded",
  prompt_too_long: "The conversation is longer than the advisor model's context window",
  execution_time_exceeded: "The advisor took too long",
  model_not_found: "The advisor model isn't available to this account",
  unavailable: "The advisor failed",
};

/**
 * Claude consulting its advisor (`/advisor`): the call takes no input, the API forwards the whole
 * conversation, and the advice comes back to Claude. Newer advisor models' advice is encrypted:
 * only Claude reads it, so what's shown is that it happened, how long it took and its size.
 */
export function AdvisorCard({ step, head }: { step: Step; head: Head | null }) {
  const d = useDetail(step);
  const model = modelName(d?.model ?? step.label);
  const who = step.agent > 0 ? agentName(head, step.agent) : "Claude";
  const took = step.end && step.end > step.ts ? duration(step.end - step.ts) : null;
  const cut = d?.stopReason === "max_tokens";
  return (
    <div className="palette-wrap">
      <div className="palette advisor-card" role="dialog" aria-label="Advisor">
        <div className="palette-input">
          <Advisor size={15} className="advisor-icon" />
          <span className="ellipsis">
            {who} asks <b>{model}</b> for advice
          </span>
          <span className="nw-fill" />
          {step.state === "run" ? (
            <span className="advisor-state">
              <span className="spinner" /> Reviewing…
            </span>
          ) : step.state === "err" ? (
            <span className="advisor-state o-err">{step.sub ? "Unavailable" : "Interrupted"}</span>
          ) : (
            <span className="advisor-state">Reviewed{took ? ` · ${took}` : ""}</span>
          )}
        </div>
        <div className="palette-row dim">
          Sent: the whole conversation so far{d?.inputTokens ? ` · ${tokens(d.inputTokens)} tokens` : ""}
        </div>
        {d?.result === "advice" && d.text && (
          <div className="advisor-advice">
            <Markdown text={d.text} />
          </div>
        )}
        {d?.result === "encrypted" && (
          <div className="palette-row">
            Advice{d.outputTokens ? ` · ${tokens(d.outputTokens)} tokens` : ""}, encrypted: {model} writes it for Claude only,
            and the transcript keeps just the ciphertext.
          </div>
        )}
        {d?.result === "error" && (
          <div className="palette-row o-err">
            {ADVISOR_ERRORS[d.errorCode ?? ""] ?? `The advisor failed (${d.errorCode})`}; {who} carried on without advice.
          </div>
        )}
        {cut && <div className="palette-row dim">The advice was cut at the advisor's token limit.</div>}
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
