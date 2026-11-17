//! Ccboat's own folders, for the About box, and opening them (or its GitHub page) with the
//! desktop. Fixed addresses only: nothing from a session is ever opened.

use tauri::Manager;

const REPO_URL: &str = "https://github.com/yash-desai-naik/ccboat";

/// Open a folder or a web address with the desktop: Explorer, Finder or xdg-open.
fn open_with_desktop(arg: &std::ffi::OsStr) -> Result<(), String> {
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Where Ccboat keeps things, for the About box.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    /// The WebView's data: view settings (layout, replay speed), the last session opened.
    data_dir: String,
    /// The running program.
    exe: String,
    /// Where Claude Code keeps the sessions Ccboat reads.
    claude_dir: String,
}

#[tauri::command]
pub fn app_paths(app: tauri::AppHandle) -> Result<AppPaths, String> {
    Ok(AppPaths {
        data_dir: app
            .path()
            .app_local_data_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        exe: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        claude_dir: ccboat_core::claude::claude_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    })
}

/// Open Ccboat's data folder or Claude Code's folder in the file manager.
#[tauri::command]
pub fn open_app_folder(app: tauri::AppHandle, which: String) -> Result<(), String> {
    let dir = match which.as_str() {
        "data" => app.path().app_local_data_dir().map_err(|e| e.to_string())?,
        "claude" => ccboat_core::claude::claude_dir().ok_or("No Claude Code folder.")?,
        _ => return Err("Unknown folder.".into()),
    };
    open_with_desktop(dir.as_os_str())
}

/// Ccboat's releases on GitHub, in the default browser.
#[tauri::command]
pub fn open_releases_page() -> Result<(), String> {
    open_with_desktop(format!("{REPO_URL}/releases").as_ref())
}

/// Ccboat's GitHub page, in the default browser.
#[tauri::command]
pub fn open_repo_page() -> Result<(), String> {
    open_with_desktop(REPO_URL.as_ref())
}
