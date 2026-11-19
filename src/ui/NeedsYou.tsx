import { useEffect, useMemo, useRef, useState } from "react";
import {
  answer,
  dismiss,
  hookStatus,
  isRequest,
  openInClaudeCode,
  setHook,
  useAttention,
  type AttentionItem,
  type HookStatus,
  type Suggestion,
} from "../lib/attention";
import { openSession } from "../lib/store";
import { settings, useSettings } from "../lib/settings";
import { appWindow } from "../lib/tauri";
import { ago } from "../lib/format";
import { highlightCommand, Tokens } from "../ide/termColor";
import { JsonTree } from "../ide/DataView";
import { Markdown } from "../ide/Markdown";
import { Dialog } from "./Dialog";
import { Bell, Close, Eye, Terminal } from "./Icons";

/**
 * "Needs you": the title-bar bell and the panel under it. Every running session waiting on you,
 * across all sessions (not only the one open): its prompts answered here, the rest a click away
 * from its terminal.
 */

const ORDER: Record<AttentionItem["kind"], number> = { permission: 0, question: 0, plan: 0, waiting: 1, done: 2 };

export function NeedsYouButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const items = useAttention();
  const s = useSettings();
  const shown = items.filter((i) => i.kind !== "done" || s.needsYouDone);
  const urgent = shown.filter((i) => i.kind !== "done").length;
  return (
    <button
      className={`icon-btn ny-bell${urgent ? " urgent" : ""}`}
      aria-pressed={open}
      onClick={onToggle}
      title={urgent ? `${urgent} waiting on you` : shown.length ? "Sessions that finished their turn" : "Nothing needs you"}
    >
      <Bell />
      {shown.length > 0 && <span className={`ny-count${urgent ? "" : " quiet"}`}>{shown.length}</span>}
    </button>
  );
}

/** Opens the panel (and, if you asked, brings Ccboat to the front) when something new needs you. */
export function useNeedsYouAlerts(open: () => void) {
  const items = useAttention();
  const seen = useRef<Set<number>>(new Set());
  useEffect(() => {
    const fresh = items.filter((i) => i.kind !== "done" && !seen.current.has(i.id));
    items.forEach((i) => seen.current.add(i.id));
    if (!fresh.length) return;
    const s = settings.get();
    if (s.needsYouOpen) open();
    if (s.needsYouFront && appWindow) {
      const w = appWindow;
      void w.unminimize().then(() => w.show()).then(() => w.setFocus()).catch(() => {});
    }
  }, [items, open]);
}

export function NeedsYouPanel({ onClose }: { onClose: () => void }) {
  const items = useAttention();
  const s = useSettings();
  const [hook, setHookState] = useState<HookStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const refreshHook = () => void hookStatus().then(setHookState).catch(() => {});
  useEffect(refreshHook, []);

  const shown = useMemo(
    () =>
      items
        .filter((i) => i.kind !== "done" || s.needsYouDone)
        .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (a.kind === "done" ? b.at - a.at : a.at - b.at)),
    [items, s.needsYouDone],
  );

  return (
    <aside className="ny-panel" role="dialog" aria-label="Needs you">
      <div className="ny-head">
        <span className="ny-title">Needs you</span>
        <span className="ny-sub">{shown.length ? `${shown.length} session${shown.length > 1 ? "s" : ""}` : ""}</span>
        <span className="ny-fill" />
        <button className="btn small-btn" onClick={() => setSetup(true)}>
          {hook?.installed ? "Settings" : "Answer here…"}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
          <Close />
        </button>
      </div>
      <div className="ny-list">
        {hook && !hook.installed && (
          <div className="ny-callout">
            Permission prompts, questions and plans can be answered right here, without going to the terminal.{" "}
            <button className="linkish" onClick={() => setSetup(true)}>
              Turn it on
            </button>
          </div>
        )}
        {hook?.installed && hook.error && <div className="ny-callout err">{hook.error}</div>}
        {shown.length === 0 && <p className="side-empty">Nothing needs you. Sessions that ask for something show up here right away.</p>}
        {shown.map((i) => (
          <Card key={i.id} item={i} />
        ))}
      </div>
      {setup && (
        <HookDialog
          onClose={() => {
            setSetup(false);
            refreshHook();
          }}
        />
      )}
    </aside>
  );
}

// ---------- a card ----------

