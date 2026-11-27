import type { Head, Step, TaskItem } from "./types";
import { baseName, pathKey, relativeTo } from "./format";

/**
 * The IDE as it stood at a step: which files Claude had touched, which tabs were open, the
 * terminals' history, git activity, the task list. Rebuilt from the light step summaries each
 * time the cursor moves (a few thousand steps take well under a millisecond), so seeking
 * anywhere is instant and replay is exact.
 */

export type FileStatus = "R" | "M" | "A" | "D";

export interface FileMark {
  key: string;
  path: string;
  /** Relative to the session folder, or null when outside it. */
  rel: string | null;
  status: FileStatus;
  /** The last step that touched it. */
  last: number;
  /** Changed from the terminal (its content may not be known). */
  viaShell: boolean;
  /** Edits and writes to it. */
  changes: number;
}

export interface Tab {
  id: string;
  kind: "file" | "browser";
  title: string;
  path: string | null;
  /** The step whose content the tab shows. */
  step: number;
  agent: number;
}

export type Focus = "editor" | "terminal" | "search" | "git" | "chat" | "tasks" | "agents" | "network" | "ask" | "palette" | "advisor";

/** Tools shown as a command run from the palette (a moment at the top of the editor). */
export function isPaletteStep(s: Step): boolean {
  return s.kind === "tool" && (s.cat === "skill" || s.tool === "ToolSearch");
}

/** Calls listed in the Network panel: every MCP tool, the web, and Claude's other tools. */
export function isNetworkStep(s: Step): boolean {
  return s.kind === "tool" && (s.cat === "mcp" || s.cat === "web" || s.cat === "other") && !isPaletteStep(s);
}

export interface Ide {
  current: Step | null;
  files: Map<string, FileMark>;
  tabs: Tab[];
  activeTab: string | null;
  /** Shell steps per terminal (0: Claude; n: subagent n), oldest first. */
  shells: Map<number, number[]>;
  activeShell: number;
  searches: number[];
  /** Git steps that change something, oldest first. */
  git: number[];
  /** Files edited or written since the last commit. */
  changes: FileMark[];
  /** Commits not pushed yet. */
  ahead: number;
  branch: string | null;
  tasks: TaskItem[] | null;
  focus: Focus;
  /** Tool calls still running at the cursor (no result yet, or a result later than the cursor). */
  running: Step[];
  /** Subagents started so far (1-based numbers). */
  agentsStarted: Set<number>;
  /** Network panel calls up to the cursor, oldest first. */
  network: number[];
  /** Whose screen the view shows: 0 the main session, n subagent n. */
  watch: number;
  /** The watched one's latest step at the cursor (what "its screen" is on). */
  watchCurrent: Step | null;
  /**
   * Everyone else at work at the cursor, as collaborators in a shared workspace: the main session
   * (when watching an agent) and every running subagent, with the file each is on, if any.
   */
  presence: Presence[];
}

export interface Presence {
  agent: number;
  /** Its latest step at the cursor. */
  last: Step | null;
  /** The file it's on (its latest file step, read or changed), and that step. */
  file: { key: string; path: string; step: number; ref: Step } | null;
  state: "starting" | "running";
}

const MAX_TABS = 9;

