//! "Open in Claude Code": take you to the session in a terminal.
//!
//! - A running session is already in a terminal (or an editor): the window hosting it is brought
//!   to the front. It is found by walking up the session's parent processes (`claude.exe` →
//!   `powershell.exe` → `WindowsTerminal.exe`) to the first one with a visible window.
//! - A finished session is resumed in a new terminal, in its folder: `claude --resume <id>`.
//!
//! Only the session id (checked to be one) and its folder (checked to exist) go into the command
//! line; nothing else from a transcript is ever run.

use agentboat_core::claude::claude_dir;
use agentboat_core::sessions::live_sessions;
use std::path::{Path, PathBuf};

/// What happened, for the UI: `focused` (its window came to the front) or `opened` (a new
/// terminal resumes it).
#[tauri::command(async)]
pub fn open_in_claude_code(id: String, cwd: Option<String>) -> Result<&'static str, String> {
    if !valid_id(&id) {
        return Err("That isn't a session id.".into());
    }
    let dir = claude_dir().ok_or("No Claude Code folder.")?;
    if let Some(reg) = live_sessions(&dir).get(&id) {
        return if focus_host_window(reg.pid) {
            Ok("focused")
        } else {
            Err("It's running, but its window couldn't be found.".into())
        };
    }
    let cwd = cwd.filter(|c| Path::new(c).is_dir()).ok_or("The session's folder is gone.")?;
    resume_in_terminal(&id, &cwd)?;
    Ok("opened")
}

/// Session ids are UUIDs: letters, digits and dashes only, so they're safe on a command line.
fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn on_path(exe: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

#[cfg(windows)]
fn resume_in_terminal(id: &str, cwd: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    // The user's shell stays open after Claude Code exits, as if they had typed the command.
    let shell = if on_path("pwsh.exe").is_some() { "pwsh.exe" } else { "powershell.exe" };
    let run = format!("claude --resume {id}");
    // Windows Terminal when it's there (`;` separates its own commands, so not with such a folder).
    if let Some(wt) = on_path("wt.exe").filter(|_| !cwd.contains(';')) {
        let spawned = Command::new(wt)
            .args(["-d", cwd, shell, "-NoExit", "-Command", &run])
            .spawn();
        if spawned.is_ok() {
            return Ok(());
        }
    }
    Command::new(shell)
        .args(["-NoExit", "-Command", &run])
        .current_dir(cwd)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open a terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn resume_in_terminal(id: &str, cwd: &str) -> Result<(), String> {
    // The folder goes in single quotes for the shell, then the whole line in an AppleScript string.
    let line = format!("cd '{}' && claude --resume {id}", cwd.replace('\'', r"'\''"));
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        line.replace('\\', r"\\").replace('"', "\\\"")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open Terminal: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn resume_in_terminal(id: &str, cwd: &str) -> Result<(), String> {
    let term = on_path("x-terminal-emulator").ok_or("No terminal program found.")?;
    std::process::Command::new(term)
        .current_dir(cwd)
        .args(["-e", "claude", "--resume", id])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open a terminal: {e}"))
}

/// Bring the window of the nearest ancestor of `pid` that has one to the front. AgentBoat is the
/// foreground app when this runs (you just clicked), so Windows lets it hand the focus on.
#[cfg(windows)]
fn focus_host_window(pid: u32) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow};
    let parents = parent_map();
    let mut p = pid;
    for _ in 0..12 {
        let Some(&(parent, ref name)) = parents.get(&p) else { break };
        // The desktop shell is everyone's ancestor; it's never the host.
        if name.eq_ignore_ascii_case("explorer.exe") {
            break;
        }
        if let Some(h) = top_window_of(p) {
            unsafe {
                if IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                return SetForegroundWindow(h).as_bool();
            }
        }
        if parent == 0 || parent == p {
            break;
        }
        p = parent;
    }
    false
}

#[cfg(not(windows))]
fn focus_host_window(_pid: u32) -> bool {
    false
}

/// Every process's parent and executable name.
#[cfg(windows)]
fn parent_map() -> std::collections::HashMap<u32, (u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut out = std::collections::HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..len]);
            out.insert(e.th32ProcessID, (e.th32ParentProcessID, name));
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// A visible, unowned top-level window of the process.
#[cfg(windows)]
fn top_window_of(pid: u32) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;
    struct Find {
        pid: u32,
        found: Option<HWND>,
    }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let f = unsafe { &mut *(l.0 as *mut Find) };
        let mut owner_pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut owner_pid)) };
        let owned = unsafe { GetWindow(h, GW_OWNER) }.is_ok_and(|o| !o.is_invalid());
        if owner_pid == f.pid && !owned && unsafe { IsWindowVisible(h) }.as_bool() {
            f.found = Some(h);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut f = Find { pid, found: None };
    unsafe {
        // Stopping early reports an "error"; what was found is what counts.
        let _ = EnumWindows(Some(each), LPARAM(&mut f as *mut Find as isize));
    }
    f.found
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn only_session_ids_pass() {
        assert!(valid_id("6df25af0-0a5b-44a6-a5b4-08fe9168b820"));
        assert!(!valid_id("x; rm -rf ~"));
        assert!(!valid_id("abc"));
        assert!(!valid_id("6df25af0 & calc"));
    }
}
