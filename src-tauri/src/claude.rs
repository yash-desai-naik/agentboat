//! Where Claude Code keeps what Agentsboat reads, and the session registry.
//!
//! - `~/.claude/sessions/<pid>.json`: one file per running interactive session, rewritten by
//!   Claude Code whenever its status changes (`busy`, `idle`, `waiting` + `waitingFor`). The
//!   `<pid>.<hash>.key` files next to them are secrets for session messaging and are never read.
//! - `~/.claude/projects/<cwd with every non-alphanumeric char as '-'>/<sessionId>.jsonl`: the
//!   transcript, appended line by line.
//! - `.../<sessionId>/subagents/agent-<id>.jsonl` and `.meta.json`: each subagent's transcript and
//!   its description, type and whether it has finished.
//! - `.../<sessionId>/subagents/workflows/wf_<run>/`: one folder per workflow run (the Workflow
//!   tool): its agents' `agent-<id>.jsonl` and `.meta.json` (the script's label and phase), and
//!   `journal.jsonl`, the run's own record: `launched`, then `started` and `result` per agent.
//!
//! `CLAUDE_CONFIG_DIR` moves `~/.claude`, as it does for Claude Code itself.

use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

pub fn claude_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// One running session, as Claude Code registers it. Unknown fields are ignored, missing ones
/// default, so a newer Claude Code that adds fields still reads.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Registered {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub started_at: i64,
    /// The process's creation time (Windows FILETIME, as a string), to tell a reused pid apart.
    pub proc_start: Option<String>,
    pub name: Option<String>,
    pub status: Option<String>,
    pub waiting_for: Option<String>,
    pub status_updated_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub kind: Option<String>,
    pub entrypoint: Option<String>,
    pub version: Option<String>,
}

/// Every `<pid>.json` in the sessions folder. Files that can't be read or parsed (one being
/// rewritten this instant) are skipped; the next tick sees them.
pub fn read_registry(claude: &Path) -> Vec<Registered> {
    let Ok(rd) = fs::read_dir(claude.join("sessions")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        // Only `<digits>.json`; never the `.key` files.
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(text) = fs::read_to_string(e.path()) else {
            continue;
        };
        if let Ok(r) = serde_json::from_str::<Registered>(&text)
            && !r.session_id.is_empty()
        {
            out.push(r);
        }
    }
    out
}

/// The folder name Claude Code uses for a working directory under `projects/`.
pub fn project_folder_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The transcript of a session: first where the cwd says it is, then (long or unusual paths)
/// any project folder that has it.
pub fn find_transcript(claude: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let projects = claude.join("projects");
    let file = format!("{session_id}.jsonl");
    let direct = projects.join(project_folder_name(cwd)).join(&file);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&file))
        .find(|p| p.is_file())
}

/// A subagent's `agent-<id>.meta.json`.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentMeta {
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub finished: bool,
    /// A workflow agent's phase, as the script named it (`phase()` or the agent's `phase` option).
    pub workflow_phase: Option<String>,
}

/// The last folder of a path, for display (`D:\projects\fileboat` → `fileboat`).
pub fn folder_label(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(cwd)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_folder_names_match_claude_code() {
        assert_eq!(
            project_folder_name(r"D:\projects\fileboat"),
            "D--projects-fileboat"
        );
        assert_eq!(
            project_folder_name(r"C:\Users\Jane Doe\.claude\skills\daily-notes"),
            "C--Users-Jane-Doe--claude-skills-daily-notes"
        );
        assert_eq!(project_folder_name("/home/me/my_app"), "-home-me-my-app");
    }

    #[test]
    fn folder_labels() {
        assert_eq!(folder_label(r"D:\work\my-api\"), "my-api");
        assert_eq!(folder_label("/a/b"), "b");
    }

    #[test]
    fn registry_reads_known_and_ignores_unknown_fields() {
        let r: Registered = serde_json::from_str(
            r#"{"pid":18636,"sessionId":"132f","cwd":"D:\\work","startedAt":1,"status":"waiting","waitingFor":"permission","newField":[1,2]}"#,
        )
        .unwrap();
        assert_eq!(r.pid, 18636);
        assert_eq!(r.status.as_deref(), Some("waiting"));
        assert_eq!(r.waiting_for.as_deref(), Some("permission"));
    }
}