export function derive(steps: Step[], cursor: number, head: Head | null, watch = 0): Ide {
  const cwd = head?.meta.cwd ?? null;
  const files = new Map<string, FileMark>();
  const tabs: Tab[] = [];
  const shells = new Map<number, number[]>();
  const searches: number[] = [];
  const git: number[] = [];
  let changes = new Map<string, FileMark>();
  let ahead = 0;
  let branch = head?.meta.branch ?? null;
  let tasks: TaskItem[] | null = null;
  let activeTab: string | null = null;
  let activeShell = 0;
  let focus: Focus = "chat";
  const agentsStarted = new Set<number>();
  const network: number[] = [];
  const end = Math.min(cursor, steps.length - 1);
  // Each one's latest file step, for presence.
  const onFile = new Map<number, { key: string; path: string; step: number; ref: Step }>();
  let watchCurrent: Step | null = null;

  const openTabFor = (t: Tab) => {
    const at = tabs.findIndex((x) => x.id === t.id);
    if (at >= 0) tabs[at] = t;
    else {
      tabs.push(t);
      if (tabs.length > MAX_TABS) {
        // Close the least recently shown tab, as a developer tidying up would.
        let oldest = 0;
        for (let k = 1; k < tabs.length; k++) if (tabs[k].step < tabs[oldest].step) oldest = k;
        tabs.splice(oldest, 1);
      }
    }
    activeTab = t.id;
  };

  for (let i = 0; i <= end; i++) {
    const s = steps[i];
    if (s.agent > 0) agentsStarted.add(s.agent);
    const mine = s.agent === watch;
    if (mine) watchCurrent = s;
    // Only the watched one's steps open tabs, choose the terminal or move the focus: the others
    // are collaborators, shown as presence, never pulling the view to their work.
    const openTab = mine ? openTabFor : () => {};
    if (s.kind !== "tool") {
      if (mine) focus = "chat";
      continue;
    }
    switch (s.cat) {
      case "read":
      case "edit":
      case "write": {
        if (!s.path) break;
        const key = pathKey(s.path);
        // A file deleted earlier and touched again starts over.
        const prev = files.get(key)?.status === "D" ? undefined : files.get(key);
        const touched = s.cat !== "read" && s.state !== "err";
        const status: FileStatus =
          s.cat === "read"
            ? (prev?.status ?? "R")
            : s.created || prev?.status === "A"
              ? "A"
              : s.state === "err"
                ? (prev?.status ?? "R")
                : "M";
        const mark: FileMark = {
          key,
          path: s.path,
          rel: relativeTo(s.path, cwd),
          status,
          last: i,
          changes: (prev?.changes ?? 0) + (touched ? 1 : 0),
          viaShell: false,
        };
        files.set(key, mark);
        if (touched) changes.set(key, mark);
        onFile.set(s.agent, { key, path: s.path, step: i, ref: s });
        openTab({ id: "f:" + key, kind: "file", title: baseName(s.path), path: s.path, step: i, agent: s.agent });
        if (mine) focus = "editor";
        break;
      }
      case "shell":
      case "git": {
        const list = shells.get(s.agent) ?? [];
        list.push(i);
        shells.set(s.agent, list);
        if (mine) {
          activeShell = s.agent;
          focus = "terminal";
        }
        // Files the command wrote or deleted (a failed command changed nothing we can trust).
        if (s.files && s.state !== "err") {
          for (const f of s.files) {
            const key = pathKey(f.path);
            const prev = files.get(key);
            if (f.op === "read") {
              // Looked at from the terminal (cat, sed -n, grep … file): read, and where its reader is.
              if (!prev || prev.status === "D") {
                files.set(key, { key, path: f.path, rel: relativeTo(f.path, cwd), status: "R", last: i, changes: 0, viaShell: true });
              }
              onFile.set(s.agent, { key, path: f.path, step: i, ref: s });
              // A command that only read it (sed -n, cat, head): the file opens at those lines,
              // as on the screen of someone reading it.
              if (f.exact && s.state === "ok") {
                openTab({ id: "f:" + key, kind: "file", title: baseName(f.path), path: f.path, step: i, agent: s.agent });
                if (mine) focus = "editor";
              }
              continue;
            }
            if (f.op === "delete" && prev?.status === "A") {
              // Created and deleted within the session: as if it never was (git agrees).
              files.delete(key);
              changes.delete(key);
              const at = tabs.findIndex((t) => t.id === "f:" + key);
              if (at >= 0) tabs.splice(at, 1);
              continue;
            }
            const fresh = !prev || prev.status === "A" || prev.status === "D";
            const status: FileStatus =
              f.op === "delete" ? "D" : f.op === "write" || f.op === "touch" ? (fresh ? "A" : "M") : prev?.status === "A" ? "A" : "M";
            const mark: FileMark = {
              key,
              path: f.path,
              rel: relativeTo(f.path, cwd),
              status,
              last: i,
              changes: (prev?.changes ?? 0) + 1,
              viaShell: true,
            };
            files.set(key, mark);
            changes.set(key, mark);
            if (f.op === "delete") {
              // Its tab closes, as an editor's does when the file goes away.
              const at = tabs.findIndex((t) => t.id === "f:" + key);
              if (at >= 0) tabs.splice(at, 1);
            }
          }
          // Files written from the terminal with their text in the command (a heredoc, an echo)
          // open in the editor too; copies and program output only show in Explorer.
          for (const f of s.files) {
            if (f.op === "write" && f.hasContent) {
              onFile.set(s.agent, { key: pathKey(f.path), path: f.path, step: i, ref: s });
              openTab({ id: "f:" + pathKey(f.path), kind: "file", title: baseName(f.path), path: f.path, step: i, agent: s.agent });
            }
          }
          if (activeTab && !tabs.some((t) => t.id === activeTab)) activeTab = tabs[tabs.length - 1]?.id ?? null;
        }
        if (s.cat === "git" && s.git) {
          git.push(i);
          if (s.state === "ok") {
            if (s.git.ops.includes("commit")) {
              ahead++;
              changes = new Map();
            }
            if (s.git.ops.includes("push")) ahead = 0;
            if (s.git.branch) branch = s.git.branch;
          }
          if (mine) focus = "git";
        }
        break;
      }
      case "search":
        searches.push(i);
        if (mine) focus = "search";
        break;
      case "task":
        // The task list is the watched one's (an agent may keep its own).
        if (s.tasks && mine) tasks = s.tasks;
        if (mine) focus = "tasks";
        break;
      case "agent":
      case "workflow":
        if (mine) focus = "agents";
        break;
      case "web": {
        // A browser tab per site (searches share one), as a developer would open them.
        network.push(i);
        const host = s.tool === "WebSearch" ? "search" : hostOf(s.label);
        openTab({ id: "w:" + host, kind: "browser", title: s.tool === "WebSearch" ? "Search" : host, path: null, step: i, agent: s.agent });
        if (mine) focus = "editor";
        break;
      }
      case "ask":
        if (mine) focus = "ask";
        break;
      case "advisor":
        if (mine) focus = "advisor";
        break;
      case "skill":
      case "mcp":
      case "other":
        if (isPaletteStep(s)) {
          if (mine) focus = "palette";
        } else {
          network.push(i);
          if (mine) focus = "network";
        }
        break;
    }
  }

  const current = end >= 0 ? steps[end] : null;
  const curTs = current?.ts ?? 0;
  const running: Step[] = [];
  // Look back a little: anything started recently and not finished by the cursor's time.
  for (let i = end; i >= 0 && i > end - 60; i--) {
    const s = steps[i];
    if (s.kind !== "tool" || s.bg || s.agent !== watch) continue;
    if (s.state === "run" || (s.end !== null && s.end > curTs && i !== end)) running.push(s);
  }

  // Everyone else who is at work at the cursor.
  const presence: Presence[] = [];
  const live = !!head && head.status !== "ended";
  if (watch !== 0) {
    let later = false;
    for (let i = end + 1; i < steps.length && !later; i++) later = steps[i].agent === 0;
    let last: Step | null = null;
    for (let i = end; i >= 0 && !last; i--) if (steps[i].agent === 0) last = steps[i];
    if (later || live) presence.push({ agent: 0, last, file: onFile.get(0) ?? null, state: "running" });
  }
  for (let n = 1; n <= (head?.agents.length ?? 0); n++) {
    if (n === watch) continue;
    const p = agentProgress(steps, end, head, n);
    if (!p.started || (p.state !== "running" && p.state !== "starting")) continue;
    presence.push({ agent: n, last: p.last, file: onFile.get(n) ?? null, state: p.state });
  }

  return {
    current,
    files,
    tabs,
    activeTab,
    shells,
    activeShell,
    searches,
    git,
    changes: [...changes.values()],
    ahead,
    branch,
    tasks,
    focus,
    running,
    agentsStarted,
    network,
    watch,
    watchCurrent,
    presence,
  };
}

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim());
  return (m ? m[1] : url).replace(/^www\./, "").slice(0, 40) || "page";
}

