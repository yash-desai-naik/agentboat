//! "Show usage limits": what Claude Code tells its status line, kept for AgentBoat.
//!
//! Claude Code passes its status line command, on stdin, what AgentBoat can't read anywhere else: the
//! context window's size and how full it is, and the account's 5-hour and 7-day usage with when
//! each resets. With this on, Claude Code's `statusLine` runs AgentBoat itself
//! (`agentboat --statusline <dir>`): it saves that JSON as `<dir>/<session id>.json`, then runs the
//! status line you had before with the same input and passes its output back, so the terminal
//! shows what it always did.
//!
//! Turning it off puts your own `statusLine` back exactly as it was (it is kept in
//! `<dir>/original.json` meanwhile).

use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The flag that runs AgentBoat as the status line.
pub const FLAG: &str = "--statusline";
const ORIGINAL: &str = "original.json";

fn is_ours(status_line: &Value) -> bool {
    status_line
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| {
            let lc = c.to_ascii_lowercase();
            c.contains(FLAG) && (lc.contains("agentboat") || lc.contains("ccboat"))
        })
}

/// Whether the status line set is Ccboat's (AgentBoat before the rename): it runs a program the
/// move to AgentBoat uninstalls.
pub fn installed_legacy(settings: &Value) -> bool {
    settings
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|c| {
            let lc = c.to_ascii_lowercase();
            c.contains(FLAG) && lc.contains("ccboat") && !lc.contains("agentboat")
        })
}

/// Whether AgentBoat's status line is the one set.
pub fn installed(settings: &Value) -> bool {
    settings.get("statusLine").is_some_and(is_ours)
}

/// A path for a command line: forward slashes (Windows takes them, and no shell reads them as
/// escapes), in double quotes.
fn quoted(p: &Path) -> String {
    format!("\"{}\"", p.display().to_string().replace('\\', "/"))
}

pub fn command(exe: &Path, dir: &Path) -> String {
    format!("{} {FLAG} {}", quoted(exe), quoted(dir))
}

/// Put AgentBoat's status line in, keeping yours in `dir` to run and to restore. Its `padding` and
/// `refreshInterval` carry over.
pub fn add(settings: &mut Value, exe: &Path, dir: &Path) -> Result<(), String> {
    let obj = settings
        .as_object_mut()
        .ok_or("Your settings.json isn't a JSON object.")?;
    let previous = obj.get("statusLine").cloned();
    if let Some(prev) = previous.as_ref().filter(|p| !is_ours(p)) {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        fs::write(dir.join(ORIGINAL), serde_json::to_string_pretty(prev).unwrap_or_default())
            .map_err(|e| format!("Couldn't keep your status line: {e}"))?;
    } else if previous.is_none() {
        let _ = fs::remove_file(dir.join(ORIGINAL));
    }
    let mut ours = json!({ "type": "command", "command": command(exe, dir) });
    for key in ["padding", "refreshInterval"] {
        if let Some(v) = previous.as_ref().and_then(|p| p.get(key)) {
            ours[key] = v.clone();
        }
    }
    obj.insert("statusLine".into(), ours);
    Ok(())
}

/// Take AgentBoat's status line out and put yours back (or none, if you had none).
pub fn remove(settings: &mut Value, dir: &Path) -> bool {
    if !installed(settings) {
        return false;
    }
    let Some(obj) = settings.as_object_mut() else {
        return false;
    };
    match read_original(dir) {
        Some(orig) => {
            obj.insert("statusLine".into(), orig);
        }
        None => {
            obj.remove("statusLine");
        }
    }
    let _ = fs::remove_file(dir.join(ORIGINAL));
    true
}

fn read_original(dir: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(dir.join(ORIGINAL)).ok()?).ok()
}

// ---------- the status line itself ----------

/// Run as Claude Code's status line: save stdin for AgentBoat, then run the original status line
/// with it. Returns the exit code.
pub fn run(dir: &Path) -> i32 {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() {
        return 1;
    }
    save(dir, &raw);
    let Some(cmd) = read_original(dir)
        .and_then(|o| o.get("command").and_then(Value::as_str).map(str::to_string))
        .filter(|c| !c.trim().is_empty())
    else {
        return 0;
    };
    run_original(&cmd, &raw)
}

