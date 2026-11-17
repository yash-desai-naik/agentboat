//! Updates: Ccboat checks GitHub for a newer release (shortly after start-up and once a day,
//! unless turned off in About, and whenever you ask), and on request downloads the signed
//! installer, verifies it against the public key in tauri.conf.json, runs it (a small progress
//! window, no questions) and starts again on the new version.
//!
//! The feed is `latest.json` on the latest published GitHub release, made by the release workflow;
//! drafts and pre-releases are never offered. This is Ccboat's only use of the network.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// What the window shows about an available update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    /// Release notes (Markdown, from CHANGELOG.md).
    pub notes: String,
    pub date: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    /// The update found by the last check, ready to install.
    pending: Mutex<Option<Update>>,
    installing: Mutex<bool>,
}

fn info(u: &Update) -> UpdateInfo {
    UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()),
    }
}

/// Ask GitHub for a newer version. `Ok(None)` = up to date.
async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    // CCBOAT_UPDATE_URL points a test build at another feed.
    let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
    if let Some(url) = std::env::var("CCBOAT_UPDATE_URL")
        .ok()
        .and_then(|u| url::Url::parse(&u).ok())
    {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let found = updater
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let state = app.state::<UpdateState>();
    let out = found.as_ref().map(info);
    *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = found;
    Ok(out)
}

/// Check now (the UI decides when: a timer, or "Check for updates"). `Ok(None)` = up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let found = check(&app).await?;
    if let Some(i) = &found {
        let _ = app.emit("update:available", i.clone());
    }
    Ok(found)
}

/// The update found earlier, if any (the page asks after a reload).
#[tauri::command]
pub fn update_status(state: tauri::State<'_, UpdateState>) -> Option<UpdateInfo> {
    state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(info)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Download, verify and install the pending update, and start the new version. On Windows the
/// installer takes over and starts Ccboat again; on macOS the app bundle is replaced in place.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    {
        let mut busy = state.installing.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return Err("The update is already being installed.".into());
        }
        *busy = true;
    }
    let update = state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(update) = update else {
        *state.installing.lock().unwrap_or_else(|e| e.into_inner()) = false;
        return Err("No update to install: check for updates first.".into());
    };
    let mut downloaded = 0u64;
    let progress_app = app.clone();
    let done_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit("update:progress", Progress { downloaded, total });
            },
            move || {
                let _ = done_app.emit("update:installing", ());
            },
        )
        .await;
    *state.installing.lock().unwrap_or_else(|e| e.into_inner()) = false;
    if let Err(e) = result {
        return Err(format!("The update couldn't be installed: {e}"));
    }
    #[cfg(not(windows))]
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}