function Card({ item }: { item: AttentionItem }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 15000);
    return () => window.clearInterval(t);
  }, []);

  const send = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
    } catch (e) {
      setNote(String(e));
      setBusy(false);
    }
  };
  const goTerminal = async () => {
    try {
      const how = await openInClaudeCode(item.sessionId, item.cwd);
      setNote(how === "focused" ? "Its terminal is in front." : "Opened in a new terminal.");
    } catch (e) {
      setNote(String(e));
    }
  };

  const who = item.agentType ? `${item.agentType} agent` : null;
  return (
    <div className={`ny-card k-${item.kind}`}>
      <div className="ny-card-head">
        <span className={`st-dot ${item.kind === "done" ? "s-idle" : "s-waiting"}`} />
        <span className="ny-where ellipsis" title={item.cwd ?? undefined}>
          <b>{item.folder || "Session"}</b>
          {item.title && <> — {item.title}</>}
        </span>
        <span className="ny-ago">{ago(item.at)}</span>
      </div>
      <div className="ny-what">
        {headline(item)}
        {who && <span className="ny-who"> · {who}</span>}
      </div>

      {item.kind === "permission" && <PermissionBody item={item} busy={busy} send={send} />}
      {item.kind === "question" && <QuestionBody item={item} busy={busy} send={send} />}
      {item.kind === "plan" && <PlanBody item={item} busy={busy} send={send} />}

      <div className="ny-links">
        {isRequest(item) ? (
          <button className="linkish" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "release" })).then(goTerminal)}>
            Answer in the terminal
          </button>
        ) : (
          <button className="btn small-btn primary" onClick={() => void goTerminal()}>
            <Terminal size={13} /> Open in Claude Code
          </button>
        )}
        {item.transcript && (
          <button className="linkish" onClick={() => void openSession(item.transcript!)} title="Watch this session in Ccboat">
            <Eye size={13} /> Watch
          </button>
        )}
        <span className="ny-fill" />
        {!isRequest(item) && (
          <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => void dismiss(item.id)}>
            <Close />
          </button>
        )}
      </div>
      {note && <div className="ny-note">{note}</div>}
    </div>
  );
}

function headline(i: AttentionItem): string {
  switch (i.kind) {
    case "permission":
      return `Wants to use ${toolLabel(i)}`;
    case "question":
      return "Has a question for you";
    case "plan":
      return "Has a plan for you to approve";
    case "waiting":
      return i.waitingFor ? `Waiting for your ${i.waitingFor.replace(/_/g, " ")} in its terminal` : "Waiting for you in its terminal";
    case "done":
      return "Finished — your turn";
  }
}

function toolLabel(i: AttentionItem): string {
  const t = i.tool ?? "a tool";
  const m = /^mcp__(.+?)__(.+)$/.exec(t);
  if (m) return `${m[2]} (${i.mcpServer ?? m[1]})`;
  return t;
}

type Send = (f: () => Promise<unknown>) => Promise<void>;

// ---------- a tool's permission ----------

