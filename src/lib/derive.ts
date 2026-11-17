import type { Head, Step, TaskItem } from "./types";
import { baseName, pathKey, relativeTo, shortTool } from "./format";

/**
 * The IDE as it stood at a step: which files Claude had touched, which tabs were open, the
 * terminals' history, git activity, the task list. Rebuilt from the light step summaries each
 * time the cursor moves (a few thousand steps take well under a millisecond), so seeking
 * anywhere is instant and replay is exact.
 */

export type FileStatus = "R" | "M" | "A";

export interface FileMark {
  key: string;
  path: string;
  /** Relative to the session folder, or null when outside it. */
  rel: string | null;
  status: FileStatus;
  /** The last step that touched it. */
  last: number;
  /** Edits and writes to it. */
  changes: number;
}

export interface Tab {
  id: string;
  kind: "file" | "output";
  title: string;
  path: string | null;
  /** The step whose content the tab shows. */
  step: number;
  agent: number;
}

export type Focus = "editor" | "terminal" | "search" | "git" | "chat" | "tasks" | "agents";

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
        const prev = files.get(key);
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
      case "web":
      case "mcp":
      case "other":
      case "skill":
      case "ask": {
        const name = s.cat === "web" ? (s.tool ?? "Web") : shortTool(s.tool);
        openTab({ id: "o:" + (s.tool ?? s.cat), kind: "output", title: name, path: null, step: i, agent: s.agent });
        focus = "editor";
        break;
      }
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
  };
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
