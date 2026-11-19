//! The session open in the window, followed by one background thread.
//!
//! Every 250 ms (1 s while the window is hidden or minimized) the thread reads what was appended
//! to the open session's transcripts and, when something changed, sends the UI `ccb:update`: the
//! new steps, the earlier steps whose results arrived, and the session head. Nothing is sent
//! when nothing changed. Whether the session is still running is checked every second.

use agentboat_core::claude::claude_dir;
use agentboat_core::sessions::{SessionEntry, SessionList};
use agentboat_core::timeline::Step;
use agentboat_core::viewer::{Head, Viewer};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};

/// The open session, if any.
#[derive(Default, Clone)]
pub struct Open(pub Arc<Mutex<Option<Viewer>>>);

#[derive(Default)]
pub struct Sessions(pub Mutex<SessionList>);

const TICK: Duration = Duration::from_millis(250);
const TICK_HIDDEN: Duration = Duration::from_millis(1000);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Update<'a> {
    session: &'a str,
    head: &'a Head,
    /// Changed earlier steps, then the new ones.
    steps: Vec<&'a Step>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened<'a> {
    head: Head,
    steps: &'a [Step],
}

pub fn start(app: AppHandle) {
    let open = app.state::<Open>().inner().clone();
    std::thread::Builder::new()
        .name("follow".into())
        .spawn(move || {
            let mut last_status = Instant::now();
            let mut last_head = String::new();
            loop {
                let shown = app
                    .get_webview_window("main")
                    .map(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
                    .unwrap_or(true);
                {
                    let mut guard = open.0.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(v) = guard.as_mut() {
                        if last_status.elapsed() >= Duration::from_secs(1) {
                            last_status = Instant::now();
                            v.refresh_status();
                        }
                        let (first_new, dirty) = v.poll();
                        let head = v.head();
                        let head_json = serde_json::to_string(&head).unwrap_or_default();
                        let steps = v.steps();
                        if first_new < steps.len() || !dirty.is_empty() || head_json != last_head {
                            last_head = head_json;
                            let mut out: Vec<&Step> =
                                dirty.iter().filter_map(|&i| steps.get(i as usize)).collect();
                            out.extend(steps[first_new..].iter());
                            let _ = app.emit(
                                "ccb:update",
                                Update {
                                    session: &v.id,
                                    head: &head,
                                    steps: out,
                                },
                            );
                        }
                    } else {
                        last_head.clear();
                    }
                }
                std::thread::sleep(if shown { TICK } else { TICK_HIDDEN });
            }
        })
        .expect("couldn't start the follow thread");
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    sessions: Vec<SessionEntry>,
    /// Older transcripts not listed (a larger `limit` lists them).
    older: usize,
}

/// Running sessions, then the `limit` most recent others (80 unless asked for more).
#[tauri::command(async)]
pub fn list_sessions(limit: Option<usize>, sessions: tauri::State<'_, Sessions>) -> SessionPage {
    let Some(dir) = claude_dir() else {
        return SessionPage { sessions: Vec::new(), older: 0 };
    };
    let mut list = sessions.0.lock().unwrap_or_else(|e| e.into_inner());
    let (sessions, older) = list.list(&dir, limit.unwrap_or(80).clamp(1, 5000));
    SessionPage { sessions, older }
}

/// Opens a session's transcript (read whole, off the UI thread) and returns its head and steps.
#[tauri::command(async)]
pub fn open_session(path: String, open: tauri::State<'_, Open>) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("That session's transcript is gone.".into());
    }
    let viewer = Viewer::open(path);
    let json = serde_json::to_string(&Opened {
        head: viewer.head(),
        steps: viewer.steps(),
    })
    .map_err(|e| e.to_string())?;
    *open.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(viewer);
    Ok(Response::new(json))
}

#[tauri::command]
pub fn close_session(open: tauri::State<'_, Open>) {
    *open.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// A step's detail (file contents, command output), as JSON; `null` if there's none.
#[tauri::command(async)]
pub fn step_detail(session: String, i: usize, open: tauri::State<'_, Open>) -> Response {
    let guard = open.0.lock().unwrap_or_else(|e| e.into_inner());
    let json = guard
        .as_ref()
        .filter(|v| v.id == session)
        .and_then(|v| v.timeline.detail(i))
        .and_then(|d| serde_json::to_string(d).ok())
        .unwrap_or_else(|| "null".into());
    Response::new(json)
}

/// Several details at once, as a JSON array in the order asked.
#[tauri::command(async)]
pub fn step_details(session: String, ids: Vec<usize>, open: tauri::State<'_, Open>) -> Response {
    let guard = open.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = String::from("[");
    for (k, i) in ids.iter().enumerate() {
        if k > 0 {
            out.push(',');
        }
        let d = guard
            .as_ref()
            .filter(|v| v.id == session)
            .and_then(|v| v.timeline.detail(*i))
            .and_then(|d| serde_json::to_string(d).ok());
        out.push_str(d.as_deref().unwrap_or("null"));
    }
    out.push(']');
    Response::new(out)
}