export interface AgentProgress {
  /** Launched by the cursor (its Agent call is at or before it, or it has steps by then). */
  started: boolean;
  /** Its steps up to the cursor, and the last of them. */
  count: number;
  last: Step | null;
  /** Its steps after the cursor (replaying the past). */
  later: number;
  /** `starting` (launched, nothing done yet), `running`, `done`, or `stopped` (never finished:
   *  the session ended or was interrupted first). */
  state: "starting" | "running" | "done" | "stopped";
}

/**
 * Where subagent `n` stood at the cursor. An agent that does more after the cursor is running
 * there; one that hasn't finished is running while the session is live. Background agents return
 * from their Agent call at once, so that call's own state says nothing about the agent.
 */
export function agentProgress(steps: Step[], cursor: number, head: Head | null, n: number): AgentProgress {
  const a = head?.agents[n - 1];
  let count = 0;
  let later = 0;
  let last: Step | null = null;
  for (const s of steps) {
    if (s.agent !== n) continue;
    if (s.i <= cursor) {
      count++;
      last = s;
    } else later++;
  }
  // An Agent call starts its agent at once; a workflow's agents start one by one after its
  // launch, each with its first step.
  const started = count > 0 || (!a?.run && a?.step != null && a.step <= cursor);
  const live = !!head && head.status !== "ended";
  // A workflow agent that never reported is over once its run is: a stopped or failed run's
  // agents don't keep working while the session lives on.
  const runStep = a?.run && a.step != null ? steps[a.step] : undefined;
  const runOver = !!runStep && reportedBy(steps, cursor, runStep);
  const working = later > 0 || (!a?.finished && live && !runOver);
  const state = working ? (count === 0 ? "starting" : "running") : a?.finished || (later === 0 && live && !runOver) ? "done" : "stopped";
  return { started, count, last, later, state };
}