fn save(dir: &Path, raw: &[u8]) {
    let Ok(v) = serde_json::from_slice::<Value>(raw) else { return };
    let Some(id) = v.get("session_id").and_then(Value::as_str) else { return };
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || id.len() > 64 {
        return;
    }
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    // Whole files only: AgentBoat may read at any moment.
    let tmp = dir.join(format!("{id}.json.tmp"));
    if fs::write(&tmp, raw).is_ok() && fs::rename(&tmp, dir.join(format!("{id}.json"))).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// The shell Claude Code runs status lines in: on Windows Git Bash when it's installed, else
/// PowerShell; `sh` elsewhere.
fn shell() -> (PathBuf, Vec<&'static str>) {
    if cfg!(windows) {
        match git_bash() {
            Some(b) => (b, vec!["-c"]),
            None => (PathBuf::from("powershell.exe"), vec!["-NoProfile", "-Command"]),
        }
    } else {
        (PathBuf::from("/bin/sh"), vec!["-c"])
    }
}

/// Git for Windows' bash: `CLAUDE_CODE_GIT_BASH_PATH`, beside `git.exe` on the PATH, or in the
/// usual install folders.
fn git_bash() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Some(p);
    }
    // `Git\cmd\git.exe`, `Git\bin\git.exe` or `Git\mingw64\bin\git.exe`: bash is in `Git\bin`.
    let beside_git = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .filter(|d| d.join("git.exe").is_file())
            .flat_map(|d| {
                d.ancestors()
                    .take(3)
                    .map(|a| a.join("bin").join("bash.exe"))
                    .collect::<Vec<_>>()
            })
            .find(|p| p.is_file())
    });
    beside_git.or_else(|| {
        ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"].iter().find_map(|v| {
            let base = PathBuf::from(std::env::var_os(v)?);
            [base.join("Git"), base.join("Programs").join("Git")]
                .into_iter()
                .map(|g| g.join("bin").join("bash.exe"))
                .find(|p| p.is_file())
        })
    })
}

fn run_original(cmd: &str, raw: &[u8]) -> i32 {
    use std::process::{Command, Stdio};
    let (sh, flags) = shell();
    let mut c = Command::new(sh);
    c.args(flags).arg(cmd).stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = c.spawn() else { return 1 };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(raw);
    }
    child.wait().ok().and_then(|s| s.code()).unwrap_or(1)
}

// ---------- reading the snapshots ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cap {
    pub used_pct: f64,
    /// Unix ms.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The session's context window, in tokens.
    pub window: Option<u64>,
    /// How full Claude Code said it was.
    pub context_pct: Option<f64>,
    pub effort: Option<String>,
    pub five_hour: Option<Cap>,
    pub seven_day: Option<Cap>,
    /// When the limits were reported (Unix ms).
    pub limits_at: Option<i64>,
    /// Context window sizes seen per model id, for sessions without a snapshot of their own.
    pub model_windows: Vec<(String, u64)>,
}

fn ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `resets_at` as Unix ms, whether it came as seconds, ms or an ISO time.
fn when(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => {
            let x = n.as_f64()?;
            Some(if x < 1e11 { (x * 1000.0) as i64 } else { x as i64 })
        }
        Value::String(s) => crate::time::parse_iso_ms(s),
        _ => None,
    }
}

fn cap(v: Option<&Value>) -> Option<Cap> {
    let v = v?;
    let used = v
        .get("used_percentage")
        .or_else(|| v.get("utilization"))
        .and_then(Value::as_f64)?;
    Some(Cap { used_pct: used, resets_at: v.get("resets_at").and_then(when) })
}

