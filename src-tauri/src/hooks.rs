//! "Answer prompts in AgentBoat": the hook AgentBoat adds to Claude Code's user settings.
//!
//! Claude Code runs `PermissionRequest` hooks when it is about to ask you something (a tool's
//! permission, an `AskUserQuestion`, a plan to approve). AgentBoat's is an `http` hook: Claude Code
//! POSTs the request to AgentBoat on `127.0.0.1`, which shows it and replies with your answer. The
//! terminal shows its own prompt meanwhile; whichever you answer first counts. When AgentBoat isn't
//! running nothing answers, and Claude Code carries on as if there were no hook.
//!
//! The hook is the only thing AgentBoat ever writes outside its own folder, and only when you turn it
//! on or off. Its entry is recognised by its URL path; every other setting and hook is kept as it
//! was. Each request must carry the token written into the entry, so nothing else can post
//! prompts to AgentBoat.

use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

/// The URL path that marks AgentBoat's hook.
pub const HOOK_PATH: &str = "/agentboat/permission";
/// The header that carries the token.
pub const TOKEN_HEADER: &str = "X-AgentBoat-Token";
/// The same, from when AgentBoat was called Ccboat (up to 0.5.1). A hook written then is still
/// recognised and answered, and is rewritten to the new path on first start (see `migrate`).
pub const LEGACY_HOOK_PATH: &str = "/ccboat/permission";
pub const LEGACY_TOKEN_HEADER: &str = "X-Ccboat-Token";
pub const DEFAULT_PORT: u16 = 47821;
/// How long Claude Code waits for AgentBoat (seconds). The terminal prompt is up all along, so this
/// only bounds how long a card can stay open.
const TIMEOUT_SECS: u64 = 3600;

/// The port AgentBoat listens on: `AGENTBOAT_HOOK_PORT` (or the older `CCBOAT_HOOK_PORT`), else
/// the default.
pub fn port() -> u16 {
    std::env::var("AGENTBOAT_HOOK_PORT")
        .or_else(|_| std::env::var("CCBOAT_HOOK_PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .filter(|&p| p > 0)
        .unwrap_or(DEFAULT_PORT)
}

pub fn settings_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("settings.json")
}

fn is_ours(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("http")
        && hook
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|u| u.contains(HOOK_PATH) || u.contains(LEGACY_HOOK_PATH))
}

/// AgentBoat's hook in these settings: its URL and token.
pub fn find(settings: &Value) -> Option<(String, String)> {
    settings
        .pointer("/hooks/PermissionRequest")?
        .as_array()?
        .iter()
        .filter_map(|g| g.get("hooks")?.as_array())
        .flatten()
        .find(|h| is_ours(h))
        .map(|h| {
            let url = h.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let token = h
                .get("headers")
                .and_then(|hs| hs.get(TOKEN_HEADER).or_else(|| hs.get(LEGACY_TOKEN_HEADER)))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            (url, token)
        })
}

/// Remove AgentBoat's hook; groups left empty go, and `hooks` too if nothing is left in it.
/// Whether anything was removed.
pub fn remove(settings: &mut Value) -> bool {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(groups) = hooks.get_mut("PermissionRequest").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut removed = false;
    for g in groups.iter_mut() {
        if let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) {
            let before = hs.len();
            hs.retain(|h| !is_ours(h));
            removed |= hs.len() != before;
        }
    }
    groups.retain(|g| {
        g.get("hooks")
            .and_then(Value::as_array)
            .is_none_or(|hs| !hs.is_empty())
    });
    if groups.is_empty() {
        hooks.remove("PermissionRequest");
    }
    if hooks.is_empty()
        && let Some(obj) = settings.as_object_mut()
    {
        obj.remove("hooks");
    }
    removed
}

/// Add AgentBoat's hook (replacing an older one of its own), for every tool.
pub fn add(settings: &mut Value, port: u16, token: &str) -> Result<(), String> {
    remove(settings);
    let obj = settings
        .as_object_mut()
        .ok_or("Your settings.json isn't a JSON object.")?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("\"hooks\" in your settings.json isn't an object.")?;
    let groups = hooks
        .entry("PermissionRequest")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("\"hooks.PermissionRequest\" in your settings.json isn't a list.")?;
    groups.push(json!({
        "matcher": "*",
        "hooks": [{
            "type": "http",
            "url": format!("http://127.0.0.1:{port}{HOOK_PATH}"),
            "timeout": TIMEOUT_SECS,
            "headers": { TOKEN_HEADER: token },
        }],
    }));
    Ok(())
}

