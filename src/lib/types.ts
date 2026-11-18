// What Rust sends (src-tauri/src/timeline.rs, viewer.rs, sessions.rs). `None` arrives as null.

export interface GitInfo {
  ops: string[];
  primary: string;
  message: string | null;
  hash: string | null;
  branch: string | null;
  remote: string | null;
  range: string | null;
}

export interface TaskItem {
  id: string;
  subject: string;
  activeForm: string | null;
  status: string;
}

export type StepKind = "prompt" | "say" | "tool" | "interrupt" | "compact";
export type StepCat =
  | ""
  | "read"
  | "edit"
  | "write"
  | "shell"
  | "git"
  | "search"
  | "web"
  | "agent"
  | "task"
  | "ask"
  | "skill"
  | "mcp"
  | "other";

export interface Step {
  i: number;
  v: number;
  ts: number;
  end: number | null;
  agent: number;
  kind: StepKind;
  cat: StepCat;
  tool: string | null;
  label: string;
  sub: string | null;
  text: string | null;
  path: string | null;
  state: "run" | "ok" | "err";
  turn: number;
  git: GitInfo | null;
  tasks: TaskItem[] | null;
  bg: boolean;
  delta: [number, number] | null;
  created: boolean;
  /** Response size in bytes (MCP, web and other tools). */
  size: number | null;
  /** Files a shell command wrote, copied, moved or deleted (absent when none). */
  files?: { path: string; op: ShellOp; hasContent: boolean; line?: number }[];
}

export type ShellOp = "write" | "append" | "edit" | "touch" | "delete" | "read";

export interface Meta {
  aiTitle: string | null;
  customTitle: string | null;
  branch: string | null;
  model: string | null;
  cwd: string | null;
  version: string | null;
  permissionMode: string | null;
  contextTokens: number;
  outputTokens: number;
  firstEvent: number | null;
  lastEvent: number | null;
  turnStarted: number | null;
  turnEnded: number | null;
  lastBlock: "thinking" | "text" | "tool" | null;
}

export interface AgentInfo {
  id: string;
  description: string | null;
  kind: string | null;
  finished: boolean;
  step: number | null;
}

export type SessionStatus = "working" | "waiting" | "idle" | "active" | "ended";

export interface Head {
  id: string;
  path: string;
  title: string | null;
  meta: Meta;
  status: SessionStatus;
  waitingFor: string | null;
  name: string | null;
  pid: number | null;
  agents: AgentInfo[];
  steps: number;
}

export interface SessionEntry {
  id: string;
  path: string;
  cwd: string | null;
  folder: string;
  title: string | null;
  lastPrompt: string | null;
  branch: string | null;
  modified: number;
  size: number;
  live: boolean;
  status: string | null;
  waitingFor: string | null;
  name: string | null;
}

export interface Image {
  mediaType: string;
  data: string;
}

export interface EditSpec {
  old: string;
  new: string;
  replaceAll: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A step's detail; which fields are set depends on `kind`. */
export interface Detail {
  kind: "read" | "edit" | "shell" | "search" | "web" | "agent" | "task" | "ask" | "generic";
  path?: string;
  // read
  content?: string;
  startLine?: number;
  totalLines?: number | null;
  image?: Image;
  // edit / write
  write?: boolean;
  before?: string | null;
  after?: string | null;
  edits?: EditSpec[];
  patch?: Hunk[];
  created?: boolean;
  // shell
  shell?: "bash" | "powershell";
  command?: string;
  description?: string | null;
  cwd?: string | null;
  background?: boolean;
  stdout?: string | null;
  stderr?: string | null;
  output?: string | null;
  interrupted?: boolean | null;
  taskId?: string | null;
  isError?: boolean;
  files?: { path: string; op: ShellOp; content: string | null; line?: number | null }[];
  // search / web / agent / generic
  tool?: string;
  pattern?: string | null;
  glob?: string | null;
  mode?: string | null;
  numFiles?: number | null;
  url?: string | null;
  query?: string | null;
  prompt?: string | null;
  subagentType?: string | null;
  agentId?: string;
  input?: unknown;
  bytes?: number;
  /** A web fetch that came back as an HTTP error. */
  httpStatus?: number;
  questions?: { question: string; header?: string; options?: { label: string; description?: string }[] }[];
  answers?: Record<string, string> | null;
  error?: string;
}