/**
 * Whether a background step (a workflow run) had reported how it ended by the cursor. Its
 * notification isn't a step of its own: at the last step, one that has arrived counts.
 */
function reportedBy(steps: Step[], cursor: number, step: Step): boolean {
  if (!step.bgStatus || step.end == null) return false;
  if (cursor >= steps.length - 1) return true;
  return step.end <= (steps[cursor]?.ts ?? 0);
}

/** What kind of agent it is, for its card: its type (`Explore`), or a workflow agent's phase. */
export function agentKind(head: Head | null, n: number): string {
  const a = head?.agents[n - 1];
  if (!a) return "agent";
  if (a.run) return a.phase ? `workflow · ${a.phase}` : "workflow";
  return a.kind ?? "agent";
}

export interface WorkflowPhase {
  title: string;
  /** Its agents started by the cursor, and how many of those had finished. */
  started: number;
  done: number;
}

export interface WorkflowProgress {
  /** Agent numbers (1-based) in the run, in the order they started. */
  agents: number[];
  phases: WorkflowPhase[];
  started: number;
  running: number;
  done: number;
  /** `starting` (launched, no agent yet), `running`, `completed`, `failed`, `killed`, or
   *  `stopped` (never reported back: the session ended first). */
  state: "starting" | "running" | "completed" | "failed" | "killed" | "stopped";
}

/**
 * Where a workflow run (its Workflow step) stood at the cursor. The run reports once, when its
 * script returns (the step's `end` and `bgStatus`); until then it's running while the session is
 * live, even between phases when none of its agents is.
 */
export function workflowProgress(steps: Step[], cursor: number, head: Head | null, step: Step): WorkflowProgress {
  const agents: number[] = [];
  const phases: WorkflowPhase[] = [];
  let started = 0;
  let running = 0;
  let done = 0;
  head?.agents.forEach((a, k) => {
    if (a.step !== step.i || !a.run) return;
    const n = k + 1;
    agents.push(n);
    const p = agentProgress(steps, cursor, head, n);
    if (!p.started) return;
    started++;
    // Stopped agents (their run ended first) are neither done nor working.
    if (p.state === "done") done++;
    else if (p.state !== "stopped") running++;
    const title = a.phase ?? "";
    let ph = phases.find((x) => x.title === title);
    if (!ph) phases.push((ph = { title, started: 0, done: 0 }));
    ph.started++;
    if (p.state === "done") ph.done++;
  });
  const reported = reportedBy(steps, cursor, step);
  const live = !!head && head.status !== "ended";
  let state: WorkflowProgress["state"];
  if (reported) state = step.bgStatus === "failed" || step.bgStatus === "killed" || step.bgStatus === "stopped" ? step.bgStatus : "completed";
  else if (running > 0 || live || cursor < steps.length - 1) state = started === 0 ? "starting" : "running";
  else state = "stopped";
  return { agents, phases, started, running, done, state };
}

/** The agent's display name: "Explore · Find the parser". */
export function agentName(head: Head | null, n: number): string {
  if (n === 0) return "Claude";
  const a = head?.agents[n - 1];
  if (!a) return `Agent ${n}`;
  return a.description || a.kind || `Agent ${n}`;
}

/** A colour index per subagent, stable for the session. */
export function agentHue(n: number): number {
  return (n * 67 + 200) % 360;
}
