//! The status bar's context window and usage limits, from Claude Code's status line input
//! (`ccboat_core::statusline`), and turning that on or off.

use ccboat_core::claude::claude_dir;
use ccboat_core::{hooks, statusline};
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

/// Where the status line snapshots go: Ccboat's own data folder.
fn snapshot_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("statusline"))
        .map_err(|e| e.to_string())
}

/// The open session's context window and effort, and the account's 5-hour and 7-day limits.
#[tauri::command(async)]
pub fn usage(session: Option<String>, app: tauri::AppHandle) -> statusline::Usage {
    snapshot_dir(&app)
        .map(|d| statusline::read(&d, session.as_deref()))
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsStatus {
    installed: bool,
    settings: String,
    error: Option<String>,
}

#[tauri::command]
pub fn limits_status() -> LimitsStatus {
    let path = claude_dir().map(|d| hooks::settings_path(&d));
    let read = path.as_deref().map(hooks::read);
    LimitsStatus {
        installed: matches!(&read, Some(Ok(s)) if statusline::installed(s)),
        settings: path.map(|p| p.display().to_string()).unwrap_or_default(),
        error: match read {
            Some(Err(e)) => Some(e),
            None => Some("No Claude Code folder.".into()),
            _ => None,
        },
    }
}

/// Turn "show usage limits" on (Ccboat's status line, wrapping yours) or off (yours back).
#[tauri::command]
pub fn limits_set(on: bool, app: tauri::AppHandle) -> Result<(), String> {
    let path = hooks::settings_path(&claude_dir().ok_or("No Claude Code folder.")?);
    let dir = snapshot_dir(&app)?;
    let mut s = hooks::read(&path)?;
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        statusline::add(&mut s, &exe, &dir)?;
        hooks::write(&path, &s)
    } else if statusline::remove(&mut s, &dir) {
        hooks::write(&path, &s)
    } else {
        Ok(())
    }
}
