//! "Needs you": every running session that is waiting on you, in one place, answerable here.
//!
//! Two sources:
//! - **Prompts** (`permission`, `question`, `plan`): Claude Code's `PermissionRequest` hook POSTs
//!   each one to Ccboat (see `ccboat_core::hooks`). The request is held open until you answer in
//!   Ccboat, which replies with the decision. The terminal shows its own prompt meanwhile; if you
//!   answer there instead, the registry shows the session move on, and the request is let go.
//! - **The registry** (`waiting`, `done`): a session waiting on you in its terminal without a hook
//!   request (one started before the hook was on, an MCP server asking for input), and a session
//!   that just finished its turn. These can only be opened, not answered: Claude Code has no way to
//!   send a running session a new prompt from outside.
//!
//! The UI gets the whole list as `ccb:attention` whenever it changes.

use crate::watch::Sessions;
use ccboat_core::claude::{Registered, claude_dir, find_transcript, folder_label};
use ccboat_core::hooks;
use ccboat_core::sessions::live_sessions;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u64,
    /// `permission`, `question`, `plan` (answered here); `waiting`, `done` (opened only).
    pub kind: &'static str,
    pub session_id: String,
    pub cwd: Option<String>,
    pub folder: String,
    pub title: Option<String>,
    /// The transcript, to watch the session in Ccboat.
    pub transcript: Option<String>,
    /// The subagent asking, if it isn't the main agent.
    pub agent_type: Option<String>,
    pub tool: Option<String>,
    pub mcp_server: Option<String>,
    pub input: Option<Value>,
    /// Rules Claude Code offers to remember ("always allow").
    pub suggestions: Option<Value>,
    pub waiting_for: Option<String>,
    pub at: i64,
}

impl Item {
    fn is_request(&self) -> bool {
        matches!(self.kind, "permission" | "question" | "plan")
    }
}

enum Reply {
    Decide(Value),
    /// No decision: the terminal's prompt stays the one to answer.
    Release,
}

#[derive(Default)]
struct Inner {
    items: Vec<Item>,
    replies: HashMap<u64, mpsc::Sender<Reply>>,
    next: u64,
    /// Requests whose session the registry has shown waiting on you.
    seen_waiting: HashSet<u64>,
    /// Requests answered in the terminal: let go.
    elsewhere: HashSet<u64>,
    /// Each running session's status at the last look.
    status: HashMap<String, String>,
    /// `waiting` cards you dismissed: session → the status time it was dismissed at.
    muted: HashMap<String, i64>,
    /// The token in the installed hook, if any.
    token: Option<String>,
    listening: bool,
    error: Option<String>,
}

#[derive(Default, Clone)]
pub struct Attention(Arc<Mutex<Inner>>);

