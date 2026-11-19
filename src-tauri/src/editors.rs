//! "Open in VS Code / Zed": the editors installed on this machine, and opening a session's
//! folder, or a file at a line, in one of them.
//!
//! Only editors that are found are offered. Paths must be absolute and exist, so nothing from a
//! transcript can pass for an option (`--something`), and the editor is started directly, never
//! through a shell.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Editor {
    id: &'static str,
    name: &'static str,
}

struct Found {
    id: &'static str,
    name: &'static str,
    exe: PathBuf,
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

#[cfg(windows)]
fn find() -> Vec<Found> {
    let dirs: Vec<PathBuf> = ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
        .map(|d| if d.ends_with("Local") { d.join("Programs") } else { d })
        .collect();
    let first = |rel: &[&str]| -> Option<PathBuf> {
        dirs.iter().find_map(|d| {
            let p = rel.iter().fold(d.clone(), |p, s| p.join(s));
            p.is_file().then_some(p)
        })
    };
    let mut out = Vec::new();
    // VS Code: Code.exe takes paths and --goto like its `code` script does.
    let code = first(&["Microsoft VS Code", "Code.exe"]).or_else(|| {
        on_path(&["code.cmd"]).and_then(|c| Some(c.parent()?.parent()?.join("Code.exe")).filter(|p| p.is_file()))
    });
    if let Some(exe) = code {
        out.push(Found { id: "vscode", name: "VS Code", exe });
    }
    // Zed: its command-line launcher (bin\zed.exe), which opens `path:line`.
    let zed = first(&["Zed", "bin", "zed.exe"]).or_else(|| on_path(&["zed.exe"]));
    if let Some(exe) = zed {
        out.push(Found { id: "zed", name: "Zed", exe });
    }
    out
}

#[cfg(target_os = "macos")]
fn find() -> Vec<Found> {
    let mut out = Vec::new();
    for (id, name, app) in [("vscode", "VS Code", "Visual Studio Code.app"), ("zed", "Zed", "Zed.app")] {
        let home_apps = dirs::home_dir().map(|h| h.join("Applications").join(app));
        if let Some(p) = [Some(PathBuf::from("/Applications").join(app)), home_apps].into_iter().flatten().find(|p| p.exists()) {
            out.push(Found { id, name, exe: p });
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn find() -> Vec<Found> {
    let mut out = Vec::new();
    if let Some(exe) = on_path(&["code"]) {
        out.push(Found { id: "vscode", name: "VS Code", exe });
    }
    if let Some(exe) = on_path(&["zed", "zeditor"]) {
        out.push(Found { id: "zed", name: "Zed", exe });
    }
    out
}

/// The editors installed here (VS Code, Zed), in that order.
#[tauri::command(async)]
pub fn editors() -> Vec<Editor> {
    find().into_iter().map(|f| Editor { id: f.id, name: f.name }).collect()
}

/// Open `path` (a folder, or a file at `line`) in an editor; a file opens inside `root`, the
/// session's folder, so the editor shows it in its project.
#[tauri::command(async)]
pub fn open_in_editor(editor: String, path: String, line: Option<u32>, root: Option<String>) -> Result<(), String> {
    let found = find().into_iter().find(|f| f.id == editor).ok_or("That editor isn't installed.")?;
    let target = Path::new(&path);
    if !target.is_absolute() || !target.exists() {
        return Err("That file or folder isn't on this computer any more.".into());
    }
    let root = root
        .map(PathBuf::from)
        .filter(|r| r.is_absolute() && r.is_dir() && target.is_file() && target.starts_with(r));
    let at = match line.filter(|&l| l > 0) {
        Some(l) => format!("{path}:{l}"),
        None => path.clone(),
    };
    let mut args: Vec<String> = Vec::new();
    if let Some(r) = &root {
        args.push(r.display().to_string());
    }
    if target.is_dir() {
        args.push(path.clone());
    } else if found.id == "vscode" {
        args.push("--goto".into());
        args.push(at);
    } else {
        args.push(at);
    }
    spawn(&found, &args).map_err(|e| format!("Couldn't start {}: {e}", found.name))
}

#[cfg(windows)]
fn spawn(f: &Found, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // Zed's launcher is a console program: no console window for it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(&f.exe).args(args).creation_flags(CREATE_NO_WINDOW).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn(f: &Found, args: &[String]) -> std::io::Result<()> {
    // `open -a` hands the paths to the app; a line isn't passed this way, so only the path is.
    let paths: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with("--"))
        .map(|a| a.rsplit_once(':').filter(|(_, l)| l.parse::<u32>().is_ok()).map(|(p, _)| p).unwrap_or(a))
        .collect();
    std::process::Command::new("open").arg("-a").arg(&f.exe).args(paths).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn(f: &Found, args: &[String]) -> std::io::Result<()> {
    std::process::Command::new(&f.exe).args(args).spawn().map(|_| ())
}
