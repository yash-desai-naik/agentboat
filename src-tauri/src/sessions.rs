//! The sessions you can open: the ones running now (from Claude Code's session registry) and the
//! most recent transcripts on disk.
//!
//! A transcript's title and folder are found by peeking at its first and last few hundred KB
//! (the `cwd` is on the early lines; `ai-title`, `custom-title` and `last-prompt` are rewritten as
//! the session goes, so the last one wins). Peeks are cached by size and modification time.

use crate::alive::alive;
use crate::claude::{self, Registered};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HEAD_BYTES: u64 = 96 * 1024;
const TAIL_BYTES: u64 = 384 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub path: String,
    pub cwd: Option<String>,
    pub folder: String,
    pub title: Option<String>,
    pub last_prompt: Option<String>,
    pub branch: Option<String>,
    /// Unix ms of the transcript's last write.
    pub modified: i64,
    pub size: u64,
    /// In the registry with a running process.
    pub live: bool,
    /// `busy`, `idle`, `waiting` while live.
    pub status: Option<String>,
    pub waiting_for: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Peek {
    cwd: Option<String>,
    /// A title you set wins over the one Claude Code generates.
    custom: Option<String>,
    ai: Option<String>,
    last_prompt: Option<String>,
    branch: Option<String>,
}

#[derive(Default)]
pub struct SessionList {
    cache: HashMap<PathBuf, (u64, SystemTime, Peek)>,
}

/// Running sessions: registry entries whose process is alive, keyed by session id.
pub fn live_sessions(claude_dir: &Path) -> HashMap<String, Registered> {
    claude::read_registry(claude_dir)
        .into_iter()
        .filter(|r| alive(r.pid, r.proc_start.as_deref()))
        .map(|r| (r.session_id.clone(), r))
        .collect()
}

impl SessionList {
    /// Live sessions first (newest activity first), then the most recent others, `limit` of
    /// those, and how many older transcripts weren't listed.
    pub fn list(&mut self, claude_dir: &Path, limit: usize) -> (Vec<SessionEntry>, usize) {
        let live = live_sessions(claude_dir);
        let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        if let Ok(projects) = std::fs::read_dir(claude_dir.join("projects")) {
            for p in projects.flatten() {
                let Ok(rd) = std::fs::read_dir(p.path()) else {
                    continue;
                };
                for f in rd.flatten() {
                    let path = f.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Ok(meta) = f.metadata() else { continue };
                    if !meta.is_file() || meta.len() == 0 {
                        continue;
                    }
                    files.push((path, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)));
                }
            }
        }
        files.sort_by(|a, b| b.2.cmp(&a.2));

        let mut out = Vec::new();
        let mut seen_live = 0;
        let mut older = 0;
        for (path, size, mtime) in files {
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let reg = live.get(&id);
            if reg.is_none() && out.len() - seen_live >= limit {
                older += 1;
                continue;
            }
            let peek = self.peek(&path, size, mtime);
            let title = peek.custom.clone().or(peek.ai.clone());
            if reg.is_none() && title.is_none() && peek.last_prompt.is_none() {
                // Nothing was ever asked (an empty or tool-only transcript).
                continue;
            }
            if reg.is_some() {
                seen_live += 1;
            }
            let cwd = reg.map(|r| r.cwd.clone()).or(peek.cwd.clone());
            out.push(SessionEntry {
                folder: cwd
                    .as_deref()
                    .map(claude::folder_label)
                    .unwrap_or_else(|| folder_of(&path)),
                id,
                path: path.to_string_lossy().into_owned(),
                cwd,
                title,
                last_prompt: peek.last_prompt,
                branch: peek.branch,
                modified: ms(mtime),
                size,
                live: reg.is_some(),
                status: reg.and_then(|r| r.status.clone()),
                waiting_for: reg.and_then(|r| r.waiting_for.clone()),
                name: reg.and_then(|r| r.name.clone()),
            });
        }
        // Live ones first, each group newest first (already sorted by mtime).
        out.sort_by_key(|e| !e.live);
        (out, older)
    }

    /// A transcript's title (yours, else Claude Code's), else its last prompt.
    pub fn title_of(&mut self, path: &Path) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        let p = self.peek(path, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH));
        p.custom.or(p.ai).or(p.last_prompt)
    }

    fn peek(&mut self, path: &Path, size: u64, mtime: SystemTime) -> Peek {
        if let Some((s, m, p)) = self.cache.get(path)
            && *s == size
            && *m == mtime
        {
            return p.clone();
        }
        let p = peek_file(path, size).unwrap_or_default();
        self.cache
            .insert(path.to_path_buf(), (size, mtime, p.clone()));
        p
    }
}

fn peek_file(path: &Path, size: u64) -> Option<Peek> {
    let mut f = File::open(path).ok()?;
    let mut peek = Peek::default();
    let mut head = Vec::new();
    (&mut f).take(HEAD_BYTES).read_to_end(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head);
    for line in head.lines() {
        scan(&mut peek, line);
    }
    if size > HEAD_BYTES {
        let from = size.saturating_sub(TAIL_BYTES).max(HEAD_BYTES);
        f.seek(SeekFrom::Start(from)).ok()?;
        let mut tail = Vec::new();
        f.take(TAIL_BYTES).read_to_end(&mut tail).ok()?;
        let tail = String::from_utf8_lossy(&tail);
        // The first line is likely cut: skip it.
        for line in tail.lines().skip(1) {
            scan(&mut peek, line);
        }
    }
    Some(peek)
}

#[derive(serde::Deserialize)]
struct PeekLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    #[serde(rename = "lastPrompt")]
    last_prompt: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
}

fn scan(peek: &mut Peek, line: &str) {
    // Only small metadata lines are parsed; big message lines are only checked for a cwd once.
    let interesting = line.len() < 4096
        && (line.contains("\"ai-title\"")
            || line.contains("\"custom-title\"")
            || line.contains("\"last-prompt\""));
    if !interesting && (peek.cwd.is_some() || !line.contains("\"cwd\"")) {
        return;
    }
    let Ok(l) = serde_json::from_str::<PeekLine>(line) else {
        return;
    };
    if peek.cwd.is_none() {
        peek.cwd = l.cwd.clone();
    }
    if let Some(b) = l.git_branch.filter(|b| !b.is_empty() && b != "HEAD") {
        peek.branch = Some(b);
    }
    match l.kind.as_deref() {
        Some("custom-title") => {
            peek.custom = l.custom_title.filter(|t| !t.trim().is_empty());
        }
        Some("ai-title") => {
            if let Some(t) = l.ai_title.filter(|t| !t.trim().is_empty()) {
                peek.ai = Some(t);
            }
        }
        Some("last-prompt") => {
            if let Some(p) = l.last_prompt.filter(|p| !p.trim().is_empty()) {
                peek.last_prompt = Some(crate::timeline::one_line(&p, 160));
            }
        }
        _ => {}
    }
}

fn folder_of(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

fn ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