function PermissionBody({ item, busy, send }: { item: AttentionItem; busy: boolean; send: Send }) {
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState("");
  const always = suggestionLabel(item.suggestions);
  return (
    <>
      <ToolInput item={item} />
      {!denying ? (
        <div className="ny-actions">
          <button className="btn primary" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "allow" }))}>
            Allow
          </button>
          {always && (
            <button className="btn" disabled={busy} title={always} onClick={() => void send(() => answer(item.id, { kind: "allow", always: true }))}>
              <span className="ellipsis">{always}</span>
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => setDenying(true)}>
            Deny…
          </button>
        </div>
      ) : (
        <div className="ny-deny">
          <textarea autoFocus rows={2} placeholder="Tell Claude what to do instead (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
          <div className="ny-actions">
            <button className="btn primary" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "deny", message: why }))}>
              Deny
            </button>
            <button className="btn" disabled={busy} title="Deny, and stop Claude's turn" onClick={() => void send(() => answer(item.id, { kind: "deny", message: why, interrupt: true }))}>
              Deny and stop
            </button>
            <button className="btn" disabled={busy} onClick={() => setDenying(false)}>
              Back
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function clip(text: string, lines = 14): string {
  const all = text.split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines` : text;
}

/** What the tool would do, in the shape that fits it. */
function ToolInput({ item }: { item: AttentionItem }) {
  const inp = item.input ?? {};
  const tool = item.tool ?? "";
  const path = str(inp.file_path) ?? str(inp.notebook_path) ?? str(inp.path);
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = str(inp.command) ?? "";
    return (
      <div className="ny-input">
        {str(inp.description) && <div className="ny-desc">{str(inp.description)}</div>}
        <pre className="ny-code">
          <Tokens toks={highlightCommand(clip(cmd, 20), tool === "PowerShell")} />
        </pre>
      </div>
    );
  }
  if (tool === "Edit" || tool === "MultiEdit") {
    const edits = Array.isArray(inp.edits) ? (inp.edits as Record<string, unknown>[]) : [inp];
    return (
      <div className="ny-input">
        <div className="ny-path">{path}</div>
        {edits.slice(0, 4).map((e, k) => (
          <pre key={k} className="ny-code ny-diff">
            {clip(str(e.old_string) ?? "", 8)
              .split("\n")
              .map((l, j) => (
                <div key={`o${j}`} className="del">- {l}</div>
              ))}
            {clip(str(e.new_string) ?? "", 8)
              .split("\n")
              .map((l, j) => (
                <div key={`n${j}`} className="add">+ {l}</div>
              ))}
          </pre>
        ))}
      </div>
    );
  }
  if (tool === "Write") {
    return (
      <div className="ny-input">
        <div className="ny-path">{path}</div>
        <pre className="ny-code">{clip(str(inp.content) ?? "", 12)}</pre>
      </div>
    );
  }
  if (tool === "WebFetch" || tool === "WebSearch") {
    return (
      <div className="ny-input">
        <div className="ny-path">{str(inp.url) ?? str(inp.query)}</div>
        {str(inp.prompt) && <div className="ny-desc">{str(inp.prompt)}</div>}
      </div>
    );
  }
  if (path && Object.keys(inp).length <= 3) {
    return (
      <div className="ny-input">
        <div className="ny-path">{path}</div>
      </div>
    );
  }
  if (!Object.keys(inp).length) return null;
  return (
    <div className="ny-input ny-json">
      <JsonTree value={inp} open={2} />
    </div>
  );
}

const WHERE: Record<string, string> = {
  session: "for this session",
  localSettings: "in this project",
  projectSettings: "in this project, for everyone",
  userSettings: "everywhere",
};

/** "Always allow Bash(npm test:*) in this project", from what Claude Code offers to remember. */
function suggestionLabel(sug: Suggestion[] | null): string | null {
  if (!sug?.length) return null;
  const parts = sug.map((s) => {
    const where = s.destination ? ` ${WHERE[s.destination] ?? ""}` : "";
    if (s.type === "addRules" && s.rules?.length) {
      const rules = s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(", ");
      return `${s.behavior === "deny" ? "Always deny" : "Always allow"} ${rules}${where}`;
    }
    if (s.type === "setMode" && s.mode) return s.mode === "acceptEdits" ? "and auto-accept edits" : `and switch to ${s.mode}`;
    if (s.type === "addDirectories" && s.directories?.length) return `Always allow ${s.directories.join(", ")}${where}`;
    return null;
  });
  const ok = parts.filter(Boolean);
  return ok.length ? ok.join(" · ").trim() : "Always allow";
}

// ---------- a question (AskUserQuestion) ----------

interface Q {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

function QuestionBody({ item, busy, send }: { item: AttentionItem; busy: boolean; send: Send }) {
  const qs = (Array.isArray(item.input?.questions) ? item.input.questions : []) as Q[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Q, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const answerOf = (q: Q) => {
    const own = other[q.question]?.trim();
    const labels = picked[q.question] ?? [];
    return [...labels, ...(own ? [own] : [])].join(", ");
  };
  const ready = qs.length > 0 && qs.every((q) => answerOf(q));
  return (
    <>
      {qs.map((q) => (
        <div key={q.question} className="ny-q">
          {q.header && <span className="ny-chip">{q.header}</span>}
          <div className="ny-q-text">{q.question}</div>
          <div className="ny-opts">
            {(q.options ?? []).map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} className={`ny-opt${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                  <span className="ny-mark">{q.multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}</span>
                  <span>
                    {o.label}
                    {o.description && <span className="ny-opt-desc"> — {o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              className="ny-other"
              placeholder={q.multiSelect ? "Something else (added to your picks)" : "Or type your own answer"}
              value={other[q.question] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setOther((o) => ({ ...o, [q.question]: v }));
                if (!q.multiSelect && v.trim()) setPicked((p) => ({ ...p, [q.question]: [] }));
              }}
            />
          </div>
        </div>
      ))}
      <div className="ny-actions">
        <button
          className="btn primary"
          disabled={busy || !ready}
          onClick={() => void send(() => answer(item.id, { kind: "answers", answers: Object.fromEntries(qs.map((q) => [q.question, answerOf(q)])) }))}
        >
          Answer
        </button>
        <button className="btn" disabled={busy} title="Tell Claude you'd rather not answer" onClick={() => void send(() => answer(item.id, { kind: "deny", message: "The user declined to answer these questions." }))}>
          Skip
        </button>
      </div>
    </>
  );
}

