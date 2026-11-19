//! Moving in from Ccboat, AgentBoat's name up to 0.5.1. Ccboat's last update installs AgentBoat
//! beside it (a new name is a new install for Windows), so on its first start AgentBoat:
//!
//! 1. copies Ccboat's data folder (`app.ccboat`: view settings, the last session, the status line
//!    snapshots and the status line you had before) into its own, before the window opens, so the
//!    WebView finds its settings where it looks for them;
//! 2. rewrites what Ccboat put in Claude Code's `settings.json`: the "answer prompts" hook (same
//!    port and token, new path) and the "usage limits" status line (which ran `ccboat.exe`);
//! 3. on Windows, removes the old install with its own uninstaller (silently; Ccboat's data folder
//!    is left alone) and puts AgentBoat's shortcuts where Ccboat's were.
//!
//! Each step is safe to repeat, and it all runs once: a marker file in AgentBoat's data folder
//! says it's done. Debug builds skip it unless `AGENTBOAT_MIGRATE=1`, so a development build never
//! points your settings at itself.

use crate::claude::claude_dir;
use crate::{hooks, statusline};
use std::fs;
use std::path::Path;

const OLD_ID: &str = "app.ccboat";
/// Must match `identifier` in tauri.conf.json (checked by a test).
const NEW_ID: &str = "app.agentboat";
const MARKER: &str = ".moved-from-ccboat";

/// WebView caches: rebuilt on demand, so not worth copying.
const SKIP: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Crashpad",
    "lockfile",
    "LOCK",
];

pub fn run() {
    if cfg!(debug_assertions) && std::env::var_os("AGENTBOAT_MIGRATE").is_none() {
        return;
    }
    let Some(local) = dirs::data_local_dir() else { return };
    let new_dir = local.join(NEW_ID);
    if new_dir.join(MARKER).exists() {
        return;
    }
    let old_dir = local.join(OLD_ID);
    if old_dir.is_dir() && !new_dir.exists() {
        copy_dir(&old_dir, &new_dir);
    }
    move_claude_settings(&new_dir);
    #[cfg(windows)]
    {
        let local = local.clone();
        std::thread::spawn(move || windows_install::replace_old_install(&local));
    }
    let _ = fs::create_dir_all(&new_dir);
    let _ = fs::write(new_dir.join(MARKER), "Moved in from Ccboat (app.ccboat).\n");
}

/// Copy a folder's contents, leaving out caches; a file that can't be copied is skipped.
fn copy_dir(from: &Path, to: &Path) {
    let Ok(rd) = fs::read_dir(from) else { return };
    if fs::create_dir_all(to).is_err() {
        return;
    }
    for e in rd.flatten() {
        let name = e.file_name();
        if SKIP.iter().any(|s| name == *s) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let dest = to.join(&name);
        if ft.is_dir() {
            copy_dir(&e.path(), &dest);
        } else if ft.is_file() {
            let _ = fs::copy(e.path(), &dest);
        }
    }
}

/// Point Ccboat's hook and status line in Claude Code's settings at AgentBoat.
fn move_claude_settings(new_dir: &Path) {
    let Some(claude) = claude_dir() else { return };
    let path = hooks::settings_path(&claude);
    // A settings file that doesn't parse is never written over.
    let Ok(mut s) = hooks::read(&path) else { return };
    let mut changed = hooks::migrate_legacy(&mut s).unwrap_or(false);
    if statusline::installed_legacy(&s)
        && let Ok(exe) = std::env::current_exe()
        && statusline::add(&mut s, &exe, &new_dir.join("statusline")).is_ok()
    {
        changed = true;
    }
    if changed {
        let _ = hooks::write(&path, &s);
    }
}

#[cfg(windows)]
mod windows_install {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Uninstall Ccboat (per-user install in `%LOCALAPPDATA%\Ccboat`) and give AgentBoat the
    /// Start menu and desktop shortcuts Ccboat had. The installer, run as an update, makes none.
    pub fn replace_old_install(local: &Path) {
        let Ok(exe) = std::env::current_exe() else { return };
        let old_install = local.join("Ccboat");
        let uninstaller = old_install.join("uninstall.exe");
        let start_menu = dirs::data_dir()
            .map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs"));
        let desktop = dirs::desktop_dir();
        let had_desktop = desktop.as_ref().is_some_and(|d| d.join("Ccboat.lnk").exists());

        if uninstaller.is_file() && !exe.starts_with(&old_install) {
            // /S: silent. Its "delete app data" box is unticked, so app.ccboat stays.
            let _ = Command::new(&uninstaller)
                .arg("/S")
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        // Always a Start menu entry; a desktop one only if Ccboat had one.
        let wanted = [Some(start_menu), had_desktop.then_some(desktop)];
        for dir in wanted.into_iter().flatten().flatten() {
            let lnk = dir.join("AgentBoat.lnk");
            if dir.is_dir() && !lnk.exists() {
                shortcut(&lnk, &exe);
            }
        }
    }

    fn ps_quote(p: &Path) -> String {
        format!("'{}'", p.display().to_string().replace('\'', "''"))
    }

    fn shortcut(lnk: &Path, target: &Path) {
        let dir = target.parent().unwrap_or(target);
        let script = format!(
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({}); $s.TargetPath = {}; \
             $s.WorkingDirectory = {}; $s.Description = 'AgentBoat'; $s.Save()",
            ps_quote(lnk),
            ps_quote(target),
            ps_quote(dir)
        );
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_the_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
    }

    #[test]
    fn copies_data_but_not_caches() {
        let base = std::env::temp_dir().join(format!("agentboat-mig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (old, new) = (base.join("old"), base.join("new"));
        let ls = old.join("EBWebView/Default/Local Storage/leveldb");
        fs::create_dir_all(&ls).unwrap();
        fs::write(ls.join("000003.log"), "settings").unwrap();
        fs::create_dir_all(old.join("EBWebView/Default/Cache")).unwrap();
        fs::write(old.join("EBWebView/Default/Cache/x"), "junk").unwrap();
        fs::create_dir_all(old.join("statusline")).unwrap();
        fs::write(old.join("statusline/original.json"), "{}").unwrap();
        copy_dir(&old, &new);
        assert!(new.join("EBWebView/Default/Local Storage/leveldb/000003.log").is_file());
        assert!(new.join("statusline/original.json").is_file());
        assert!(!new.join("EBWebView/Default/Cache").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
