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

export type Focus = "editor" | "terminal" | "search" | "git" | "chat" | "tasks" | "agents" | "network" | "ask" | "palette";

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
}

const MAX_TABS = 9;

export function derive(steps: Step[], cursor: number, head: Head | null): Ide {
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

  const openTab = (t: Tab) => {
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
    if (s.kind !== "tool") {
      focus = "chat";
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
        openTab({ id: "f:" + key, kind: "file", title: baseName(s.path), path: s.path, step: i, agent: s.agent });
        focus = "editor";
        break;
      }
      case "shell":
      case "git": {
        const list = shells.get(s.agent) ?? [];
        list.push(i);
        shells.set(s.agent, list);
        activeShell = s.agent;
        focus = "terminal";
        // Files the command wrote or deleted (a failed command changed nothing we can trust).
        if (s.files && s.state !== "err") {
          for (const f of s.files) {
            const key = pathKey(f.path);
            const prev = files.get(key);
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
          focus = "git";
        }
        break;
      }
      case "search":
        searches.push(i);
        focus = "search";
        break;
      case "task":
        if (s.tasks) tasks = s.tasks;
        focus = "tasks";
        break;
      case "agent":
        focus = "agents";
        break;
      case "web": {
        // A browser tab per site (searches share one), as a developer would open them.
        network.push(i);
        const host = s.tool === "WebSearch" ? "search" : hostOf(s.label);
        openTab({ id: "w:" + host, kind: "browser", title: s.tool === "WebSearch" ? "Search" : host, path: null, step: i, agent: s.agent });
        focus = "editor";
        break;
      }
      case "ask":
        focus = "ask";
        break;
      case "skill":
      case "mcp":
      case "other":
        if (isPaletteStep(s)) focus = "palette";
        else {
          network.push(i);
          focus = "network";
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
    if (s.kind !== "tool" || s.bg) continue;
    if (s.state === "run" || (s.end !== null && s.end > curTs && i !== end)) running.push(s);
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
  const started = count > 0 || (a?.step != null && a.step <= cursor);
  const live = !!head && head.status !== "ended";
  const working = later > 0 || (!a?.finished && live);
  const state = working ? (count === 0 ? "starting" : "running") : a?.finished || later === 0 && live ? "done" : "stopped";
  return { started, count, last, later, state };
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
