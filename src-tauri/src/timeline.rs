//! A Claude Code transcript (`<sessionId>.jsonl`, plus each subagent's) turned into the steps a
//! developer would see in an IDE: prompts, replies, file reads and edits, shell commands, searches,
//! git operations.
//!
//! Each step has a light summary ([`Step`], sent to the UI in full) and a detail (file contents,
//! command output) the UI fetches when it shows that step. File contents are rebuilt as the
//! transcript goes: a `Read` gives a file's text, an `Edit` applied to it gives the text after,
//! and the `originalFile` Claude Code logs with each edit's result corrects anything missed.
//!
//! Lines arrive through [`Timeline::ingest`] in the order the session wrote them (the viewer
//! merges the main transcript and subagents' by time). A step can change after it's added: a
//! tool's result arrives on a later line. Such steps are listed by [`Timeline::take_dirty`].

use crate::git::{self, GitInfo};
use crate::shell_files::{self, FileOp};
use crate::time::parse_iso_ms;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::collections::HashMap;

/// Text kept per output field (command output, tool results).
const TEXT_CAP: usize = 256 * 1024;
/// File contents kept per file.
const FILE_CAP: usize = 4 * 1024 * 1024;
/// Prompt and reply text carried in the step summary itself.
const SAY_CAP: usize = 48 * 1024;
/// Images (screenshots Claude reads) kept, base64.
const IMAGE_CAP: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub subject: String,
    pub active_form: Option<String>,
    /// `pending`, `in_progress`, `completed`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Position in the timeline.
    pub i: u32,
    /// Bumped each time the step changes (its result arrived), so the UI refetches its detail.
    pub v: u32,
    pub ts: i64,
    /// When its result arrived (tools).
    pub end: Option<i64>,
    /// 0: the main session; n: the n-th subagent (1-based) in the viewer's agent list.
    pub agent: u16,
    /// `prompt` (you), `say` (Claude's words), `tool`, `interrupt`, `compact`.
    pub kind: &'static str,
    /// For tools: `read`, `edit`, `write`, `shell`, `git`, `search`, `web`, `agent`, `task`,
    /// `ask`, `skill`, `mcp`, `other`.
    pub cat: &'static str,
    pub tool: Option<String>,
    /// One line for lists: the command, the file name, the search pattern, the first line said.
    pub label: String,
    /// Secondary: a command's description, a search's folder.
    pub sub: Option<String>,
    /// Prompts and replies, whole (up to [`SAY_CAP`]).
    pub text: Option<String>,
    /// The file a file tool works on, as Claude wrote it.
    pub path: Option<String>,
    /// `run` (no result yet), `ok`, `err`.
    pub state: &'static str,
    /// Your prompts so far (main session), so the UI can jump turn by turn.
    pub turn: u32,
    pub git: Option<GitInfo>,
    /// The task list after this step, for steps that change it.
    pub tasks: Option<Vec<TaskItem>>,
    /// Started with `run_in_background`.
    pub bg: bool,
    /// Lines added and removed, for edits and writes.
    pub delta: Option<[u32; 2]>,
    /// A write that created the file.
    pub created: bool,
    /// The size of a tool's response, in bytes (MCP, web and other tools; for the Network panel).
    pub size: Option<u32>,
    /// Files a shell command wrote, copied, moved or deleted.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<FileOp>,
}

/// What the session is, from its transcript.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub ai_title: Option<String>,
    pub custom_title: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub version: Option<String>,
    pub permission_mode: Option<String>,
    pub context_tokens: u64,
    pub output_tokens: u64,
    pub first_event: Option<i64>,
    pub last_event: Option<i64>,
    pub turn_started: Option<i64>,
    pub turn_ended: Option<i64>,
    /// What Claude did last: `thinking`, `text` or `tool`.
    pub last_block: Option<&'static str>,
}

#[derive(Debug, Clone)]
struct Buffer {
    text: String,
    /// The line `text` starts at (1 unless only part of the file was read).
    start: u32,
}

/// Per-transcript state the timeline needs: which step each tool call became.
#[derive(Debug, Default)]
pub struct SourceState {
    pub agent: u16,
    pub sidechain: bool,
    pub tools: HashMap<String, u32>,
    /// A subagent's first user message is the task it was given.
    seen_prompt: bool,
    /// The transcript's last reply ended its turn (`end_turn`) and nothing has started since: for
    /// a subagent, it has finished. Newer Claude Code versions don't always write `finished` in
    /// the agent's meta.json, so this is read from the transcript itself.
    pub ended: bool,
}

impl SourceState {
    pub fn new(agent: u16, sidechain: bool) -> Self {
        SourceState {
            agent,
            sidechain,
            ..Default::default()
        }
    }
}

#[derive(Default)]
pub struct Timeline {
    pub steps: Vec<Step>,
    details: Vec<Value>,
    files: HashMap<String, Buffer>,
    pub meta: Meta,
    tasks: Vec<TaskItem>,
    turn: u32,
    /// Steps changed since the last [`take_dirty`](Self::take_dirty).
    dirty: Vec<u32>,
    /// Subagent ids (from Agent results) → the step that started them.
    pub agent_steps: HashMap<String, u32>,
}

