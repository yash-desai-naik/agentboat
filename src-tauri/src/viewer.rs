//! One open session: its main transcript and its subagents' transcripts, followed as they grow and
//! merged by time into one [`Timeline`].
//!
//! [`Viewer::poll`] reads only the bytes appended since the last poll; a line still being written
//! (no newline yet) waits for the next. New subagent transcripts are looked for every second.

use crate::claude::{self, AgentMeta};
use crate::sessions::live_sessions;
use crate::time::now_ms;
use crate::timeline::{Meta, SourceState, Step, Timeline, line_ts};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A transcript not registered as running, but written to this recently, is shown as active
/// (non-interactive `claude -p` runs and SDK sessions aren't in the registry).
const RECENT_MS: i64 = 30_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub description: Option<String>,
    pub kind: Option<String>,
    pub finished: bool,
    /// The `Agent` or `Workflow` step that started it, when known.
    pub step: Option<u32>,
    /// The workflow run it belongs to (`wf_…`), for a workflow's agents.
    pub run: Option<String>,
    /// Its phase in that workflow.
    pub phase: Option<String>,
}

/// Everything about the session except its steps.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub meta: Meta,
    /// `working`, `waiting`, `idle` (registered and running), `active` (written to recently,
    /// not registered) or `ended`.
    pub status: String,
    pub waiting_for: Option<String>,
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub agents: Vec<AgentInfo>,
    pub steps: usize,
}

struct Source {
    path: PathBuf,
    offset: u64,
    state: SourceState,
    last_ts: i64,
}

impl Source {
    fn new(path: PathBuf, agent: u16) -> Self {
        Source {
            path,
            offset: 0,
            state: SourceState::new(agent, agent != 0),
            last_ts: 0,
        }
    }

    /// Complete lines appended since the last read, each with its time (or the previous line's).
    fn read_new(&mut self) -> Vec<(i64, String)> {
        let mut out = Vec::new();
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return out;
        };
        let len = meta.len();
        if len < self.offset {
            // Rewritten or truncated: read again from the start (rare; steps already shown stay).
            self.offset = 0;
        }
        if len == self.offset {
            return out;
        }
        let Ok(mut file) = File::open(&self.path) else {
            return out;
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return out;
        }
        let mut reader = BufReader::with_capacity(256 * 1024, file);
        let mut buf = Vec::with_capacity(16 * 1024);
        loop {
            buf.clear();
            let n = match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if buf.last() != Some(&b'\n') {
                break; // Partial line: read it whole next time.
            }
            self.offset += n as u64;
            if let Ok(line) = std::str::from_utf8(&buf) {
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                if let Some(ts) = line_ts(line) {
                    self.last_ts = ts;
                }
                out.push((self.last_ts, line.to_string()));
            }
        }
        out
    }
}

struct Agent {
    info: AgentInfo,
    source: Source,
    meta_path: PathBuf,
}

/// A workflow run's `journal.jsonl`, read as it grows: which of its agents have reported.
struct Journal {
    path: PathBuf,
    offset: u64,
    /// Agents with a `result` in the journal.
    done: HashSet<String>,
}

impl Journal {
    fn read_new(&mut self) {
        for line in read_lines(&self.path, &mut self.offset) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            // `started` opens an agent, `result` closes it; other events are ignored (an agent
            // that never reports is over when its run is, which the UI reads from the run).
            if v.get("type").and_then(|t| t.as_str()) == Some("result")
                && let Some(id) = v.get("agentId").and_then(|a| a.as_str())
            {
                self.done.insert(id.to_string());
            }
        }
    }
}

pub struct Viewer {
    claude: Option<PathBuf>,
    pub id: String,
    path: PathBuf,
    main: Source,
    agents: Vec<Agent>,
    /// Workflow runs found so far, by run id.
    journals: HashMap<String, Journal>,
    subagents_dir: PathBuf,
    last_scan: i64,
    pub timeline: Timeline,
    status: String,
    waiting_for: Option<String>,
    name: Option<String>,
    pid: Option<u32>,
}