// ---------- a plan (ExitPlanMode) ----------

function PlanBody({ item, busy, send }: { item: AttentionItem; busy: boolean; send: Send }) {
  const [revising, setRevising] = useState(false);
  const [why, setWhy] = useState("");
  const plan = str(item.input?.plan);
  const always = suggestionLabel(item.suggestions);
  return (
    <>
      {plan ? (
        <div className="ny-plan">
          <Markdown text={plan} />
        </div>
      ) : (
        <div className="ny-desc">The plan is in the session's terminal.</div>
      )}
      {!revising ? (
        <div className="ny-actions">
          <button className="btn primary" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "approve" }))}>
            Approve
          </button>
          {always && (
            <button className="btn" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "approve", always: true }))}>
              {always.startsWith("and ") ? `Approve ${always}` : `Approve · ${always}`}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => setRevising(true)}>
            Keep planning…
          </button>
        </div>
      ) : (
        <div className="ny-deny">
          <textarea autoFocus rows={3} placeholder="What should change in the plan?" value={why} onChange={(e) => setWhy(e.target.value)} />
          <div className="ny-actions">
            <button className="btn primary" disabled={busy} onClick={() => void send(() => answer(item.id, { kind: "deny", message: why || "Keep planning; the plan isn't approved yet." }))}>
              Send
            </button>
            <button className="btn" disabled={busy} onClick={() => setRevising(false)}>
              Back
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- turning it on ----------

export function HookDialog({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<HookStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useSettings();
  const load = () => void hookStatus().then(setSt).catch((e) => setErr(String(e)));
  useEffect(load, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await setHook(on);
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
    load();
  };
  const on = !!st?.installed;
  return (
    <Dialog
      title="Answer prompts in Ccboat"
      onClose={onClose}
      width={560}
      footer={
        <>
          {on ? (
            <button className="btn" disabled={busy} onClick={() => void toggle(false)}>
              Turn off
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !st} onClick={() => void toggle(true)}>
              Turn on
            </button>
          )}
          <span className="ny-fill" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p>
        When a session asks for permission, asks you a question or has a plan to approve, it shows up in <b>Needs you</b> and you can answer it there. The
        terminal shows the same prompt: answer in either place.
      </p>
      <p className="dim">
        For this Ccboat adds one hook to Claude Code's settings, <code>{st?.settings || "~/.claude/settings.json"}</code>, and removes it when you turn this
        off. Nothing else in the file changes; a copy of it from before is kept as <code>settings.json.ccboat-backup</code>. When Ccboat isn't running,
        Claude Code asks in the terminal as usual. Sessions started from now on are covered; restart ones already running if they don't show up.
      </p>
      <div className="ny-status">
        <span className={`st-dot ${on && st?.listening ? "s-idle" : "s-ended"}`} />
        {!st
          ? "Checking…"
          : on
            ? st.listening
              ? st.current
                ? `On. Listening on 127.0.0.1:${st.port}.`
                : "On, but for another port: turn it off and on again."
              : "On, but Ccboat can't listen for prompts."
            : "Off."}
      </div>
      {(err || st?.error) && <div className="ny-callout err">{err ?? st?.error}</div>}
      <div className="ny-prefs">
        <label>
          <input type="checkbox" checked={s.needsYouOpen} onChange={(e) => settings.set({ needsYouOpen: e.target.checked })} /> Open the panel when a
          session needs you
        </label>
        <label>
          <input type="checkbox" checked={s.needsYouFront} onChange={(e) => settings.set({ needsYouFront: e.target.checked })} /> Also bring Ccboat to the
          front
        </label>
        <label>
          <input type="checkbox" checked={s.needsYouDone} onChange={(e) => settings.set({ needsYouDone: e.target.checked })} /> List sessions that finish
          their turn
        </label>
      </div>
    </Dialog>
  );
}