// ---------- the line format (only what's read) ----------

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
    subtype: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    cwd: Option<String>,
    version: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: Option<String>,
    origin: Option<Origin>,
    #[serde(rename = "toolUseResult", borrow)]
    tool_use_result: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Origin {
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    model: Option<String>,
    content: Option<Value>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

/// The timestamp of a raw line without parsing it, for merging transcripts by time.
pub fn line_ts(line: &str) -> Option<i64> {
    let i = line.find("\"timestamp\":\"")? + 13;
    let end = line[i..].find('"')? + i;
    parse_iso_ms(&line[i..end])
}

impl Timeline {
    pub fn detail(&self, i: usize) -> Option<&Value> {
        self.details.get(i)
    }

    /// Steps that changed (not counting new ones) since the last call.
    pub fn take_dirty(&mut self) -> Vec<u32> {
        let mut d = std::mem::take(&mut self.dirty);
        d.sort_unstable();
        d.dedup();
        d
    }

    pub fn title(&self) -> Option<&str> {
        self.meta
            .custom_title
            .as_deref()
            .or(self.meta.ai_title.as_deref())
    }

    /// Takes one transcript line. Lines that aren't JSON or aren't of interest are ignored.
    pub fn ingest(&mut self, src: &mut SourceState, line: &str) {
        if line.is_empty() {
            return;
        }
        let Ok(l) = serde_json::from_str::<Line>(line) else {
            return;
        };
        let ts = l.timestamp.as_deref().and_then(parse_iso_ms);
        let main = src.agent == 0;
        match l.kind.as_deref() {
            Some("ai-title") if main => {
                if let Some(t) = l.ai_title.filter(|t| !t.trim().is_empty()) {
                    self.meta.ai_title = Some(t);
                }
                return;
            }
            Some("custom-title") if main => {
                self.meta.custom_title = l.custom_title.filter(|t| !t.trim().is_empty());
                return;
            }
            Some("permission-mode") if main => {
                self.meta.permission_mode = l.permission_mode;
                return;
            }
            Some("system") => {
                if main && l.subtype.as_deref() == Some("compact_boundary") {
                    let ts = ts.unwrap_or(0);
                    self.push(
                        src,
                        Step::new(ts, "compact", "", "Conversation compacted".into()),
                        Value::Null,
                    );
                }
                return;
            }
            Some("user") | Some("assistant") => {}
            _ => return,
        }
        if l.is_sidechain == Some(true) && !src.sidechain {
            return;
        }
        if main {
            if let Some(ts) = ts {
                self.meta.last_event = Some(ts);
                self.meta.first_event.get_or_insert(ts);
            }
            // `HEAD` is what's recorded outside a git repository (and on a detached HEAD).
            if let Some(b) = l.git_branch.filter(|b| !b.is_empty() && b != "HEAD") {
                self.meta.branch = Some(b);
            }
            // The folder the session started in is the project, whatever it `cd`s into later.
            if self.meta.cwd.is_none() && l.cwd.is_some() {
                self.meta.cwd = l.cwd.clone();
            }
            if l.version.is_some() {
                self.meta.version = l.version;
            }
        }
        let Some(msg) = l
            .message
            .and_then(|m| serde_json::from_str::<Message>(m.get()).ok())
        else {
            return;
        };
        let ts = ts.unwrap_or(0);
        if l.kind.as_deref() == Some("user") {
            let tur = l
                .tool_use_result
                .and_then(|r| serde_json::from_str::<Value>(r.get()).ok());
            let origin = l.origin.and_then(|o| o.kind);
            self.user(src, ts, msg, tur, origin.as_deref(), l.is_meta == Some(true));
        } else {
            self.assistant(src, ts, msg, l.cwd);
        }
    }

    fn push(&mut self, src: &SourceState, mut step: Step, detail: Value) -> u32 {
        let i = self.steps.len() as u32;
        step.i = i;
        step.agent = src.agent;
        step.turn = self.turn;
        self.steps.push(step);
        self.details.push(detail);
        i
    }

    // ---------- user lines: your prompts and tool results ----------

    fn user(
        &mut self,
        src: &mut SourceState,
        ts: i64,
        msg: Message,
        tur: Option<Value>,
        origin: Option<&str>,
        is_meta: bool,
    ) {
        let Some(content) = msg.content else { return };
        match content {
            Value::String(text) => self.user_text(src, ts, &text, origin, is_meta),
            Value::Array(blocks) => {
                let results = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                    .count();
                for b in &blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            // `toolUseResult` describes the line's result when it has just one.
                            let tur = if results == 1 { tur.as_ref() } else { None };
                            self.tool_result(src, ts, b, tur);
                        }
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                if t.starts_with("[Request interrupted") {
                                    self.interrupt(src, ts, t);
                                } else if !is_meta && origin == Some("human") {
                                    self.user_text(src, ts, t, origin, is_meta);
                                    return;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn user_text(
        &mut self,
        src: &mut SourceState,
        ts: i64,
        text: &str,
        origin: Option<&str>,
        is_meta: bool,
    ) {
        if text.starts_with("[Request interrupted") {
            self.interrupt(src, ts, text);
            return;
        }
        if src.agent != 0 {
            // A subagent's first message is its task; anything after is the session talking to it.
            if !src.seen_prompt {
                src.seen_prompt = true;
                let mut s = Step::new(ts, "prompt", "", one_line(text, 200));
                s.text = Some(truncate(text, SAY_CAP));
                self.push(src, s, Value::Null);
            }
            return;
        }
        let human = match origin {
            Some(kind) => kind == "human",
            None => {
                !is_meta
                    && (!text.starts_with('<') || text.contains("<command-name>"))
                    && !text.starts_with("This session is being continued")
            }
        };
        if !human {
            return;
        }
        // A slash command is logged as tags: show it the way it was typed.
        let shown = match between(text, "<command-name>", "</command-name>") {
            Some(name) => {
                let args = between(text, "<command-args>", "</command-args>").unwrap_or("");
                let name = if name.starts_with('/') {
                    name.to_string()
                } else {
                    format!("/{name}")
                };
                format!("{name} {args}").trim().to_string()
            }
            None => text.to_string(),
        };
        self.turn += 1;
        self.meta.turn_started = Some(ts);
        self.meta.turn_ended = None;
        self.meta.last_block = None;
        let mut s = Step::new(ts, "prompt", "", one_line(&shown, 200));
        s.text = Some(truncate(&shown, SAY_CAP));
        self.push(src, s, Value::Null);
    }

    fn interrupt(&mut self, src: &SourceState, ts: i64, text: &str) {
        let s = Step::new(ts, "interrupt", "", one_line(text, 120));
        self.push(src, s, Value::Null);
        // Nothing still running in this transcript will report back.
        let agent = src.agent;
        for st in self.steps.iter_mut().rev() {
            if st.kind == "prompt" && st.agent == agent {
                break;
            }
            if st.agent == agent && st.state == "run" && !st.bg {
                st.state = "err";
                st.v += 1;
                self.dirty.push(st.i);
            }
        }
        if agent == 0 {
            self.meta.turn_ended = Some(ts);
        }
    }

    // ---------- assistant lines: what Claude says and the tools it calls ----------

    fn assistant(&mut self, src: &mut SourceState, ts: i64, msg: Message, cwd: Option<String>) {
        let main = src.agent == 0;
        if main {
            if let Some(m) = msg.model.as_ref().filter(|m| !m.starts_with('<')) {
                self.meta.model = Some(m.clone());
            }
            if let Some(u) = &msg.usage {
                self.meta.context_tokens =
                    u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
                self.meta.output_tokens += u.output_tokens;
            }
        }
        let Some(Value::Array(blocks)) = msg.content else {
            return;
        };
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("thinking") | Some("redacted_thinking") => {
                    if main {
                        self.meta.last_block = Some("thinking");
                    }
                }
                Some("text") => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                    let line = one_line(text, 200);
                    if line.is_empty() {
                        continue;
                    }
                    if main {
                        self.meta.last_block = Some("text");
                    }
                    let mut s = Step::new(ts, "say", "", line);
                    s.text = Some(truncate(text, SAY_CAP));
                    self.push(src, s, Value::Null);
                }
                Some("tool_use") => {
                    src.ended = false;
                    if main {
                        self.meta.last_block = Some("tool");
                    }
                    let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    let i = self.tool_use(src, ts, name, &input, cwd.as_deref());
                    if !id.is_empty() {
                        src.tools.insert(id, i);
                    }
                }
                _ => {}
            }
        }
        if msg.stop_reason.as_deref() == Some("end_turn") {
            src.ended = true;
            if main {
                self.meta.turn_ended = Some(ts);
            }
        }
    }

    fn tool_use(
        &mut self,
        src: &SourceState,
        ts: i64,
        name: &str,
        input: &Value,
        cwd: Option<&str>,
    ) -> u32 {
        let s = |k: &str| input.get(k).and_then(Value::as_str);
        let cat = category(name);
        let mut step = Step::new(ts, "tool", cat, tool_label(name, input));
        step.tool = Some(name.to_string());
        step.bg = input.get("run_in_background").and_then(Value::as_bool) == Some(true)
            || s("run_in_background") == Some("true");
        let detail = match cat {
            "read" => {
                let path = s("file_path").or(s("notebook_path")).unwrap_or("");
                step.path = Some(path.to_string());
                json!({ "kind": "read", "path": path })
            }
            "edit" => self.edit_use(&mut step, name, input),
            "write" => self.write_use(&mut step, input),
            "shell" => {
                let command = s("command").unwrap_or("");
                step.label = one_line(command, 200);
                step.sub = s("description").map(str::to_string);
                if let Some(g) = git::parse_command(command).filter(|g| g.notable()) {
                    step.cat = "git";
                    step.git = Some(g);
                }
                let dir = cwd.or(self.meta.cwd.as_deref()).unwrap_or("");
                step.files = shell_files::parse(command, dir);
                self.apply_shell_files(&step.files);
                json!({
                    "kind": "shell",
                    "shell": if name == "PowerShell" { "powershell" } else { "bash" },
                    "command": truncate(command, TEXT_CAP),
                    "description": s("description"),
                    "cwd": cwd,
                    "background": step.bg,
                    "files": step.files.iter().map(|f| json!({
                        "path": f.path,
                        "op": f.op,
                        "content": f.content.as_deref().map(cap_file),
                    })).collect::<Vec<_>>(),
                })
            }
            "search" => {
                step.sub = s("path").map(|p| file_name(p).to_string());
                json!({
                    "kind": "search",
                    "tool": name,
                    "pattern": s("pattern"),
                    "path": s("path"),
                    "glob": s("glob"),
                    "mode": s("output_mode"),
                })
            }
            "web" => json!({
                "kind": "web",
                "tool": name,
                "url": s("url"),
                "query": s("query"),
                "prompt": s("prompt"),
            }),
            "agent" => {
                step.sub = s("subagent_type").map(str::to_string);
                json!({
                    "kind": "agent",
                    "description": s("description"),
                    "subagentType": s("subagent_type"),
                    "prompt": s("prompt").map(|p| truncate(p, TEXT_CAP)),
                })
            }
            "task" => {
                self.track_tasks(name, input);
                step.tasks = Some(self.tasks.clone());
                json!({ "kind": "task", "tool": name, "input": input })
            }
            "ask" => json!({ "kind": "ask", "questions": input.get("questions") }),
            _ => json!({
                "kind": "generic",
                "tool": name,
                // The arguments as JSON, so the UI can show them as a tree; only a very large
                // input (a whole document being uploaded) is cut, and then sent as text.
                "input": capped_json(input, 64 * 1024),
            }),
        };
        self.push(src, step, detail)
    }

    /// What a shell command wrote becomes the known text of those files (a heredoc's body), so a
    /// later Read or Edit of them has a "before".
    fn apply_shell_files(&mut self, ops: &[FileOp]) {
        for op in ops {
            let key = path_key(&op.path);
            match (op.op, &op.content) {
                ("write", Some(c)) => {
                    self.files.insert(key, Buffer { text: cap_file(c), start: 1 });
                }
                ("append", Some(c)) => {
                    if let Some(b) = self.files.get_mut(&key).filter(|b| b.start <= 1) {
                        b.text.push_str(c);
                    }
                }
                ("delete", _) | ("write", None) | ("edit", _) => {
                    // Gone, or changed in a way the command doesn't show.
                    self.files.remove(&key);
                }
                _ => {}
            }
        }
    }

    fn edit_use(&mut self, step: &mut Step, name: &str, input: &Value) -> Value {
        let path = input
            .get("file_path")
            .or_else(|| input.get("notebook_path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        step.path = Some(path.clone());
        let edits = edits_of(name, input);
        let (mut add, mut del) = (0u32, 0u32);
        for e in &edits {
            let [a, d] = line_delta(&e.0, &e.1);
            add += a;
            del += d;
        }
        step.delta = Some([add, del]);
        let key = path_key(&path);
        let (before, after, start) = match self.files.get(&key) {
            Some(b) => match apply_edits(&b.text, &edits) {
                Some(after) => (Some(b.text.clone()), Some(after), b.start),
                None => (None, None, 1),
            },
            None => (None, None, 1),
        };
        if let Some(a) = &after {
            self.files.insert(
                key,
                Buffer {
                    text: a.clone(),
                    start,
                },
            );
        }
        json!({
            "kind": "edit",
            "path": path,
            "before": before,
            "after": after,
            "startLine": start,
            "edits": edits.iter().map(|(o, n, all)| json!({"old": o, "new": n, "replaceAll": all})).collect::<Vec<_>>(),
        })
    }

    fn write_use(&mut self, step: &mut Step, input: &Value) -> Value {
        let path = input
            .get("file_path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        step.path = Some(path.clone());
        let content = input.get("content").and_then(Value::as_str).unwrap_or("");
        let key = path_key(&path);
        let before = self
            .files
            .get(&key)
            .filter(|b| b.start <= 1)
            .map(|b| b.text.clone());
        step.delta = Some([
            count_lines(content),
            before.as_deref().map(count_lines).unwrap_or(0),
        ]);
        let after = cap_file(content);
        self.files.insert(
            key,
            Buffer {
                text: after.clone(),
                start: 1,
            },
        );
        json!({
            "kind": "edit",
            "write": true,
            "path": path,
            "before": before,
            "after": after,
            "startLine": 1,
        })
    }

    // ---------- tool results ----------

    fn tool_result(&mut self, src: &mut SourceState, ts: i64, block: &Value, tur: Option<&Value>) {
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
            return;
        };
        let Some(&i) = src.tools.get(id) else { return };
        let i = i as usize;
        let (text, image) = result_content(block.get("content"));
        // A web page that came back as an HTTP error (Claude Code doesn't flag it as one) is a
        // failed load, as a browser would show it.
        let http_error = (self.steps[i].cat == "web").then(|| http_error_status(&text)).flatten();
        let failed = block.get("is_error").and_then(Value::as_bool) == Some(true) || http_error.is_some();
        if let Some(code) = http_error {
            set(&mut self.details[i], "httpStatus", json!(code));
        }
        {
            let step = &mut self.steps[i];
            step.state = if failed { "err" } else { "ok" };
            step.end = Some(ts);
            step.v += 1;
        }
        self.dirty.push(i as u32);
        let cat = self.steps[i].cat;
        let tur = tur.filter(|t| !t.is_string() && !t.is_array());
        match cat {
            "read" => self.read_result(i, &text, image, tur, failed),
            "edit" | "write" => self.edit_result(i, &text, tur, failed),
            "shell" | "git" => {
                let get = |k: &str| tur.and_then(|t| t.get(k)).and_then(Value::as_str);
                let stdout = get("stdout").map(|s| truncate(s, TEXT_CAP));
                let stderr = get("stderr").map(|s| truncate(s, TEXT_CAP));
                if let Some(g) = self.steps[i].git.as_mut() {
                    let out = match (&stdout, &stderr) {
                        (Some(a), Some(b)) => format!("{a}\n{b}"),
                        _ => text.clone(),
                    };
                    git::read_output(g, &out);
                }
                let d = &mut self.details[i];
                set(d, "stdout", json!(stdout));
                set(d, "stderr", json!(stderr));
                if stdout.is_none() && stderr.is_none() {
                    set(d, "output", json!(truncate(&text, TEXT_CAP)));
                }
                set(
                    d,
                    "interrupted",
                    json!(tur.and_then(|t| t.get("interrupted")).and_then(Value::as_bool)),
                );
                set(d, "taskId", json!(get("backgroundTaskId")));
                set(d, "isError", json!(failed));
            }
            "agent" => {
                if let Some(agent_id) = tur.and_then(|t| t.get("agentId")).and_then(Value::as_str)
                {
                    self.agent_steps.insert(agent_id.to_string(), i as u32);
                    set(&mut self.details[i], "agentId", json!(agent_id));
                }
                set(&mut self.details[i], "output", json!(truncate(&text, TEXT_CAP)));
            }
            "search" => {
                let d = &mut self.details[i];
                set(d, "output", json!(truncate(&text, TEXT_CAP)));
                set(
                    d,
                    "numFiles",
                    json!(tur.and_then(|t| t.get("numFiles")).and_then(Value::as_u64)),
                );
            }
            "ask" => {
                set(
                    &mut self.details[i],
                    "answers",
                    tur.and_then(|t| t.get("answers")).cloned().unwrap_or(Value::Null),
                );
                set(&mut self.details[i], "output", json!(truncate(&text, TEXT_CAP)));
            }
            _ => {
                let d = &mut self.details[i];
                set(d, "output", json!(truncate(&text, TEXT_CAP)));
                // The response's real size, for the Network panel (the text kept may be cut).
                set(d, "bytes", json!(text.len()));
                self.steps[i].size = Some(text.len().min(u32::MAX as usize) as u32);
                if let Some(img) = image {
                    set(d, "image", img);
                }
            }
        }
        if failed {
            set(&mut self.details[i], "error", json!(truncate(&text, 16 * 1024)));
        }
    }

    fn read_result(
        &mut self,
        i: usize,
        text: &str,
        image: Option<Value>,
        tur: Option<&Value>,
        failed: bool,
    ) {
        let path = self.steps[i].path.clone().unwrap_or_default();
        let key = path_key(&path);
        let d = &mut self.details[i];
        if failed {
            return;
        }
        let kind = tur.and_then(|t| t.get("type")).and_then(Value::as_str);
        let file = tur.and_then(|t| t.get("file"));
        if kind == Some("image") {
            if let Some(f) = file
                && let Some(data) = f.get("base64").and_then(Value::as_str)
                && data.len() <= IMAGE_CAP
            {
                let mt = f.get("type").and_then(Value::as_str).unwrap_or("image/png");
                set(d, "image", json!({ "mediaType": mt, "data": data }));
            }
            return;
        }
        if let Some(img) = image {
            set(d, "image", img);
            return;
        }
        let (content, start, num, total) = match file.and_then(|f| f.get("content")).and_then(Value::as_str) {
            Some(c) => {
                let f = file.unwrap_or(&Value::Null);
                let n = |k: &str| f.get(k).and_then(Value::as_u64).map(|v| v as u32);
                (c.to_string(), n("startLine").unwrap_or(1), n("numLines"), n("totalLines"))
            }
            None => {
                if kind.is_some_and(|k| k != "text") {
                    // A PDF, a notebook, "unchanged since last read": show what the result says,
                    // or the text already known.
                    match self.files.get(&key) {
                        Some(b) => (b.text.clone(), b.start, None, None),
                        None => (text.to_string(), 1, None, None),
                    }
                } else {
                    let (c, start) = strip_line_numbers(text);
                    (c, start, None, None)
                }
            }
        };
        let content = cap_file(&content);
        let lines = count_lines(&content);
        let whole = start <= 1 && total.is_none_or(|t| num.unwrap_or(lines) >= t);
        set(d, "content", json!(content));
        set(d, "startLine", json!(start));
        set(d, "totalLines", json!(total));
        let known_whole = self.files.get(&key).is_some_and(|b| b.start <= 1);
        if whole || !known_whole {
            self.files.insert(
                key,
                Buffer {
                    text: content,
                    start,
                },
            );
        }
    }

    fn edit_result(&mut self, i: usize, text: &str, tur: Option<&Value>, failed: bool) {
        let path = self.steps[i].path.clone().unwrap_or_default();
        let key = path_key(&path);
        if failed {
            // The edit didn't happen: the file is as it was.
            if let Some(before) = self.details[i].get("before").and_then(Value::as_str) {
                let start = self.details[i]
                    .get("startLine")
                    .and_then(Value::as_u64)
                    .unwrap_or(1) as u32;
                self.files.insert(
                    key,
                    Buffer {
                        text: before.to_string(),
                        start,
                    },
                );
            }
            return;
        }
        let _ = text;
        let Some(t) = tur else { return };
        let is_write = self.details[i].get("write").is_some();
        if let Some(patch) = t.get("structuredPatch").filter(|p| p.is_array()) {
            set(&mut self.details[i], "patch", patch.clone());
        }
        if t.get("type").and_then(Value::as_str) == Some("create") {
            set(&mut self.details[i], "created", json!(true));
            set(&mut self.details[i], "before", json!(""));
            if let Some(s) = self.steps.get_mut(i) {
                s.delta = s.delta.map(|[a, _]| [a, 0]);
                s.created = true;
            }
        }
        // The file as it was before the edit, logged by Claude Code: the authoritative "before".
        let Some(orig) = t.get("originalFile").and_then(Value::as_str) else {
            return;
        };
        let orig = cap_file(orig);
        let after = if is_write {
            self.details[i]
                .get("after")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            let edits: Vec<(String, String, bool)> = self.details[i]
                .get("edits")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|e| {
                            (
                                e.get("old").and_then(Value::as_str).unwrap_or("").to_string(),
                                e.get("new").and_then(Value::as_str).unwrap_or("").to_string(),
                                e.get("replaceAll").and_then(Value::as_bool).unwrap_or(false),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            apply_edits(&orig, &edits)
        };
        let d = &mut self.details[i];
        set(d, "before", json!(orig));
        set(d, "startLine", json!(1));
        if let Some(a) = &after {
            set(d, "after", json!(a));
            self.files.insert(
                key,
                Buffer {
                    text: a.clone(),
                    start: 1,
                },
            );
        }
        if is_write && let Some(s) = self.steps.get_mut(i) {
            s.delta = s.delta.map(|[a, _]| [a, count_lines(&orig)]);
        }
    }

    fn track_tasks(&mut self, tool: &str, input: &Value) {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        match tool {
            "TodoWrite" => {
                if let Some(todos) = input.get("todos").and_then(Value::as_array) {
                    self.tasks = todos
                        .iter()
                        .enumerate()
                        .map(|(i, t)| TaskItem {
                            id: (i + 1).to_string(),
                            subject: s(t, "content").unwrap_or_default(),
                            active_form: s(t, "activeForm"),
                            status: s(t, "status").unwrap_or_else(|| "pending".into()),
                        })
                        .collect();
                }
            }
            "TaskCreate" => {
                if let Some(subject) = s(input, "subject") {
                    let id = (self.tasks.len() + 1).to_string();
                    self.tasks.push(TaskItem {
                        id,
                        subject,
                        active_form: s(input, "activeForm"),
                        status: "pending".into(),
                    });
                }
            }
            "TaskUpdate" => {
                let id = match input.get("taskId") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => return,
                };
                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == id) {
                    if let Some(v) = s(input, "status") {
                        t.status = v;
                    }
                    if let Some(v) = s(input, "subject") {
                        t.subject = v;
                    }
                    if let Some(v) = s(input, "activeForm") {
                        t.active_form = Some(v);
                    }
                }
                self.tasks.retain(|t| t.status != "deleted");
            }
            _ => {}
        }
    }
}

impl Step {
    fn new(ts: i64, kind: &'static str, cat: &'static str, label: String) -> Step {
        Step {
            i: 0,
            v: 0,
            ts,
            end: None,
            agent: 0,
            kind,
            cat,
            tool: None,
            label,
            sub: None,
            text: None,
            path: None,
            state: if kind == "tool" { "run" } else { "ok" },
            turn: 0,
            git: None,
            tasks: None,
            bg: false,
            delta: None,
            created: false,
            size: None,
            files: Vec::new(),
        }
    }
}

// ---------- helpers ----------

fn set(v: &mut Value, k: &str, val: Value) {
    if let Value::Object(m) = v {
        m.insert(k.to_string(), val);
    } else {
        let mut m = Map::new();
        m.insert(k.to_string(), val);
        *v = Value::Object(m);
    }
}

pub fn category(name: &str) -> &'static str {
    match name {
        "Read" => "read",
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit",
        "Write" => "write",
        "Bash" | "PowerShell" => "shell",
        "Grep" | "Glob" => "search",
        "WebFetch" | "WebSearch" => "web",
        "Agent" | "Task" => "agent",
        "TodoWrite" | "TaskCreate" | "TaskUpdate" => "task",
        "AskUserQuestion" => "ask",
        "Skill" => "skill",
        n if n.starts_with("mcp__") => "mcp",
        _ => "other",
    }
}

/// (old, new, replace all) for Edit and MultiEdit.
fn edits_of(name: &str, input: &Value) -> Vec<(String, String, bool)> {
    let one = |e: &Value| {
        (
            e.get("old_string").and_then(Value::as_str).unwrap_or("").to_string(),
            e.get("new_string")
                .or_else(|| e.get("new_source"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            e.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
        )
    };
    if name == "MultiEdit" {
        input
            .get("edits")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(one).collect())
            .unwrap_or_default()
    } else {
        vec![one(input)]
    }
}

/// Applies edits as Claude Code does (first occurrence, or all), allowing for a file with CRLF
/// line ends when the edit was written with LF. `None` if an edit doesn't match.
fn apply_edits(base: &str, edits: &[(String, String, bool)]) -> Option<String> {
    let mut s = base.to_string();
    for (old, new, all) in edits {
        if old.is_empty() {
            if s.is_empty() {
                s = new.clone();
                continue;
            }
            return None;
        }
        let (o, n) = if s.contains(old.as_str()) {
            (old.clone(), new.clone())
        } else if s.contains("\r\n") && !old.contains('\r') {
            (old.replace('\n', "\r\n"), new.replace('\n', "\r\n"))
        } else {
            return None;
        };
        if !s.contains(o.as_str()) {
            return None;
        }
        s = if *all {
            s.replace(&o, &n)
        } else {
            s.replacen(&o, &n, 1)
        };
    }
    Some(s)
}

/// The text of a tool result (strings and text blocks joined) and its first image.
fn result_content(content: Option<&Value>) -> (String, Option<Value>) {
    match content {
        Some(Value::String(s)) => (s.clone(), None),
        Some(Value::Array(blocks)) => {
            let mut text = String::new();
            let mut image = None;
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(b.get("text").and_then(Value::as_str).unwrap_or(""));
                    }
                    Some("image") if image.is_none() => {
                        let src = b.get("source");
                        let data = src.and_then(|s| s.get("data")).and_then(Value::as_str);
                        let mt = src
                            .and_then(|s| s.get("media_type"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png");
                        if let Some(d) = data.filter(|d| d.len() <= IMAGE_CAP) {
                            image = Some(json!({ "mediaType": mt, "data": d }));
                        }
                    }
                    Some("tool_reference") => {
                        if let Some(n) = b.get("tool_name").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(n);
                        }
                    }
                    _ => {}
                }
            }
            (text, image)
        }
        _ => (String::new(), None),
    }
}

/// `Read` output as Claude sees it (`   12\tcode` or `12→code`) back to the file's text, with the
/// first line number.
fn strip_line_numbers(text: &str) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut first = None;
    let mut numbered = 0usize;
    let mut total = 0usize;
    for line in text.lines() {
        total += 1;
        let t = line.trim_start();
        let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
        let rest = &t[digits..];
        let body = rest
            .strip_prefix('\t')
            .or_else(|| rest.strip_prefix('→'));
        match (digits > 0, body) {
            (true, Some(b)) => {
                numbered += 1;
                if first.is_none() {
                    first = t[..digits].parse::<u32>().ok();
                }
                out.push_str(b);
            }
            _ => out.push_str(line),
        }
        out.push('\n');
    }
    if total == 0 || numbered * 2 < total {
        return (text.to_string(), 1);
    }
    (out, first.unwrap_or(1))
}