impl Viewer {
    /// Opens a transcript and reads it (and its subagents) whole.
    pub fn open(path: PathBuf) -> Viewer {
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let subagents_dir = path.with_extension("").join("subagents");
        let mut v = Viewer {
            claude: claude::claude_dir(),
            id,
            main: Source::new(path.clone(), 0),
            path,
            agents: Vec::new(),
            journals: HashMap::new(),
            subagents_dir,
            last_scan: 0,
            timeline: Timeline::default(),
            status: "ended".into(),
            waiting_for: None,
            name: None,
            pid: None,
        };
        v.refresh_status();
        v.poll();
        v.timeline.take_dirty();
        v
    }

    /// Reads what was appended to the transcripts. Returns the index of the first new step and
    /// the earlier steps that changed.
    pub fn poll(&mut self) -> (usize, Vec<u32>) {
        let first_new = self.timeline.steps.len();
        let now = now_ms();
        if now - self.last_scan >= 1000 {
            self.last_scan = now;
            self.scan_agents();
        }
        let mut batches: Vec<std::collections::VecDeque<(i64, String)>> = Vec::new();
        batches.push(self.main.read_new().into());
        for a in &mut self.agents {
            batches.push(a.source.read_new().into());
        }
        // Merge by time, keeping each transcript's own order.
        loop {
            let mut best: Option<(usize, i64)> = None;
            for (k, b) in batches.iter().enumerate() {
                if let Some((ts, _)) = b.front()
                    && best.is_none_or(|(_, t)| *ts < t)
                {
                    best = Some((k, *ts));
                }
            }
            let Some((k, _)) = best else { break };
            let (_, line) = batches[k].pop_front().unwrap_or_default();
            let state = if k == 0 {
                &mut self.main.state
            } else {
                &mut self.agents[k - 1].source.state
            };
            self.timeline.ingest(state, &line);
        }
        self.link_agents();
        let dirty = self
            .timeline
            .take_dirty()
            .into_iter()
            .filter(|&i| (i as usize) < first_new)
            .collect();
        (first_new, dirty)
    }