/// A hook written by Ccboat (the old URL path), rewritten as AgentBoat's with the same port and
/// token. Whether anything changed.
pub fn migrate_legacy(settings: &mut Value) -> Result<bool, String> {
    let Some((url, token)) = find(settings) else { return Ok(false) };
    if !url.contains(LEGACY_HOOK_PATH) {
        return Ok(false);
    }
    let port = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split('/').next())
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(port);
    add(settings, port, &token)?;
    Ok(true)
}

/// The settings file as JSON (`{}` when there's none). A file that doesn't parse is an error, and
/// is never written over.
pub fn read(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|e| {
            format!("Couldn't read {} ({e}), so it was left as it is.", path.display())
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

/// Write the settings back: a copy of the original is kept once as `settings.json.agentboat-backup`,
/// and the new text replaces the file in one step, so Claude Code never reads half a file.
pub fn write(path: &Path, settings: &Value) -> Result<(), String> {
    let backup = path.with_extension("json.agentboat-backup");
    if path.is_file() && !backup.exists() {
        fs::copy(path, &backup).map_err(|e| format!("Couldn't back up your settings: {e}"))?;
    }
    let mut text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_extension("json.agentboat-tmp");
    fs::write(&tmp, text).map_err(|e| format!("Couldn't write your settings: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't write your settings: {e}")
    })
}

/// A fresh random token (128 bits from the OS-seeded hasher keys).
pub fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_and_removes_only_its_own_hook() {
        let mut s = json!({
            "model": "opus",
            "hooks": {
                "PermissionRequest": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] }
                ],
                "Stop": [{ "hooks": [{ "type": "command", "command": "done.sh" }] }]
            }
        });
        add(&mut s, 47821, "tok").unwrap();
        assert_eq!(
            find(&s),
            Some(("http://127.0.0.1:47821/agentboat/permission".into(), "tok".into()))
        );
        assert_eq!(s.pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap().len(), 2);
        // Adding again replaces it rather than adding a second.
        add(&mut s, 47821, "tok2").unwrap();
        assert_eq!(s.pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(find(&s).unwrap().1, "tok2");

        assert!(remove(&mut s));
        assert_eq!(find(&s), None);
        assert_eq!(
            s.pointer("/hooks/PermissionRequest/0/hooks/0/command").unwrap(),
            "mine.sh"
        );
        assert!(s.pointer("/hooks/Stop").is_some());
        assert_eq!(s["model"], "opus");
    }

    #[test]
    fn removing_the_last_hook_tidies_up() {
        let mut s = json!({ "theme": "dark" });
        add(&mut s, 1, "t").unwrap();
        assert!(remove(&mut s));
        assert_eq!(s, json!({ "theme": "dark" }));
        assert!(!remove(&mut s));
    }

    #[test]
    fn keeps_key_order() {
        let mut s: Value = serde_json::from_str(r#"{"z":1,"a":2}"#).unwrap();
        add(&mut s, 1, "t").unwrap();
        let keys: Vec<_> = s.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["z", "a", "hooks"]);
    }

    #[test]
    fn refuses_settings_it_cant_parse() {
        let dir = std::env::temp_dir().join(format!("agentboat-hooks-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        fs::write(&p, "{ not json").unwrap();
        assert!(read(&p).is_err());
        fs::write(&p, "\u{feff}{\"a\":1}").unwrap();
        assert_eq!(read(&p).unwrap(), json!({"a":1}));
        assert_eq!(read(&dir.join("none.json")).unwrap(), json!({}));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrites_a_ccboat_hook_keeping_port_and_token() {
        let mut s = json!({
            "hooks": { "PermissionRequest": [
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "mine.sh" }] },
                { "matcher": "*", "hooks": [{
                    "type": "http",
                    "url": "http://127.0.0.1:47999/ccboat/permission",
                    "timeout": 3600,
                    "headers": { "X-Ccboat-Token": "0123456789abcdef0123" }
                }] }
            ] }
        });
        assert_eq!(find(&s).unwrap().1, "0123456789abcdef0123");
        assert!(migrate_legacy(&mut s).unwrap());
        assert_eq!(
            find(&s),
            Some(("http://127.0.0.1:47999/agentboat/permission".into(), "0123456789abcdef0123".into()))
        );
        let groups = s.pointer("/hooks/PermissionRequest").unwrap().as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], "mine.sh");
        assert!(!s.to_string().contains("ccboat") && !s.to_string().contains("Ccboat"));
        // Already AgentBoat's: nothing to do.
        assert!(!migrate_legacy(&mut s).unwrap());
        assert!(!migrate_legacy(&mut json!({})).unwrap());
    }

    #[test]
    fn tokens_differ() {
        let a = new_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, new_token());
    }
}