impl Attention {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn emit(app: &AppHandle, g: &Inner) {
    let _ = app.emit("ccb:attention", &g.items);
}

/// Flash the taskbar button when the window isn't the one in front.
fn flash(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main")
        && !w.is_focused().unwrap_or(false)
    {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn title_of(app: &AppHandle, transcript: &Path) -> Option<String> {
    let sessions = app.state::<Sessions>();
    let mut list = sessions.0.lock().unwrap_or_else(|e| e.into_inner());
    list.title_of(transcript)
}

fn installed_token() -> Option<String> {
    let dir = claude_dir()?;
    let s = hooks::read(&hooks::settings_path(&dir)).ok()?;
    hooks::find(&s).map(|(_, t)| t).filter(|t| !t.is_empty())
}

pub fn start(app: AppHandle) {
    let att = app.state::<Attention>().inner().clone();
    att.lock().token = installed_token();
    {
        let (app, att) = (app.clone(), att.clone());
        std::thread::Builder::new()
            .name("hook-server".into())
            .spawn(move || serve(app, att))
            .expect("couldn't start the hook server");
    }
    std::thread::Builder::new()
        .name("needs-you".into())
        .spawn(move || watch_registry(app, att))
        .expect("couldn't start the registry watcher");
}

// ---------- prompts, from the hook ----------

fn serve(app: AppHandle, att: Attention) {
    let port = hooks::port();
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            att.lock().error = Some(format!(
                "Port {port} is taken ({e}), so prompts can't reach Ccboat. Is another copy running?"
            ));
            return;
        }
    };
    att.lock().listening = true;
    for conn in listener.incoming().flatten() {
        let (app, att) = (app.clone(), att.clone());
        let _ = std::thread::Builder::new()
            .name("hook".into())
            .spawn(move || handle(app, att, conn));
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct HookInput {
    session_id: String,
    transcript_path: Option<String>,
    cwd: Option<String>,
    hook_event_name: Option<String>,
    tool_name: Option<String>,
    tool_input: Option<Value>,
    permission_suggestions: Option<Value>,
    agent_type: Option<String>,
    mcp_server: Option<String>,
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// One HTTP/1.1 request with a `Content-Length` body (what Claude Code sends).
fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = HashMap::new();
    let mut total = line.len();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        total += h.len();
        if total > 64 * 1024 {
            return None;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > 16 << 20 {
        return None;
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn respond(mut s: &TcpStream, code: u16, body: &str) {
    let reason = match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let _ = write!(
        s,
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.flush();
}

/// Whether Claude Code hung up (it timed out, or the session ended).
fn gone(s: &TcpStream) -> bool {
    if s.set_nonblocking(true).is_err() {
        return true;
    }
    let mut b = [0u8; 1];
    let r = s.peek(&mut b);
    let _ = s.set_nonblocking(false);
    match r {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
    }
}

impl Attention {
    /// The token matches the installed hook's (re-read once, in case the settings changed).
    fn token_ok(&self, got: &str) -> bool {
        if got.is_empty() {
            return false;
        }
        if self.lock().token.as_deref() == Some(got) {
            return true;
        }
        let now = installed_token();
        let ok = now.as_deref() == Some(got);
        self.lock().token = now;
        ok
    }
}

fn handle(app: AppHandle, att: Attention, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(req) = read_request(&stream) else {
        return;
    };
    if req.method != "POST" || req.path != hooks::HOOK_PATH {
        return respond(&stream, 404, "{}");
    }
    // Browsers always send an Origin: a web page can't post prompts here.
    if req.headers.contains_key("origin") {
        return respond(&stream, 403, "{}");
    }
    let token = req
        .headers
        .get(&hooks::TOKEN_HEADER.to_ascii_lowercase())
        .map(String::as_str)
        .unwrap_or("");
    if !att.token_ok(token) {
        return respond(&stream, 403, "{}");
    }
    let Ok(input) = serde_json::from_slice::<HookInput>(&req.body) else {
        return respond(&stream, 400, "{}");
    };
    if input.hook_event_name.as_deref() != Some("PermissionRequest") || input.session_id.is_empty() {
        return respond(&stream, 200, "{}");
    }

    let (tx, rx) = mpsc::channel();
    let id = add_request(&app, &att, input, tx);
    flash(&app);
    let _ = stream.set_read_timeout(None);
    let reply = loop {
        match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(r) => break Some(r),
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if gone(&stream) || att.lock().elsewhere.contains(&id) {
                    break None;
                }
            }
        }
    };
    finish(&app, &att, id);
    match reply {
        Some(Reply::Decide(decision)) => respond(
            &stream,
            200,
            &json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
                .to_string(),
        ),
        Some(Reply::Release) | None => respond(&stream, 200, "{}"),
    }
}

fn add_request(app: &AppHandle, att: &Attention, i: HookInput, tx: mpsc::Sender<Reply>) -> u64 {
    let kind = match i.tool_name.as_deref() {
        Some("AskUserQuestion") => "question",
        Some("ExitPlanMode") => "plan",
        _ => "permission",
    };
    // Looked up before taking the lock: never hold both.
    let title = i.transcript_path.as_deref().and_then(|p| title_of(app, Path::new(p)));
    let mut g = att.lock();
    g.next += 1;
    let id = g.next;
    // This request is what the registry's "waiting" card was about.
    g.items
        .retain(|x| !(x.kind == "waiting" && x.session_id == i.session_id));
    g.items.push(Item {
        id,
        kind,
        folder: i.cwd.as_deref().map(folder_label).unwrap_or_default(),
        session_id: i.session_id,
        cwd: i.cwd,
        title,
        transcript: i.transcript_path,
        agent_type: i.agent_type,
        tool: i.tool_name,
        mcp_server: i.mcp_server,
        input: i.tool_input,
        suggestions: i.permission_suggestions,
        waiting_for: None,
        at: now_ms(),
    });
    g.replies.insert(id, tx);
    emit(app, &g);
    id
}

fn finish(app: &AppHandle, att: &Attention, id: u64) {
    let mut g = att.lock();
    g.items.retain(|x| x.id != id);
    g.replies.remove(&id);
    g.seen_waiting.remove(&id);
    g.elsewhere.remove(&id);
    emit(app, &g);
}

// ---------- the registry: waiting in the terminal, finished ----------

fn watch_registry(app: AppHandle, att: Attention) {
    let Some(dir) = claude_dir() else { return };
    loop {
        let live = live_sessions(&dir);
        let adds = {
            let mut g = att.lock();
            let (adds, changed) = reconcile(&mut g, &live);
            if changed {
                emit(&app, &g);
            }
            adds
        };
        if !adds.is_empty() {
            let mut cards = Vec::new();
            for (kind, r) in adds {
                let transcript = find_transcript(&dir, &r.cwd, &r.session_id);
                let title = transcript
                    .as_deref()
                    .and_then(|p| title_of(&app, p))
                    .or(r.name.clone());
                cards.push(Item {
                    id: 0,
                    kind,
                    session_id: r.session_id.clone(),
                    folder: folder_label(&r.cwd),
                    cwd: Some(r.cwd.clone()),
                    title,
                    transcript: transcript.map(|p| p.to_string_lossy().into_owned()),
                    agent_type: None,
                    tool: None,
                    mcp_server: None,
                    input: None,
                    suggestions: None,
                    waiting_for: r.waiting_for.clone(),
                    at: now_ms(),
                });
            }
            let mut g = att.lock();
            let mut waiting = false;
            for mut c in cards {
                // Still wanted? (A request may have arrived meanwhile.)
                let dup = g.items.iter().any(|x| {
                    x.session_id == c.session_id
                        && (x.kind == c.kind || (c.kind == "waiting" && x.is_request()))
                });
                if dup {
                    continue;
                }
                waiting |= c.kind == "waiting";
                g.next += 1;
                c.id = g.next;
                g.items.push(c);
            }
            emit(&app, &g);
            drop(g);
            if waiting {
                flash(&app);
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Bring the cards in line with the registry. Returns the cards to add (looked up outside the
/// lock) and whether anything changed.
fn reconcile(
    g: &mut Inner,
    live: &HashMap<String, Registered>,
) -> (Vec<(&'static str, Registered)>, bool) {
    let mut adds = Vec::new();
    let before = g.items.len();
    // Sessions that ended take their cards with them.
    g.items
        .retain(|x| x.is_request() || live.contains_key(&x.session_id));
    g.status.retain(|k, _| live.contains_key(k));
    g.muted.retain(|k, _| live.contains_key(k));
    for (sid, r) in live {
        let st = r.status.clone().unwrap_or_default();
        let prev = g.status.insert(sid.clone(), st.clone());
        let requests: Vec<u64> = g
            .items
            .iter()
            .filter(|x| x.session_id == *sid && x.is_request())
            .map(|x| x.id)
            .collect();
        if st == "waiting" {
            g.seen_waiting.extend(requests.iter().copied());
            let has_card = g
                .items
                .iter()
                .any(|x| x.kind == "waiting" && x.session_id == *sid);
            let muted = g.muted.get(sid) == Some(&r.status_updated_at.unwrap_or(0));
            if requests.is_empty() && !has_card && !muted {
                adds.push(("waiting", r.clone()));
            }
        } else {
            // It was waiting on a request and moved on: answered in the terminal.
            for id in requests {
                if g.seen_waiting.contains(&id) {
                    g.elsewhere.insert(id);
                }
            }
            g.items
                .retain(|x| !(x.kind == "waiting" && x.session_id == *sid));
        }
        if st == "busy" {
            g.items.retain(|x| !(x.kind == "done" && x.session_id == *sid));
        }
        if st == "idle" && matches!(prev.as_deref(), Some("busy" | "waiting")) {
            g.items.retain(|x| !(x.kind == "done" && x.session_id == *sid));
            adds.push(("done", r.clone()));
        }
    }
    (adds, g.items.len() != before)
}

// ---------- commands ----------

#[tauri::command]
pub fn attention_list(att: tauri::State<'_, Attention>) -> Vec<Item> {
    att.lock().items.clone()
}

/// Your answer to a prompt.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Answer {
    /// Allow it; `always` also keeps the rules Claude Code suggested.
    Allow {
        #[serde(default)]
        always: bool,
    },
    /// Say no, with what to do instead; `interrupt` also stops Claude.
    Deny {
        message: Option<String>,
        #[serde(default)]
        interrupt: bool,
    },
    /// Answers to `AskUserQuestion`: question text → the chosen label(s) or your own words.
    Answers { answers: serde_json::Map<String, Value> },
    /// Approve a plan; `always` also applies the suggested mode.
    Approve {
        #[serde(default)]
        always: bool,
    },
    /// Answer in the terminal instead.
    Release,
}

#[tauri::command]
pub fn attention_answer(id: u64, answer: Answer, att: tauri::State<'_, Attention>) -> Result<(), String> {
    let g = att.lock();
    let item = g
        .items
        .iter()
        .find(|x| x.id == id && x.is_request())
        .ok_or("That prompt is gone: it was answered in the terminal or withdrawn.")?;
    let suggestions = || {
        item.suggestions
            .clone()
            .filter(|s| s.as_array().is_some_and(|a| !a.is_empty()))
    };
    let reply = match answer {
        Answer::Allow { always } => {
            let mut d = json!({ "behavior": "allow" });
            if always && let Some(s) = suggestions() {
                d["updatedPermissions"] = s;
            }
            Reply::Decide(d)
        }
        Answer::Deny { message, interrupt } => {
            let message = message
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "The user denied this request.".into());
            let mut d = json!({ "behavior": "deny", "message": message });
            if interrupt {
                d["interrupt"] = json!(true);
            }
            Reply::Decide(d)
        }
        Answer::Answers { answers } => {
            if item.kind != "question" {
                return Err("That prompt isn't a question.".into());
            }
            let mut input = item.input.clone().unwrap_or_else(|| json!({}));
            input["answers"] = Value::Object(answers);
            Reply::Decide(json!({ "behavior": "allow", "updatedInput": input }))
        }
        Answer::Approve { always } => {
            // Claude Code needs the input back to accept a plan.
            let mut d = json!({ "behavior": "allow", "updatedInput": item.input.clone().unwrap_or_else(|| json!({})) });
            if always && let Some(s) = suggestions() {
                d["updatedPermissions"] = s;
            }
            Reply::Decide(d)
        }
        Answer::Release => Reply::Release,
    };
    g.replies
        .get(&id)
        .ok_or("That prompt is gone.")?
        .send(reply)
        .map_err(|_| "That prompt is gone.".to_string())
}

/// Put away a `waiting` or `done` card (until the session needs you again).
#[tauri::command]
pub fn attention_dismiss(id: u64, app: AppHandle, att: tauri::State<'_, Attention>) {
    let mut g = att.lock();
    let Some(pos) = g.items.iter().position(|x| x.id == id && !x.is_request()) else {
        return;
    };
    let item = g.items.remove(pos);
    if item.kind == "waiting" {
        let since = claude_dir()
            .and_then(|d| live_sessions(&d).remove(&item.session_id))
            .and_then(|r| r.status_updated_at)
            .unwrap_or(0);
        g.muted.insert(item.session_id, since);
    }
    emit(&app, &g);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// Ccboat's hook is in Claude Code's user settings.
    installed: bool,
    /// ...for the port Ccboat listens on.
    current: bool,
    listening: bool,
    port: u16,
    error: Option<String>,
    settings: String,
}

#[tauri::command]
pub fn hook_status(att: tauri::State<'_, Attention>) -> HookStatus {
    let port = hooks::port();
    let (listening, error) = {
        let g = att.lock();
        (g.listening, g.error.clone())
    };
    let path = claude_dir().map(|d| hooks::settings_path(&d));
    let (found, read_error) = match path.as_deref().map(hooks::read) {
        Some(Ok(s)) => (hooks::find(&s), None),
        Some(Err(e)) => (None, Some(e)),
        None => (None, Some("No Claude Code folder.".into())),
    };
    HookStatus {
        installed: found.is_some(),
        current: found.as_ref().is_some_and(|(url, _)| {
            url == &format!("http://127.0.0.1:{port}{}", hooks::HOOK_PATH)
        }),
        listening,
        port,
        error: error.or(read_error),
        settings: path.map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

/// Turn "answer prompts in Ccboat" on or off: add or remove Ccboat's hook.
#[tauri::command]
pub fn hook_set(on: bool, att: tauri::State<'_, Attention>) -> Result<(), String> {
    let dir = claude_dir().ok_or("No Claude Code folder.")?;
    let path = hooks::settings_path(&dir);
    let mut s = hooks::read(&path)?;
    if on {
        let token = hooks::find(&s)
            .map(|(_, t)| t)
            .filter(|t| t.len() >= 16)
            .unwrap_or_else(hooks::new_token);
        hooks::add(&mut s, hooks::port(), &token)?;
        hooks::write(&path, &s)?;
        att.lock().token = Some(token);
    } else {
        if hooks::remove(&mut s) {
            hooks::write(&path, &s)?;
        }
        att.lock().token = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(sid: &str, status: &str, at: i64) -> Registered {
        Registered {
            session_id: sid.into(),
            cwd: r"D:\work\app".into(),
            status: Some(status.into()),
            status_updated_at: Some(at),
            ..Default::default()
        }
    }

    fn request(g: &mut Inner, sid: &str) -> u64 {
        g.next += 1;
        g.items.push(Item {
            id: g.next,
            kind: "permission",
            session_id: sid.into(),
            cwd: None,
            folder: String::new(),
            title: None,
            transcript: None,
            agent_type: None,
            tool: Some("Bash".into()),
            mcp_server: None,
            input: None,
            suggestions: None,
            waiting_for: None,
            at: 0,
        });
        g.next
    }

    fn live(rs: &[Registered]) -> HashMap<String, Registered> {
        rs.iter().map(|r| (r.session_id.clone(), r.clone())).collect()
    }

    #[test]
    fn a_turn_ending_is_a_done_card_once() {
        let mut g = Inner::default();
        // Already idle when Ccboat starts: nothing to say.
        assert!(reconcile(&mut g, &live(&[reg("a", "idle", 1)])).0.is_empty());
        reconcile(&mut g, &live(&[reg("a", "busy", 2)]));
        let (adds, _) = reconcile(&mut g, &live(&[reg("a", "idle", 3)]));
        assert_eq!(adds.iter().map(|a| a.0).collect::<Vec<_>>(), ["done"]);
        assert!(reconcile(&mut g, &live(&[reg("a", "idle", 3)])).0.is_empty());
    }

    #[test]
    fn waiting_without_a_request_is_a_card_unless_dismissed() {
        let mut g = Inner::default();
        let (adds, _) = reconcile(&mut g, &live(&[reg("a", "waiting", 5)]));
        assert_eq!(adds.len(), 1);
        g.muted.insert("a".into(), 5);
        assert!(reconcile(&mut g, &live(&[reg("a", "waiting", 5)])).0.is_empty());
        // Waiting again later: it comes back.
        assert_eq!(reconcile(&mut g, &live(&[reg("a", "waiting", 9)])).0.len(), 1);
    }

    #[test]
    fn a_request_answered_in_the_terminal_is_let_go() {
        let mut g = Inner::default();
        let id = request(&mut g, "a");
        // Busy before its prompt shows: not answered yet.
        reconcile(&mut g, &live(&[reg("a", "busy", 1)]));
        assert!(!g.elsewhere.contains(&id));
        // The request covers the waiting: no second card.
        assert!(reconcile(&mut g, &live(&[reg("a", "waiting", 2)])).0.is_empty());
        reconcile(&mut g, &live(&[reg("a", "busy", 3)]));
        assert!(g.elsewhere.contains(&id));
    }

    #[test]
    fn ended_sessions_take_their_cards() {
        let mut g = Inner::default();
        reconcile(&mut g, &live(&[reg("a", "busy", 1)]));
        let (adds, _) = reconcile(&mut g, &live(&[reg("a", "idle", 2)]));
        g.items.push(Item {
            id: 9,
            kind: adds[0].0,
            session_id: "a".into(),
            cwd: None,
            folder: String::new(),
            title: None,
            transcript: None,
            agent_type: None,
            tool: None,
            mcp_server: None,
            input: None,
            suggestions: None,
            waiting_for: None,
            at: 0,
        });
        let (_, changed) = reconcile(&mut g, &live(&[]));
        assert!(changed);
        assert!(g.items.is_empty());
    }
}