    /// Finds new subagent transcripts (the session's own, then each workflow run's) and re-reads
    /// the metadata of running ones.
    fn scan_agents(&mut self) {
        for j in self.journals.values_mut() {
            j.read_new();
        }
        for a in &mut self.agents {
            if a.info.finished {
                continue;
            }
            // A workflow agent's meta.json never says it finished, and its transcript can end on
            // a tool result (its structured output) rather than a reply: its run's journal says.
            let reported = a
                .info
                .run
                .as_ref()
                .and_then(|r| self.journals.get(r))
                .is_some_and(|j| j.done.contains(&a.info.id));
            if let Some(m) = read_meta(&a.meta_path) {
                a.info.finished = m.finished || a.source.state.ended || reported;
                a.info.description = m.description.or(a.info.description.take());
                a.info.kind = m.agent_type.or(a.info.kind.take());
                a.info.phase = m.workflow_phase.or(a.info.phase.take());
            } else if reported {
                a.info.finished = true;
            }
        }
        // (id, transcript, folder it's in, workflow run)
        let mut found: Vec<(String, PathBuf, PathBuf, Option<String>)> = Vec::new();
        let known = |id: &str| self.agents.iter().any(|a| a.info.id == id);
        let mut add_dir = |dir: &Path, run: Option<&str>| {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let Some(name) = e.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                let Some(id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".jsonl"))
                else {
                    continue;
                };
                if !known(id) {
                    found.push((id.to_string(), e.path(), dir.to_path_buf(), run.map(str::to_string)));
                }
            }
        };
        add_dir(&self.subagents_dir, None);
        let runs = self.subagents_dir.join("workflows");
        let mut new_runs = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&runs) {
            for e in rd.flatten() {
                let Some(run) = e.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !e.path().is_dir() {
                    continue;
                }
                add_dir(&e.path(), Some(&run));
                if !self.journals.contains_key(&run) {
                    new_runs.push((run, e.path().join("journal.jsonl")));
                }
            }
        }
        for (run, path) in new_runs {
            let mut j = Journal {
                path,
                offset: 0,
                done: HashSet::new(),
            };
            j.read_new();
            self.journals.insert(run, j);
        }
        // Oldest first, so agent numbers follow the order they started.
        found.sort_by_key(|(_, p, _, _)| {
            std::fs::metadata(p)
                .and_then(|m| m.created().or_else(|_| m.modified()))
                .ok()
        });
        for (id, path, dir, run) in found {
            let meta_path = dir.join(format!("agent-{id}.meta.json"));
            let meta = read_meta(&meta_path).unwrap_or_default();
            let reported = run
                .as_ref()
                .and_then(|r| self.journals.get(r))
                .is_some_and(|j| j.done.contains(&id));
            let n = self.agents.len() as u16 + 1;
            self.agents.push(Agent {
                info: AgentInfo {
                    id,
                    description: meta.description,
                    kind: meta.agent_type,
                    finished: meta.finished || reported,
                    step: None,
                    run,
                    phase: meta.workflow_phase,
                },
                source: Source::new(path, n),
                meta_path,
            });
        }
    }

    /// Ties each subagent to the `Agent` step that started it, and a workflow's agents to the
    /// `Workflow` step that launched their run.
    fn link_agents(&mut self) {
        for a in &mut self.agents {
            if a.info.step.is_some() {
                continue;
            }
            if let Some(run) = &a.info.run {
                a.info.step = self.timeline.workflow_steps.get(run).copied();
                continue;
            }
            a.info.step = self.timeline.agent_steps.get(&a.info.id).copied().or_else(|| {
                let tool_use = read_meta_tool_use(&a.meta_path)?;
                self.main.state.tools.get(&tool_use).copied()
            });
        }
    }

    /// Whether the session is still running, from the registry (every second or so).
    pub fn refresh_status(&mut self) {
        let reg = self
            .claude
            .as_deref()
            .and_then(|c| live_sessions(c).remove(&self.id));
        match reg {
            Some(r) => {
                self.status = match r.status.as_deref() {
                    Some("busy") => "working",
                    Some("waiting") => "waiting",
                    _ => "idle",
                }
                .into();
                self.waiting_for = r.waiting_for;
                self.name = r.name;
                self.pid = Some(r.pid);
            }
            None => {
                let recent = std::fs::metadata(&self.path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .is_some_and(|d| now_ms() - (d.as_millis() as i64) < RECENT_MS);
                self.status = if recent { "active" } else { "ended" }.into();
                self.waiting_for = None;
                self.pid = None;
            }
        }
    }

    pub fn head(&self) -> Head {
        Head {
            id: self.id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            title: self.timeline.title().map(str::to_string),
            meta: self.timeline.meta.clone(),
            status: self.status.clone(),
            waiting_for: self.waiting_for.clone(),
            name: self.name.clone(),
            pid: self.pid,
            // Finished per its meta.json, or because its transcript's last reply ended its turn.
            agents: self
                .agents
                .iter()
                .map(|a| AgentInfo {
                    finished: a.info.finished || a.source.state.ended,
                    ..a.info.clone()
                })
                .collect(),
            steps: self.timeline.steps.len(),
        }
    }

    pub fn steps(&self) -> &[Step] {
        &self.timeline.steps
    }
}

/// Complete lines appended to a file since `offset`, which moves past them.
fn read_lines(path: &Path, offset: &mut u64) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(meta) = std::fs::metadata(path) else {
        return out;
    };
    if meta.len() < *offset {
        *offset = 0;
    }
    if meta.len() == *offset {
        return out;
    }
    let Ok(mut file) = File::open(path) else {
        return out;
    };
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return out;
    }
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) if buf.last() == Some(&b'\n') => {
                *offset += n as u64;
                if let Ok(line) = std::str::from_utf8(&buf) {
                    let line = line.trim_end();
                    if !line.is_empty() {
                        out.push(line.to_string());
                    }
                }
            }
            Ok(_) => break, // Partial line: read it whole next time.
        }
    }
    out
}