/// The key a file is known by: separators unified, and case-insensitive on Windows.
pub fn path_key(p: &str) -> String {
    let p = p.replace('\\', "/");
    if cfg!(windows) { p.to_lowercase() } else { p }
}

/// Lines added and removed going from `old` to `new`, ignoring lines that only moved: the
/// numbers a diff's summary shows, near enough.
fn line_delta(old: &str, new: &str) -> [u32; 2] {
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for l in old.lines() {
        *counts.entry(l.trim_end()).or_default() += 1;
    }
    let mut add = 0u32;
    for l in new.lines() {
        let c = counts.entry(l.trim_end()).or_default();
        if *c > 0 {
            *c -= 1;
        } else {
            add += 1;
        }
    }
    let del = counts.values().filter(|&&c| c > 0).sum::<i64>() as u32;
    [add, del]
}

/// The status of a fetch that failed with an HTTP error: "The server returned HTTP 503 …".
fn http_error_status(text: &str) -> Option<u16> {
    let rest = text.trim_start().strip_prefix("The server returned HTTP ")?;
    let code: u16 = rest.get(..3)?.parse().ok()?;
    (code >= 400).then_some(code)
}

/// A JSON value as is when it's small enough, else its pretty text cut to `max` bytes.
fn capped_json(v: &Value, max: usize) -> Value {
    let text = serde_json::to_string(v).unwrap_or_default();
    if text.len() <= max {
        v.clone()
    } else {
        json!(truncate(&serde_json::to_string_pretty(v).unwrap_or_default(), max))
    }
}