/// The open session's context window, and the account's limits from the newest snapshot of any
/// session (they are account-wide). Snapshots older than a week are cleared away.
pub fn read(dir: &Path, session: Option<&str>) -> Usage {
    let mut out = Usage::default();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let mut files: Vec<(PathBuf, SystemTime)> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json") && e.file_name() != ORIGINAL)
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .collect();
    files.sort_by_key(|a| std::cmp::Reverse(a.1));
    let week = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
    for (path, mtime) in files {
        if mtime < week {
            let _ = fs::remove_file(&path);
            continue;
        }
        let mine = session.is_some_and(|s| path.file_stem().is_some_and(|f| f == s));
        let Ok(v) = fs::read_to_string(&path).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) else {
            continue;
        };
        if let (Some(model), Some(size)) = (
            v.pointer("/model/id").and_then(Value::as_str),
            v.pointer("/context_window/context_window_size").and_then(Value::as_u64),
        ) && !out.model_windows.iter().any(|(m, _)| m == model)
        {
            out.model_windows.push((model.to_string(), size));
        }
        if mine {
            let cw = v.get("context_window");
            out.window = cw.and_then(|c| c.get("context_window_size")).and_then(Value::as_u64);
            out.context_pct = cw.and_then(|c| c.get("used_percentage")).and_then(Value::as_f64);
            out.effort = v
                .pointer("/effort/level")
                .or_else(|| v.get("effort"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if out.limits_at.is_none() && let Some(rl) = v.get("rate_limits") {
            out.five_hour = cap(rl.get("five_hour"));
            out.seven_day = cap(rl.get("seven_day"));
            if out.five_hour.is_some() || out.seven_day.is_some() {
                out.limits_at = Some(ms(mtime));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agentboat-sl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn swaps_in_and_restores_your_status_line() {
        let dir = tmp("swap");
        let exe = Path::new(r"C:\Users\Jane Doe\AppData\Local\AgentBoat\agentboat.exe");
        let mine = json!({ "type": "command", "command": "bash ~/.claude/sl.sh", "padding": 0 });
        let mut s = json!({ "theme": "dark", "statusLine": mine.clone() });
        add(&mut s, exe, &dir).unwrap();
        assert!(installed(&s));
        let cmd = s["statusLine"]["command"].as_str().unwrap();
        assert!(cmd.starts_with("\"C:/Users/Jane Doe/AppData/Local/AgentBoat/agentboat.exe\" --statusline \""));
        assert_eq!(s["statusLine"]["padding"], 0);
        // Turning it on twice doesn't lose yours.
        add(&mut s, exe, &dir).unwrap();
        assert!(remove(&mut s, &dir));
        assert_eq!(s, json!({ "theme": "dark", "statusLine": mine }));
        assert!(!remove(&mut s, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ccboat_status_line_is_taken_over_keeping_yours() {
        let dir = tmp("legacy");
        let mine = json!({ "type": "command", "command": "bash ~/.claude/sl.sh" });
        fs::write(dir.join(ORIGINAL), mine.to_string()).unwrap();
        let mut s = json!({ "statusLine": {
            "type": "command",
            "command": "\"C:/Users/Jane/AppData/Local/Ccboat/ccboat.exe\" --statusline \"C:/Users/Jane/AppData/Local/app.ccboat/statusline\"",
            "padding": 1
        } });
        assert!(installed(&s) && installed_legacy(&s));
        add(&mut s, Path::new(r"C:\Users\Jane\AppData\Local\AgentBoat\agentboat.exe"), &dir).unwrap();
        assert!(installed(&s) && !installed_legacy(&s));
        assert!(s["statusLine"]["command"].as_str().unwrap().contains("AgentBoat/agentboat.exe"));
        assert_eq!(s["statusLine"]["padding"], 1);
        // The status line you had before Ccboat's is still the one put back.
        assert!(remove(&mut s, &dir));
        assert_eq!(s, json!({ "statusLine": mine }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn none_before_means_none_after() {
        let dir = tmp("none");
        let mut s = json!({});
        add(&mut s, Path::new("/opt/agentboat"), &dir).unwrap();
        assert!(remove(&mut s, &dir));
        assert_eq!(s, json!({}));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_window_effort_and_limits() {
        let dir = tmp("read");
        save(
            &dir,
            br#"{"session_id":"aaa-1","effort":{"level":"high"},"context_window":{"context_window_size":1000000,"used_percentage":24.5},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1795080000},"seven_day":{"used_percentage":41.2,"resets_at":"2026-11-21T10:30:00Z"}}}"#,
        );
        save(&dir, br#"{"session_id":"../evil","rate_limits":{}}"#);
        let u = read(&dir, Some("aaa-1"));
        assert_eq!(u.window, Some(1_000_000));
        assert_eq!(u.context_pct, Some(24.5));
        assert_eq!(u.effort.as_deref(), Some("high"));
        assert_eq!(u.five_hour, Some(Cap { used_pct: 12.0, resets_at: Some(1_795_080_000_000) }));
        assert_eq!(u.seven_day.as_ref().unwrap().used_pct, 41.2);
        assert!(u.seven_day.unwrap().resets_at.is_some());
        // Another session: the limits still show, its window doesn't.
        let other = read(&dir, Some("bbb"));
        assert_eq!(other.window, None);
        assert!(other.model_windows.is_empty(), "no model id in this sample");
        assert!(other.five_hour.is_some());
        assert!(!dir.join("../evil.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