fn read_meta(path: &Path) -> Option<AgentMeta> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_meta_tool_use(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("toolUseId")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;

    fn append(path: &Path, v: serde_json::Value) {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{v}").unwrap();
    }

    #[test]
    fn a_workflows_agents_join_its_step() {
        let base = std::env::temp_dir().join(format!("agentboat-wf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let run = base.join("s1").join("subagents").join("workflows").join("wf_0001-aa");
        fs::create_dir_all(&run).unwrap();
        let main = base.join("s1.jsonl");
        let msg = |role: &str, ts: &str, content: serde_json::Value| {
            json!({"type": role, "timestamp": ts, "message": {"role": role, "content": content}})
        };
        append(&main, msg("user", "2026-11-17T10:00:00.000Z", json!("sort them")));
        append(&main, msg("assistant", "2026-11-17T10:00:01.000Z", json!([{"type": "tool_use", "id": "wf1", "name": "Workflow", "input": {"script": "export const meta = { name: 'sort-files' }"}}])));
        let mut res = msg("user", "2026-11-17T10:00:02.000Z", json!([{"type": "tool_result", "tool_use_id": "wf1", "content": "launched"}]));
        res["toolUseResult"] = json!({"status": "async_launched", "runId": "wf_0001-aa", "workflowName": "sort-files"});
        append(&main, res);
        // A plain subagent beside the run is still found where it always was.
        append(&base.join("s1").join("subagents").join("agent-plain.jsonl"), msg("user", "2026-11-17T10:00:03.000Z", json!("look around")));
        for (id, label, phase) in [("a1", "sort:a", "Sort"), ("a2", "check:a", "Check")] {
            let mut first = msg("user", "2026-11-17T10:00:04.000Z", json!(format!("task {label}")));
            first["isSidechain"] = json!(true);
            append(&run.join(format!("agent-{id}.jsonl")), first);
            fs::write(
                run.join(format!("agent-{id}.meta.json")),
                json!({"agentType": "workflow-subagent", "description": label, "workflowPhase": phase, "inWorkflowRun": true}).to_string(),
            )
            .unwrap();
        }
        append(&run.join("journal.jsonl"), json!({"type": "launched"}));
        append(&run.join("journal.jsonl"), json!({"type": "started", "agentId": "a1", "label": "sort:a", "phase": "Sort"}));
        append(&run.join("journal.jsonl"), json!({"type": "result", "agentId": "a1", "result": {"ok": true}}));
        append(&run.join("journal.jsonl"), json!({"type": "started", "agentId": "a2", "label": "check:a", "phase": "Check"}));

        let mut v = Viewer::open(main.clone());
        let head = v.head();
        let wf = head.agents.iter().filter(|a| a.run.is_some()).collect::<Vec<_>>();
        assert_eq!(head.agents.len(), 3);
        assert_eq!(wf.len(), 2);
        for a in &wf {
            assert_eq!((a.run.as_deref(), a.step), (Some("wf_0001-aa"), Some(1)));
        }
        let a1 = wf.iter().find(|a| a.id == "a1").unwrap();
        let a2 = wf.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!((a1.description.as_deref(), a1.phase.as_deref(), a1.finished), (Some("sort:a"), Some("Sort"), true));
        assert_eq!((a2.phase.as_deref(), a2.finished), (Some("Check"), false));
        let plain = head.agents.iter().find(|a| a.id == "plain").unwrap();
        assert_eq!((plain.run.as_deref(), plain.phase.as_deref()), (None, None));

        // The journal grows: a2 reports. It's read on the next scan.
        append(&run.join("journal.jsonl"), json!({"type": "result", "agentId": "a2", "result": {"ok": false}}));
        v.last_scan = 0;
        v.poll();
        assert!(v.head().agents.iter().find(|a| a.id == "a2").unwrap().finished);
        let _ = fs::remove_dir_all(&base);
    }
}
