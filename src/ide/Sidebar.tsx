import { useMemo, useState } from "react";
import type { FileMark, Ide } from "../lib/derive";
import { agentHue, agentKind, agentName, agentProgress, workflowProgress } from "../lib/derive";
import { baseName, clock, pathKey, relativeTo } from "../lib/format";
import { seek, setWatch, useDetail } from "../lib/store";
import type { Head, Step } from "../lib/types";
import { Agents, ArrowDown, ArrowUp, Branch, Checklist, Chevron, Commit, Files, Folder, Search } from "../ui/Icons";
import { FileIcon } from "./FileIcon";

export type View = "explorer" | "search" | "git" | "tasks" | "agents";

export function ActivityBar({ view, onView, ide, head }: { view: View; onView: (v: View) => void; ide: Ide; head: Head | null }) {
  const items: { id: View; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "explorer", label: "Explorer: files Claude touched", icon: <Files /> },
    { id: "search", label: "Search: Claude's searches", icon: <Search />, badge: ide.searches.length || undefined },
    { id: "git", label: "Source Control", icon: <Branch />, badge: ide.changes.length || undefined },
    { id: "tasks", label: "Tasks", icon: <Checklist />, badge: ide.tasks?.filter((t) => t.status !== "completed").length || undefined },
    { id: "agents", label: "Subagents", icon: <Agents />, badge: head?.agents.length || undefined },
  ];
  return (
    <nav className="activity-bar" aria-label="Views">
      {items.map((it) => (
        <button key={it.id} className={`activity${view === it.id ? " active" : ""}`} title={it.label} aria-pressed={view === it.id} onClick={() => onView(it.id)}>
          {it.icon}
          {it.badge ? <span className="activity-badge">{it.badge > 99 ? "99+" : it.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Sidebar({ view, ide, head, steps }: { view: View; ide: Ide; head: Head | null; steps: Step[] }) {
  return (
    <aside className="sidebar">
      {view === "explorer" && <Explorer ide={ide} head={head} />}
      {view === "search" && <SearchView ide={ide} steps={steps} head={head} />}
      {view === "git" && <SourceControl ide={ide} steps={steps} />}
      {view === "tasks" && <TasksView ide={ide} />}
      {view === "agents" && <AgentsView ide={ide} head={head} steps={steps} />}
    </aside>
  );
}

function SideHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="side-header">
      <span>{title}</span>
      <span className="side-header-fill" />
      {children}
    </div>
  );
}

// ---------- Explorer ----------

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: FileMark[];
}

function newNode(name: string, path: string): Node {
  return { name, path, dirs: new Map(), files: [] };
}

function buildTree(files: FileMark[], cwd: string | null): { root: Node; outside: Node } {
  const root = newNode(cwd ? baseName(cwd) : "project", cwd ?? "");
  const outside = newNode("Outside the project", "");
  for (const f of files) {
    if (f.rel !== null) {
      const parts = f.rel.split("/").filter(Boolean);
      let n = root;
      for (const p of parts.slice(0, -1)) {
        const path = n.path + "/" + p;
        if (!n.dirs.has(p)) n.dirs.set(p, newNode(p, path));
        n = n.dirs.get(p)!;
      }
      n.files.push(f);
    } else {
      // Outside: grouped by folder, shown whole.
      const full = f.path.replace(/\\/g, "/");
      const dir = full.slice(0, full.lastIndexOf("/")) || full;
      if (!outside.dirs.has(dir)) outside.dirs.set(dir, newNode(dir, dir));
      outside.dirs.get(dir)!.files.push(f);
    }
  }
  return { root, outside };
}

function Explorer({ ide, head }: { ide: Ide; head: Head | null }) {
  const cwd = head?.meta.cwd ?? null;
  const files = [...ide.files.values()];
  const { root, outside } = useMemo(() => buildTree(files, cwd), [ide.files, cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = ide.tabs.find((t) => t.id === ide.activeTab);
  const activeKey = active?.path ? pathKey(active.path) : null;
  // Collaborators on files now (shown as their colour dots).
  const here: Here = new Map();
  for (const p of ide.presence) if (p.file) here.set(p.file.key, [...(here.get(p.file.key) ?? []), p.agent]);
  const counts = { R: 0, M: 0, A: 0, D: 0 };
  files.forEach((f) => counts[f.status]++);
  return (
    <>
      <SideHeader title="Explorer">
        <span className="side-counts" title="Read · modified · added · deleted">
          {counts.R > 0 && <span className="st-R">{counts.R}</span>}
          {counts.M > 0 && <span className="st-M">{counts.M}</span>}
          {counts.A > 0 && <span className="st-A">{counts.A}</span>}
          {counts.D > 0 && <span className="st-D">{counts.D}</span>}
        </span>
      </SideHeader>
      <div className="side-scroll tree">
        {files.length === 0 && <p className="side-empty">Files appear here as Claude reads or changes them.</p>}
        {(root.files.length > 0 || root.dirs.size > 0) && <DirNode node={root} depth={0} activeKey={activeKey} rootLabel here={here} />}
        {outside.dirs.size > 0 && <DirNode node={outside} depth={0} activeKey={activeKey} rootLabel here={here} />}
      </div>
    </>
  );
}

/** Who else is on each file now: file key → agent numbers. */
type Here = Map<string, number[]>;

function DirNode({ node, depth, activeKey, rootLabel, here }: { node: Node; depth: number; activeKey: string | null; rootLabel?: boolean; here: Here }) {
  const [open, setOpen] = useState(true);
  // A chain of single folders reads as one row ("src/lib/ide").
  let n = node;
  let label = n.name;
  while (!rootLabel && n.files.length === 0 && n.dirs.size === 1) {
    n = [...n.dirs.values()][0];
    label += "/" + n.name;
  }
  const dirs = [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...n.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
  const hasModified = (x: Node): boolean => x.files.some((f) => f.status !== "R") || [...x.dirs.values()].some(hasModified);
  return (
    <div className="tree-dir">
      <button
        className={`tree-row dir${rootLabel ? " root" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => setOpen(!open)}
        title={n.path}
        data-path={n.path || undefined}
      >
        <Chevron open={open} />
        {!rootLabel && <Folder size={14} open={open} />}
        <span className={`tree-name${hasModified(n) ? " has-mod" : ""}`}>{rootLabel ? label.toUpperCase() : label}</span>
      </button>
      {open && (
        <>
          {dirs.map((d) => (
            <DirNode key={d.path} node={d} depth={depth + 1} activeKey={activeKey} here={here} />
          ))}
          {files.map((f) => (
            <button
              key={f.key}
              className={`tree-row file${f.key === activeKey ? " active" : ""}`}
              style={{ paddingLeft: 6 + (depth + 1) * 12 + 14 }}
              onClick={() => seek(f.last)}
              title={`${f.path}\nLast touched at step ${f.last + 1}${f.viaShell ? " (from the terminal)" : ""}`}
              data-path={f.path}
            >
              <FileIcon name={baseName(f.path)} />
              <span className={`tree-name st-${f.status}-name`}>{baseName(f.path)}</span>
              {here.get(f.key) && (
                <span className="tree-presence">
                  {here.get(f.key)!.slice(0, 3).map((n) => (
                    <span key={n} className="tab-presence-dot" style={{ ["--hue" as string]: agentHue(n) }} />
                  ))}
                </span>
              )}
              <span className={`tree-status st-${f.status}`}>{f.status}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// ---------- Search ----------

function SearchView({ ide, steps, head }: { ide: Ide; steps: Step[]; head: Head | null }) {
  const lastIdx = ide.searches[ide.searches.length - 1];
  const step = lastIdx !== undefined ? steps[lastIdx] : null;
  const d = useDetail(step);
  const cwd = head?.meta.cwd ?? null;
  const results = useMemo(() => parseResults(d?.output ?? "", cwd), [d?.output, cwd]);
  return (
    <>
      <SideHeader title="Search" />
      <div className="side-scroll">
        {!step && <p className="side-empty">Claude's searches (Grep, Glob) show here.</p>}
        {step && (
          <>
            <div className="search-box">
              <div className="search-field mono">{d?.pattern ?? step.label}</div>
              {(d?.path || d?.glob) && (
                <div className="search-scope">
                  {d?.glob && <span>files: {d.glob}</span>}
                  {d?.path && <span>in {relativeTo(d.path, cwd) || baseName(d.path)}</span>}
                </div>
              )}
              <div className="search-summary">
                {step.tool} · {step.state === "run" ? "searching…" : `${results.files.length} file${results.files.length === 1 ? "" : "s"}${results.hits ? `, ${results.hits} result${results.hits === 1 ? "" : "s"}` : ""}`}
              </div>
            </div>
            <div className="search-results">
              {results.files.slice(0, 300).map((f) => (
                <div key={f.file} className="sr-file">
                  <div className="sr-file-row" title={f.file} data-path={f.file}>
                    <FileIcon name={baseName(f.file)} />
                    <span className="sr-name">{baseName(f.file)}</span>
                    <span className="sr-dir">{dirOf(f.rel ?? f.file)}</span>
                    {f.lines.length > 0 && <span className="sr-count">{f.lines.length}</span>}
                  </div>
                  {f.lines.slice(0, 20).map((l, k) => (
                    <div key={k} className="sr-line mono" data-path={f.file} data-line={l.n ?? undefined}>
                      {l.n !== null && <span className="sr-ln">{l.n}</span>}
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
              ))}
              {results.other && <pre className="sr-other">{results.other}</pre>}
            </div>
          </>
        )}
        {ide.searches.length > 1 && (
          <div className="side-section">
            <div className="side-section-title">Earlier searches</div>
            {ide.searches
              .slice(0, -1)
              .slice(-30)
              .reverse()
              .map((i) => (
                <button key={i} className="list-row" onClick={() => seek(i)}>
                  <Search size={13} />
                  <span className="mono ellipsis">{steps[i].label}</span>
                  <span className="list-meta">{clock(steps[i].ts)}</span>
                </button>
              ))}
          </div>
        )}
      </div>
    </>
  );
}

function dirOf(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "";
}

interface Results {
  files: { file: string; rel: string | null; lines: { n: number | null; text: string }[] }[];
  hits: number;
  other: string;
}

/** Grep / Glob output (file lists, or `path:line:text`) grouped by file. */
function parseResults(out: string, cwd: string | null): Results {
  const files = new Map<string, Results["files"][number]>();
  const other: string[] = [];
  let hits = 0;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    // `D:\a\b.ts:12:text` or `src/b.ts:12:text` or `src/b.ts-12-context`.
    const m = /^((?:[A-Za-z]:)?[^:]+?):(\d+)[:-](.*)$/.exec(line);
    const isPath = /^((?:[A-Za-z]:)?[\\/]|\.{0,2}[\\/]|[\w@.-]+[\\/])[^\s:]*\.?\w*$/.test(line.trim()) || /^[\w@.-]+\.\w+$/.test(line.trim());
    if (m) {
      const f = m[1];
      if (!files.has(f)) files.set(f, { file: f, rel: relativeTo(f, cwd), lines: [] });
      files.get(f)!.lines.push({ n: Number(m[2]), text: m[3].trim() });
      hits++;
    } else if (isPath) {
      const f = line.trim();
      if (!files.has(f)) files.set(f, { file: f, rel: relativeTo(f, cwd), lines: [] });
    } else {
      other.push(line);
    }
  }
  return { files: [...files.values()], hits, other: other.slice(0, 40).join("\n") };
}

// ---------- Source Control ----------

function SourceControl({ ide, steps }: { ide: Ide; steps: Step[] }) {
  return (
    <>
      <SideHeader title="Source Control">
        {ide.branch && (
          <span className="scm-branch" title="Branch">
            <Branch size={13} /> {ide.branch}
          </span>
        )}
      </SideHeader>
      <div className="side-scroll">
        <div className="side-section">
          <div className="side-section-title">
            Changes <span className="count">{ide.changes.length}</span>
          </div>
          {ide.changes.length === 0 && <p className="side-empty small">No changes since the last commit.</p>}
          {ide.changes.map((f) => (
            <button key={f.key} className="list-row" onClick={() => seek(f.last)} title={f.path} data-path={f.path}>
              <FileIcon name={baseName(f.path)} />
              <span className="ellipsis">{baseName(f.path)}</span>
              <span className="list-dim ellipsis">{dirOf(f.rel ?? f.path)}</span>
              <span className={`tree-status st-${f.status}`}>{f.status}</span>
            </button>
          ))}
        </div>
        <div className="side-section">
          <div className="side-section-title">
            Git activity
            {ide.ahead > 0 && <span className="count" title="Commits not pushed yet">↑{ide.ahead}</span>}
          </div>
          {ide.git.length === 0 && <p className="side-empty small">Commits, pushes, pulls and branch changes show here.</p>}
          <div className="graph">
            {[...ide.git].reverse().map((i) => (
              <GitRow key={i} step={steps[i]} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function GitRow({ step }: { step: Step }) {
  const g = step.git!;
  const icon = g.primary === "push" ? <ArrowUp size={13} /> : g.primary === "pull" || g.primary === "fetch" ? <ArrowDown size={13} /> : g.primary === "commit" ? <Commit size={13} /> : <Branch size={13} />;
  let title = g.ops.filter((o, k, a) => a.indexOf(o) === k).join(" · ");
  let sub = step.sub ?? "";
  if (g.primary === "commit") {
    title = g.message ?? "commit";
    sub = [g.hash, g.ops.includes("push") ? "pushed" : null].filter(Boolean).join(" · ");
  } else if (g.primary === "push") {
    title = `Push${g.remote ? ` → ${g.remote}` : ""}`;
    sub = g.range ?? "";
  } else if (g.primary === "pull") {
    title = "Pull";
    sub = g.range ?? "";
  }
  return (
    <button className={`git-row p-${g.primary} ${step.state}`} onClick={() => seek(step.i)} title={step.label}>
      <span className="git-node">{icon}</span>
      <span className="git-text">
        <span className="git-title ellipsis">{title}</span>
        <span className="git-sub ellipsis mono">{sub || step.label}</span>
      </span>
      <span className="list-meta">{step.state === "run" ? <span className="spinner" /> : step.state === "err" ? "failed" : clock(step.ts)}</span>
    </button>
  );
}

// ---------- Tasks ----------

function TasksView({ ide }: { ide: Ide }) {
  const tasks = ide.tasks ?? [];
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <>
      <SideHeader title="Tasks">{tasks.length > 0 && <span className="side-counts">{done}/{tasks.length}</span>}</SideHeader>
      <div className="side-scroll">
        {tasks.length === 0 && <p className="side-empty">Claude's task list shows here when it keeps one.</p>}
        {tasks.length > 0 && (
          <div className="task-progress">
            <span style={{ transform: `scaleX(${done / tasks.length})` }} />
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className={`task ${t.status}`}>
            <span className="task-box">{t.status === "completed" ? "✓" : t.status === "in_progress" ? <span className="spinner" /> : ""}</span>
            <span className="task-text">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Agents ----------

function AgentsView({ ide, head, steps }: { ide: Ide; head: Head | null; steps: Step[] }) {
  const agents = head?.agents ?? [];
  const cursor = ide.current?.i ?? -1;
  // Each agent in the order it started, except that a workflow's agents are listed together
  // under their run, where its first one started.
  const items: ({ n: number } | { run: string; step: number | null; ns: number[] })[] = [];
  const runs = new Map<string, number[]>();
  agents.forEach((a, k) => {
    if (!a.run) return void items.push({ n: k + 1 });
    let ns = runs.get(a.run);
    if (!ns) {
      runs.set(a.run, (ns = []));
      items.push({ run: a.run, step: a.step, ns });
    }
    ns.push(k + 1);
  });
  return (
    <>
      <SideHeader title="Subagents" />
      <div className="side-scroll">
        {agents.length === 0 && <p className="side-empty">Subagents Claude starts show here, with what each is doing.</p>}
        {items.map((it) =>
          "n" in it ? (
            <AgentCard key={agents[it.n - 1].id} ide={ide} head={head} steps={steps} cursor={cursor} n={it.n} />
          ) : (
            <WorkflowGroup key={it.run} ide={ide} head={head} steps={steps} cursor={cursor} step={it.step} ns={it.ns} />
          ),
        )}
      </div>
    </>
  );
}

/** A workflow run's agents, under the run's name and progress, with a divider per phase. */
function WorkflowGroup({ ide, head, steps, cursor, step, ns }: { ide: Ide; head: Head | null; steps: Step[]; cursor: number; step: number | null; ns: number[] }) {
  const s = step != null ? steps[step] : undefined;
  // Not launched yet at the cursor (replaying the past): nothing to show.
  if (s && s.i > cursor) return null;
  const run = s ? workflowProgress(steps, cursor, head, s) : null;
  if (run && run.started === 0 && run.state !== "starting") return null;
  const busy = run?.state === "running" || run?.state === "starting";
  let phase: string | null | undefined;
  return (
    <div className="side-section workflow-group">
      <button className="side-section-title workflow-title" onClick={() => s && seek(s.i)} title={s?.sub ?? "Workflow"}>
        <span className="ellipsis">Workflow · {s?.label ?? "run"}</span>
        <span className="side-header-fill" />
        {run && run.started > 0 && <span className="count">{run.done}/{run.started}</span>}
        {busy ? <span className="spinner" /> : run && run.state !== "completed" && <span className="o-err">{run.state}</span>}
      </button>
      {ns.map((n) => {
        const a = head?.agents[n - 1];
        const p = agentProgress(steps, cursor, head, n);
        if (!a || !p.started) return null;
        const divider = a.phase !== phase && a.phase ? <div className="workflow-phase">{a.phase}</div> : null;
        phase = a.phase;
        return (
          <div key={a.id}>
            {divider}
            <AgentCard ide={ide} head={head} steps={steps} cursor={cursor} n={n} />
          </div>
        );
      })}
    </div>
  );
}

function AgentCard({ ide, head, steps, cursor, n }: { ide: Ide; head: Head | null; steps: Step[]; cursor: number; n: number }) {
  const a = head?.agents[n - 1];
  const p = agentProgress(steps, cursor, head, n);
  if (!a || !p.started) return null;
  const { count, last } = p;
  const running = p.state === "running" || p.state === "starting";
  return (
    <button
      className={`agent-card${ide.watch === n ? " watched" : ""}`}
      onClick={() => setWatch(ide.watch === n ? 0 : n)}
      title={ide.watch === n ? "Back to Claude's screen" : "Watch this agent's screen"}
      style={{ ["--hue" as string]: agentHue(n) }}
    >
      <div className="agent-card-head">
        <span className="agent-pip" />
        <span className="agent-card-name ellipsis">{agentName(head, n)}</span>
        {running ? (
          <span className="agent-state">
            {p.state === "starting" && "starting "}
            <span className="spinner" />
          </span>
        ) : (
          <span className="list-meta">{p.state === "stopped" ? "stopped" : "done"}</span>
        )}
      </div>
      <div className="agent-card-sub">
        {/* A workflow agent's phase is its group's divider. */}
        {a.run ? "" : `${agentKind(head, n)} · `}
        {count} step{count === 1 ? "" : "s"}
        {p.later > 0 && <span className="dim"> · {p.later} more later</span>}
      </div>
      {last && <div className="agent-card-last ellipsis">{last.kind === "tool" ? `${last.tool}: ${last.label}` : last.label}</div>}
    </button>
  );
}