fn count_lines(s: &str) -> u32 {
    if s.is_empty() {
        0
    } else {
        s.lines().count() as u32
    }
}

fn cap_file(s: &str) -> String {
    truncate_bytes(s, FILE_CAP)
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)? + start.len();
    let j = s[i..].find(end)? + i;
    Some(&s[i..j])
}

/// The first non-empty line, trimmed, at most `max` characters.
pub fn one_line(s: &str, max: usize) -> String {
    let line = s
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate_chars(line, max)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// At most `max` bytes, cut on a character boundary.
fn truncate(s: &str, max: usize) -> String {
    truncate_bytes(s, max)
}

fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes not kept)", &s[..end], s.len() - end)
}

/// `mcp__clickup__clickup_get_task` → `clickup: get_task`; built-in tools keep their name.
pub fn short_tool(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let server = parts.next().unwrap_or("");
        let tool = parts.next().unwrap_or("");
        let server = server.strip_prefix("claude_ai_").unwrap_or(server);
        let tool = tool.strip_prefix(&format!("{server}_")).unwrap_or(tool);
        return format!("{server}: {tool}");
    }
    name.to_string()
}

fn file_name(p: &str) -> &str {
    p.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(p)
}

fn tool_label(name: &str, i: &Value) -> String {
    let s = |k: &str| i.get(k).and_then(Value::as_str).map(str::to_string);
    let label = match name {
        "Bash" | "PowerShell" => s("command").map(|c| one_line(&c, 200)),
        "Read" | "Write" | "Edit" | "MultiEdit" => s("file_path").map(|p| file_name(&p).to_string()),
        "NotebookEdit" => s("notebook_path").map(|p| file_name(&p).to_string()),
        "Grep" | "Glob" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Skill" => s("skill"),
        "Agent" | "Task" => s("description"),
        "TaskCreate" | "TaskUpdate" => s("subject").or_else(|| {
            let id = i.get("taskId").map(|v| v.to_string().trim_matches('"').to_string());
            match (id, s("status")) {
                (Some(id), Some(st)) => Some(format!("#{id} → {st}")),
                (_, st) => st,
            }
        }),
        "TodoWrite" => i.get("todos").and_then(Value::as_array).map(|t| {
            let done = t
                .iter()
                .filter(|t| t.get("status").and_then(Value::as_str) == Some("completed"))
                .count();
            format!("{done}/{} done", t.len())
        }),
        "AskUserQuestion" => i
            .get("questions")
            .and_then(Value::as_array)
            .map(|q| match q.first().and_then(|q| q.get("question")).and_then(Value::as_str) {
                Some(first) => one_line(first, 140),
                None => format!("{} question(s)", q.len()),
            }),
        _ => s("description")
            .or_else(|| s("query"))
            .or_else(|| s("prompt").map(|p| one_line(&p, 120)))
            .or_else(|| s("file_path").map(|p| file_name(&p).to_string()))
            .or_else(|| s("command").map(|p| one_line(&p, 120))),
    };
    let label = label.map(|l| one_line(&l, 200)).unwrap_or_default();
    if label.is_empty() {
        short_tool(name)
    } else {
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: &str, ts: &str, extra: &str, content: &str) -> String {
        format!(
            r#"{{"type":"{kind}","timestamp":"{ts}","cwd":"D:\\p","gitBranch":"main"{extra},"message":{{"role":"{kind}","model":"claude-opus-5-5","content":{content}}}}}"#
        )
    }

    fn prompt(t: &mut Timeline, src: &mut SourceState, text: &str) {
        t.ingest(
            src,
            &line(
                "user",
                "2026-11-17T10:00:00.000Z",
                r#","origin":{"kind":"human"}"#,
                &serde_json::to_string(text).unwrap(),
            ),
        );
    }

    fn tool(t: &mut Timeline, src: &mut SourceState, id: &str, name: &str, input: Value) {
        let content = json!([{ "type": "tool_use", "id": id, "name": name, "input": input }]);
        t.ingest(
            src,
            &line("assistant", "2026-11-17T10:00:01.000Z", "", &content.to_string()),
        );
    }

    fn result(t: &mut Timeline, src: &mut SourceState, id: &str, text: &str, err: bool, tur: Value) {
        let content =
            json!([{ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": err }]);
        let extra = format!(r#","toolUseResult":{}"#, tur);
        t.ingest(
            src,
            &line("user", "2026-11-17T10:00:02.000Z", &extra, &content.to_string()),
        );
    }

    #[test]
    fn read_then_edit_rebuilds_the_file() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        prompt(&mut t, &mut src, "rename it");
        tool(&mut t, &mut src, "r1", "Read", json!({"file_path": "D:\\p\\a.rs"}));
        result(
            &mut t,
            &mut src,
            "r1",
            "1\tfn old() {}\n2\t",
            false,
            json!({"type":"text","file":{"filePath":"D:\\p\\a.rs","content":"fn old() {}\n","numLines":2,"startLine":1,"totalLines":2}}),
        );
        tool(
            &mut t,
            &mut src,
            "e1",
            "Edit",
            json!({"file_path": "D:/p/a.rs", "old_string": "old", "new_string": "new"}),
        );
        let d = t.detail(2).unwrap();
        assert_eq!(d["before"], "fn old() {}\n");
        assert_eq!(d["after"], "fn new() {}\n");
        assert_eq!(t.steps[2].state, "run");
        assert_eq!(t.steps[2].delta, Some([1, 1]));
        assert_eq!(line_delta("a
b
c", "a
B
c
d"), [2, 1]);

        result(
            &mut t,
            &mut src,
            "e1",
            "updated",
            false,
            json!({"filePath":"D:/p/a.rs","oldString":"old","newString":"new","originalFile":"fn old() {}\n","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-fn old() {}","+fn new() {}"]}]}),
        );
        assert_eq!(t.steps[2].state, "ok");
        assert_eq!(t.steps[2].v, 1);
        assert_eq!(t.take_dirty(), [1, 2]);
        assert!(t.detail(2).unwrap()["patch"].is_array());

        // A second edit builds on the first.
        tool(
            &mut t,
            &mut src,
            "e2",
            "Edit",
            json!({"file_path": "D:\\p\\a.rs", "old_string": "{}", "new_string": "{ 1 }"}),
        );
        assert_eq!(t.detail(3).unwrap()["after"], "fn new() { 1 }\n");
    }

    #[test]
    fn edit_of_an_unread_file_uses_the_logged_original() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        tool(
            &mut t,
            &mut src,
            "e1",
            "Edit",
            json!({"file_path": "x.txt", "old_string": "b", "new_string": "B"}),
        );
        assert!(t.detail(0).unwrap()["before"].is_null());
        result(&mut t, &mut src, "e1", "ok", false, json!({"originalFile":"a\r\nb\r\n"}));
        assert_eq!(t.detail(0).unwrap()["after"], "a\r\nB\r\n");
    }

    #[test]
    fn shell_and_git() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        tool(
            &mut t,
            &mut src,
            "b1",
            "Bash",
            json!({"command": "git commit -m \"feat: x\"", "description": "Commit"}),
        );
        assert_eq!(t.steps[0].cat, "git");
        result(
            &mut t,
            &mut src,
            "b1",
            "[main abc1234] feat: x",
            false,
            json!({"stdout":"[main abc1234] feat: x\n 1 file changed","stderr":"","interrupted":false}),
        );
        let g = t.steps[0].git.as_ref().unwrap();
        assert_eq!(g.hash.as_deref(), Some("abc1234"));
        assert_eq!(t.detail(0).unwrap()["stdout"], "[main abc1234] feat: x\n 1 file changed");
    }

    #[test]
    fn prompts_turns_interrupts_and_notifications() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        prompt(&mut t, &mut src, "first");
        t.ingest(
            &mut src,
            &line(
                "user",
                "2026-11-17T10:01:00.000Z",
                r#","origin":{"kind":"task-notification"}"#,
                r#""<task-notification>done</task-notification>""#,
            ),
        );
        tool(&mut t, &mut src, "b1", "Bash", json!({"command": "sleep 100"}));
        t.ingest(
            &mut src,
            &line(
                "user",
                "2026-11-17T10:02:00.000Z",
                "",
                r#"[{"type":"text","text":"[Request interrupted by user]"}]"#,
            ),
        );
        prompt(&mut t, &mut src, "second");
        let kinds: Vec<_> = t.steps.iter().map(|s| (s.kind, s.turn)).collect();
        assert_eq!(
            kinds,
            [("prompt", 1), ("tool", 1), ("interrupt", 1), ("prompt", 2)]
        );
        assert_eq!(t.steps[1].state, "err");
        assert_eq!(t.meta.branch.as_deref(), Some("main"));
    }

    #[test]
    fn slash_commands_read_as_typed() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        t.ingest(
            &mut src,
            &line(
                "user",
                "2026-11-17T10:00:00.000Z",
                "",
                r#""<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>""#,
            ),
        );
        assert_eq!(t.steps[0].label, "/review 123");
    }

    #[test]
    fn subagent_task_is_its_prompt() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(1, true);
        t.ingest(
            &mut src,
            r#"{"type":"user","isSidechain":true,"timestamp":"2026-11-17T10:00:00.000Z","message":{"role":"user","content":"Find the parser"}}"#,
        );
        assert_eq!(t.steps[0].kind, "prompt");
        assert_eq!(t.steps[0].agent, 1);
        assert_eq!(t.steps[0].turn, 0);
    }

    #[test]
    fn web_fetch_http_errors_are_failed_loads() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(0, false);
        tool(&mut t, &mut src, "w1", "WebFetch", json!({"url": "https://www.amazon.in", "prompt": "x"}));
        result(&mut t, &mut src, "w1", "The server returned HTTP 503 Service Unavailable.

The response body was not retrieved.", false, json!({}));
        assert_eq!(t.steps[0].state, "err");
        assert_eq!(t.detail(0).unwrap()["httpStatus"], 503);
        assert_eq!(http_error_status("The server returned HTTP 200 OK"), None);
        assert_eq!(http_error_status("Some page text"), None);
    }

    #[test]
    fn a_subagent_is_finished_when_its_turn_ends() {
        let mut t = Timeline::default();
        let mut src = SourceState::new(1, true);
        t.ingest(&mut src, r#"{"type":"user","isSidechain":true,"timestamp":"2026-11-17T10:00:00.000Z","message":{"role":"user","content":"Find the parser"}}"#);
        tool(&mut t, &mut src, "g1", "Grep", json!({"pattern": "fn parse"}));
        assert!(!src.ended);
        t.ingest(&mut src, r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-11-17T10:00:09.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Found it in parser.rs"}]}}"#);
        assert!(src.ended);
        // Resumed (SendMessage): working again.
        tool(&mut t, &mut src, "g2", "Grep", json!({"pattern": "fn lex"}));
        assert!(!src.ended);
    }

    #[test]
    fn line_numbers_are_stripped() {
        assert_eq!(
            strip_line_numbers("    18\tfn a() {}\n    19\t}\n"),
            ("fn a() {}\n}\n".to_string(), 18)
        );
        assert_eq!(strip_line_numbers("plain text").0, "plain text");
    }

    #[test]
    fn timestamps_of_raw_lines() {
        assert!(line_ts(r#"{"type":"x","timestamp":"2026-11-17T10:00:00.000Z"}"#).is_some());
        assert!(line_ts(r#"{"type":"x"}"#).is_none());
    }
}
