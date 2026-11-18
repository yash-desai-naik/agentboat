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
    /// The `Agent` step that started it, when known.
    pub step: Option<u32>,
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

pub struct Viewer {
    claude: Option<PathBuf>,
    pub id: String,
    path: PathBuf,
    main: Source,
    agents: Vec<Agent>,
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

    /// Finds new subagent transcripts and re-reads the metadata of running ones.
    fn scan_agents(&mut self) {
        for a in &mut self.agents {
            if !a.info.finished
                && let Some(m) = read_meta(&a.meta_path)
            {
                a.info.finished = m.finished || a.source.state.ended;
                a.info.description = m.description.or(a.info.description.take());
                a.info.kind = m.agent_type.or(a.info.kind.take());
            }
        }
        let Ok(rd) = std::fs::read_dir(&self.subagents_dir) else {
            return;
        };
        let mut found: Vec<(String, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?.to_string();
                Some((id, e.path()))
            })
            .filter(|(id, _)| !self.agents.iter().any(|a| &a.info.id == id))
            .collect();
        // Oldest first, so agent numbers follow the order they started.
        found.sort_by_key(|(_, p)| {
            std::fs::metadata(p)
                .and_then(|m| m.created().or_else(|_| m.modified()))
                .ok()
        });
        for (id, path) in found {
            let meta_path = self.subagents_dir.join(format!("agent-{id}.meta.json"));
            let meta = read_meta(&meta_path).unwrap_or_default();
            let n = self.agents.len() as u16 + 1;
            self.agents.push(Agent {
                info: AgentInfo {
                    id,
                    description: meta.description,
                    kind: meta.agent_type,
                    finished: meta.finished,
                    step: None,
                },
                source: Source::new(path, n),
                meta_path,
            });
        }
    }

    /// Ties each subagent to the `Agent` step that started it.
    fn link_agents(&mut self) {
        for a in &mut self.agents {
            if a.info.step.is_some() {
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

fn read_meta(path: &Path) -> Option<AgentMeta> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_meta_tool_use(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("toolUseId")?.as_str().map(str::to_string)
}
