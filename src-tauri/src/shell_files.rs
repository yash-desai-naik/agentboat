//! Files a shell command writes, copies, moves or deletes, so Explorer and Source Control show
//! work done from the terminal (`cat > f <<'EOF'`, `cp`, `rm`, `Set-Content`…), not only work done
//! with Claude's file tools.
//!
//! Like git recognition, this reads commands the way Claude writes them, not as a full shell: it
//! follows `cd` within the command, strips heredoc bodies before tokenizing (keeping them as the
//! written content), and skips anything it can't resolve (`$VAR` paths, `/dev/null`). What a
//! script does inside (`python - <<'EOF'` editing a file) can't be seen from the command line.

use crate::git::split_words;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileOp {
    /// Absolute, in the platform's style (`D:\p\a.rs` on Windows).
    pub path: String,
    /// `write` (created or replaced), `append`, `edit` (in place), `touch`, `delete`, or `read`
    /// (`cat`, `sed -n 'X,Yp'`, `head`, `grep … file`: the command looks at the file).
    pub op: &'static str,
    /// What was written, when the command says (a heredoc or an `echo`).
    #[serde(skip)]
    pub content: Option<String>,
    /// Whether `content` is known (the UI opens such files in the editor).
    pub has_content: bool,
    /// For a read, the first line it looks at, when the command says (`sed -n '86,480p'` → 86).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// A read that is the whole command (`sed -n`, `cat`, `head`, `Get-Content`, perhaps after a
    /// `cd`): what it printed is the file's text from `line`, so the file can be shown.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
}

/// The file operations in a command run with working folder `cwd`.
pub fn parse(command: &str, cwd: &str) -> Vec<FileOp> {
    let (text, bodies) = strip_heredocs(command);
    let words = split_words(&text);
    let mut out: Vec<FileOp> = Vec::new();
    let mut cwd = normalize(cwd);
    let mut heredoc = 0usize;
    let mut seg: Vec<&str> = Vec::new();
    // The commands run (not counting `cd`), to tell a command that only reads a file.
    let mut commands: Vec<String> = Vec::new();
    let mut flush = |seg: &mut Vec<&str>, cwd: &mut String, heredoc: &mut usize| {
        if !seg.is_empty() {
            let first = seg.iter().find(|w| !is_assignment(w)).map(|w| w.to_ascii_lowercase()).unwrap_or_default();
            if !matches!(first.as_str(), "cd" | "pushd" | "set-location") {
                commands.push(first);
            }
            segment(seg, cwd, &bodies, heredoc, &mut out);
            seg.clear();
        }
    };
    for w in &words {
        match w.as_str() {
            "&&" | "||" | ";" | "|" | "(" | ")" | "&" => flush(&mut seg, &mut cwd, &mut heredoc),
            _ => seg.push(w),
        }
    }
    flush(&mut seg, &mut cwd, &mut heredoc);
    // One entry per file: its last operation (a write then an append is still a write).
    let mut merged: Vec<FileOp> = Vec::new();
    for op in out {
        match merged.iter_mut().find(|m| same_path(&m.path, &op.path)) {
            Some(m) => {
                // Reading a file doesn't change what was done to it; a change after a read wins.
                if op.op == "read" {
                    if m.op == "read" && m.line.is_none() {
                        m.line = op.line;
                    }
                    continue;
                }
                if !(m.op == "write" && matches!(op.op, "append" | "edit" | "touch")) {
                    m.op = op.op;
                    m.line = None;
                }
                if op.content.is_some() {
                    m.content = match (&m.content, op.op) {
                        (Some(prev), "append") => Some(format!("{prev}{}", op.content.unwrap_or_default())),
                        _ => op.content,
                    };
                }
            }
            None => merged.push(op),
        }
    }
    for m in &mut merged {
        m.has_content = m.content.is_some();
    }
    if merged.len() == 1
        && merged[0].op == "read"
        && commands.len() == 1
        && matches!(commands[0].as_str(), "sed" | "cat" | "head" | "get-content" | "gc" | "type" | "nl")
    {
        merged[0].exact = true;
    }
    merged
}

/// One simple command (between `&&`, `;`, `|`…).
fn segment(seg: &[&str], cwd: &mut String, bodies: &[String], heredoc: &mut usize, out: &mut Vec<FileOp>) {
    // Leading `VAR=x`, `sudo`, `time`, `command`.
    let mut i = 0;
    while i < seg.len() && (is_assignment(seg[i]) || matches!(seg[i], "sudo" | "time" | "command" | "exec")) {
        i += 1;
    }
    let args = &seg[i..];
    let Some(&cmd) = args.first() else { return };
    let cmd_lower = cmd.to_ascii_lowercase();
    let has_heredoc = args.iter().any(|a| a.starts_with("<<") && !a.starts_with("<<<"));
    let body = if has_heredoc {
        let b = bodies.get(*heredoc).cloned();
        *heredoc += 1;
        b
    } else {
        None
    };

    // Redirections: `> f`, `>> f`, `>f`, `1> f` (never stderr or a descriptor).
    let mut k = 1;
    while k < args.len() {
        let a = args[k];
        let (append, target) = match a {
            ">" | "1>" => (false, args.get(k + 1).copied()),
            ">>" | "1>>" => (true, args.get(k + 1).copied()),
            _ if a.starts_with(">>") && a.len() > 2 => (true, Some(&a[2..])),
            _ if a.starts_with('>') && a.len() > 1 && !a.starts_with(">&") => (false, Some(&a[1..])),
            _ => {
                k += 1;
                continue;
            }
        };
        if let Some(t) = target
            && let Some(path) = resolve(t, cwd)
        {
            let content = if matches!(cmd, "cat" | "tee") {
                body.clone()
            } else if cmd == "echo" || cmd == "printf" {
                let words: Vec<&str> = args[1..k].iter().copied().filter(|w| !w.starts_with('-')).collect();
                Some(format!("{}\n", words.join(" ")))
            } else {
                None
            };
            out.push(FileOp {
                path,
                op: if append { "append" } else { "write" },
                content,
                has_content: false,
                line: None,
                exact: false,
            });
        }
        k += 2;
    }

    let positional: Vec<&str> = args[1..]
        .iter()
        .copied()
        .take_while(|a| !a.starts_with('>') && !a.starts_with("<<") && !a.starts_with("1>") && !a.starts_with("2>"))
        .filter(|a| !a.starts_with('-'))
        .collect();
    let flags: Vec<&str> = args[1..].iter().copied().filter(|a| a.starts_with('-')).collect();
    let mut push = |p: &str, op: &'static str, content: Option<String>| {
        if let Some(path) = resolve(p, cwd) {
            out.push(FileOp { path, op, content, has_content: false, line: None, exact: false });
        }
    };
    // A command that looks at a file (only names that are files: with an extension).
    let read = |p: &str, line: Option<u32>, out: &mut Vec<FileOp>, cwd: &str| {
        if !has_ext(p) {
            return;
        }
        if let Some(path) = resolve(p, cwd) {
            out.push(FileOp { path, op: "read", content: None, has_content: false, line, exact: false });
        }
    };

    match cmd_lower.as_str() {
        "cd" | "set-location" | "pushd" => {
            if let Some(dir) = positional.first().and_then(|d| resolve(d, cwd)) {
                *cwd = dir;
            }
        }
        "touch" | "new-item" if !(cmd_lower == "new-item" && flags_value(args, "-itemtype").is_some_and(|v| v.eq_ignore_ascii_case("directory"))) => {
            let paths = if cmd_lower == "new-item" { ps_paths(args, &["-path", "-name"]) } else { positional.clone() };
            for p in paths {
                push(p, if cmd_lower == "touch" { "touch" } else { "write" }, None);
            }
        }
        "tee" => {
            let append = flags.iter().any(|f| *f == "-a" || *f == "--append");
            for p in positional {
                push(p, if append { "append" } else { "write" }, body.clone());
            }
        }
        "rm" | "del" | "unlink" | "remove-item" | "ri" => {
            // A recursive delete is a folder (or many files): not shown file by file.
            let recursive = flags.iter().any(|f| f.contains('r') && !f.starts_with("--f")) || flags.iter().any(|f| f.eq_ignore_ascii_case("-recurse"));
            if !recursive {
                let paths = if cmd_lower == "remove-item" || cmd_lower == "ri" { ps_paths(args, &["-path", "-literalpath"]) } else { positional };
                for p in paths {
                    push(p, "delete", None);
                }
            }
        }
        "cp" | "mv" | "copy-item" | "move-item" | "cpi" | "mi" => {
            let ps_cmd = cmd_lower.contains('-') || cmd_lower == "cpi" || cmd_lower == "mi";
            let moving = cmd_lower == "mv" || cmd_lower == "move-item" || cmd_lower == "mi";
            let recursive = flags.iter().any(|f| *f == "-r" || *f == "-R" || f.starts_with("-a") || *f == "--recursive" || f.eq_ignore_ascii_case("-recurse"));
            let (srcs, dest): (Vec<&str>, Option<&str>) = if ps_cmd {
                let src = ps_paths(args, &["-path", "-literalpath"]);
                let dest = flags_value(args, "-destination").or_else(|| positional.get(1).copied());
                (src.into_iter().take(1).collect(), dest)
            } else if positional.len() >= 2 {
                (positional[..positional.len() - 1].to_vec(), positional.last().copied())
            } else {
                (Vec::new(), None)
            };
            let Some(dest) = dest else { return };
            if recursive && !moving {
                return; // A folder copy: its files aren't listed in the command.
            }
            let dest_is_dir = srcs.len() > 1 || dest.ends_with('/') || dest.ends_with('\\') || dest == "." || dest == ".." || (!has_ext(dest) && srcs.iter().all(|s| has_ext(s)));
            for s in srcs {
                let target = if dest_is_dir { format!("{}/{}", dest.trim_end_matches(['/', '\\']), base(s)) } else { dest.to_string() };
                if !has_ext(&target) && !has_ext(s) && recursive {
                    continue;
                }
                push(&target, "write", None);
                if moving {
                    push(s, "delete", None);
                }
            }
        }
        "sed" if flags.iter().any(|f| f.starts_with("-i") || *f == "--in-place") => {
            let has_e = flags.iter().any(|f| *f == "-e");
            // Without -e, the first positional argument is the script.
            for p in positional.iter().skip(if has_e { 0 } else { 1 }) {
                push(p, "edit", None);
            }
        }
        "cat" | "bat" | "less" | "more" | "nl" => {
            for p in &positional {
                read(p, Some(1), out, cwd);
            }
        }
        "head" | "tail" => {
            // `head -n 40 file`, `head -40 file`: numbers are counts, not files.
            for p in positional.iter().filter(|p| !p.chars().all(|c| c.is_ascii_digit() || c == '+')) {
                read(p, if cmd_lower == "head" { Some(1) } else { None }, out, cwd);
            }
        }
        "sed" if flags.iter().any(|f| *f == "-n") && !flags.iter().any(|f| f.starts_with("-i")) => {
            // `sed -n '86,480p' file`: the script, then the files; the script's first number is
            // where the reading starts.
            let has_e = flags.iter().any(|f| *f == "-e");
            let script = if has_e { flags_value(args, "-e") } else { positional.first().copied() };
            let line = script.and_then(|s| {
                let d: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
                d.parse::<u32>().ok()
            });
            for p in positional.iter().skip(if has_e { 0 } else { 1 }) {
                read(p, line, out, cwd);
            }
        }
        "grep" | "rg" | "egrep" | "fgrep" | "findstr" if !flags.iter().any(|f| f.starts_with("-r") || f.starts_with("-R") || *f == "--recursive") || cmd_lower == "rg" => {
            // The pattern, then the files (directories and globs are searches, not reads).
            let pattern_from_flag = flags.iter().any(|f| *f == "-e" || *f == "-f");
            for p in positional.iter().skip(if pattern_from_flag { 0 } else { 1 }) {
                read(p, None, out, cwd);
            }
        }
        "get-content" | "gc" | "type" => {
            let paths = if cmd_lower == "type" { positional.clone() } else { ps_paths(args, &["-path", "-literalpath"]) };
            for p in paths {
                read(p, Some(1), out, cwd);
            }
        }
        "set-content" | "add-content" | "out-file" | "sc" | "ac" => {
            let op = if cmd_lower == "add-content" || cmd_lower == "ac" || flags.iter().any(|f| f.eq_ignore_ascii_case("-append")) { "append" } else { "write" };
            for p in ps_paths(args, &["-path", "-filepath", "-literalpath"]) {
                push(p, op, None);
            }
        }
        _ => {}
    }
}

/// PowerShell: the value of a named parameter, else the first positional argument.
fn ps_paths<'a>(args: &[&'a str], names: &[&str]) -> Vec<&'a str> {
    for n in names {
        if let Some(v) = flags_value(args, n) {
            return vec![v];
        }
    }
    let mut k = 1;
    while k < args.len() {
        let a = args[k];
        if a.starts_with('-') {
            // A switch or a named parameter with its value.
            let takes_value = !matches!(a.to_ascii_lowercase().as_str(), "-force" | "-recurse" | "-append" | "-nonewline" | "-confirm:$false" | "-whatif");
            k += if takes_value { 2 } else { 1 };
            continue;
        }
        if a.starts_with('>') || a.starts_with('|') {
            break;
        }
        return vec![a];
    }
    Vec::new()
}

fn flags_value<'a>(args: &[&'a str], name: &str) -> Option<&'a str> {
    let k = args.iter().position(|a| a.eq_ignore_ascii_case(name))?;
    args.get(k + 1).copied().filter(|v| !v.starts_with('-'))
}

fn is_assignment(w: &str) -> bool {
    match w.find('=') {
        Some(i) if i > 0 => w[..i].chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        _ => false,
    }
}

fn has_ext(p: &str) -> bool {
    let b = base(p);
    match b.rfind('.') {
        Some(i) => i + 1 < b.len(),
        None => false,
    }
}

fn base(p: &str) -> &str {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p)
}

/// Heredoc bodies taken out of a command, in order, and the command without them.
fn strip_heredocs(cmd: &str) -> (String, Vec<String>) {
    let mut text = String::new();
    let mut bodies = Vec::new();
    let mut lines = cmd.split('\n').peekable();
    while let Some(line) = lines.next() {
        text.push_str(line);
        text.push('\n');
        // Every heredoc started on this line, in order (`cat <<A > a; cat <<B > b` is rare).
        let mut rest = line;
        let mut tags = Vec::new();
        while let Some(i) = rest.find("<<") {
            let after = &rest[i + 2..];
            if after.starts_with('<') {
                rest = &after[1..];
                continue;
            }
            let after = after.trim_start_matches('-').trim_start();
            let tag: String = after
                .trim_start_matches(['\'', '"'])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !tag.is_empty() {
                tags.push(tag);
            }
            rest = after;
        }
        for tag in tags {
            let mut body = String::new();
            for l in lines.by_ref() {
                if l.trim() == tag {
                    break;
                }
                body.push_str(l);
                body.push('\n');
            }
            bodies.push(body);
        }
    }
    (text, bodies)
}

fn same_path(a: &str, b: &str) -> bool {
    crate::timeline::path_key(a) == crate::timeline::path_key(b)
}

/// A folder in one style: forward slashes, Git Bash drives (`/d/x`) as `D:/x`, no trailing slash.
fn normalize(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    let b = s.as_bytes();
    if cfg!(windows) && b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
        s = format!("{}:{}", (b[1] as char).to_ascii_uppercase(), &s[2..]);
        if s.len() == 2 {
            s.push('/');
        }
    }
    if s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.pop();
    }
    s
}

/// `t` relative to `cwd`, made absolute and tidy, in the platform's style; `None` for what can't
/// be a project file (`/dev/null`, `$VAR/x`, `nul`).
fn resolve(t: &str, cwd: &str) -> Option<String> {
    let t = t.trim();
    if t.is_empty() || t.contains('$') || t.contains('*') || t.contains('`') || t.starts_with('&') {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "/dev/null" || lower == "nul" || lower == "$null" || lower.starts_with("/dev/") || lower.starts_with("/proc/") {
        return None;
    }
    let mut p = normalize(t);
    if let Some(rest) = p.strip_prefix('~') {
        let home = dirs::home_dir()?.to_string_lossy().replace('\\', "/");
        p = format!("{home}{rest}");
    }
    let absolute = p.starts_with('/') || (p.len() >= 2 && p.as_bytes()[1] == b':');
    if !absolute {
        if cwd.is_empty() {
            return None;
        }
        p = format!("{}/{}", cwd.trim_end_matches('/'), p);
    }
    // Tidy `.` and `..`.
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "." => {}
            "" if !parts.is_empty() => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    let joined = if p.starts_with('/') && !joined.starts_with('/') { format!("/{joined}") } else { joined };
    Some(if cfg!(windows) && joined.as_bytes().get(1) == Some(&b':') { joined.replace('/', "\\") } else { joined })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(cmd: &str, cwd: &str) -> Vec<(String, &'static str)> {
        parse(cmd, cwd)
            .into_iter()
            .map(|o| (o.path.replace('\\', "/"), o.op))
            .collect()
    }

    #[test]
    fn heredoc_writes_with_content() {
        let cmd = "cd /d/projects/ccboat && cat > package.json <<'EOF'\n{\n  \"name\": \"x\"\n}\nEOF\ncat > vite.config.ts <<'EOF'\nexport default 1;\nEOF\nnpm install";
        let got = parse(cmd, "D:\\projects\\ccboat");
        if cfg!(windows) {
            assert_eq!(got[0].path, "D:\\projects\\ccboat\\package.json");
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].op, "write");
        assert_eq!(got[0].content.as_deref(), Some("{\n  \"name\": \"x\"\n}\n"));
        assert_eq!(got[1].content.as_deref(), Some("export default 1;\n"));
        assert!(got[0].has_content);
        assert!(!parse("cp ../a/tsconfig.json .", "/proj")[0].has_content);
    }

    #[test]
    fn heredoc_bodies_are_not_commands() {
        // A body that looks like redirections writes nothing itself.
        let cmd = "python - <<'EOF'\nprint('a > b.txt')\nrm important.rs\nEOF";
        assert!(ops(cmd, "/proj").is_empty());
    }

    #[test]
    fn redirections_skip_streams_and_null() {
        assert_eq!(ops("cargo test 2>&1 | tail -5 > out.log", "/proj"), [("/proj/out.log".to_string(), "write")]);
        assert!(ops("ls >/dev/null 2>&1; echo hi > $S/x", "/proj").is_empty());
        assert_eq!(ops("echo done >> notes/log.txt", "/proj"), [("/proj/notes/log.txt".to_string(), "append")]);
    }

    #[test]
    fn copies_moves_deletes() {
        assert_eq!(
            ops("cp ../agentsboat/.gitignore . && cp ../a/time.rs src-tauri/src/ && cp -r ../a/icons .", "/proj/ccboat"),
            [("/proj/ccboat/.gitignore".to_string(), "write"), ("/proj/ccboat/src-tauri/src/time.rs".to_string(), "write")]
        );
        assert_eq!(
            ops("mv old.rs new.rs; rm -f tmp.txt; rm -rf dist", "/proj"),
            [("/proj/new.rs".to_string(), "write"), ("/proj/old.rs".to_string(), "delete"), ("/proj/tmp.txt".to_string(), "delete")]
        );
        assert_eq!(ops("sed -i 's/a/b/' src/x.ts src/y.ts", "/proj"), [("/proj/src/x.ts".to_string(), "edit"), ("/proj/src/y.ts".to_string(), "edit")]);
    }

    #[test]
    fn reads_with_their_first_line() {
        let got: Vec<_> = parse(
            "cd /proj && sed -n '86,480p' src/a.ts && grep -n \"getUser(\" src/b.ts | head -3; cat docs/c.md; head -n 40 d.rs; grep -rn foo src",
            "/w",
        )
        .into_iter()
        .map(|o| (o.path.replace('\\', "/"), o.op, o.line))
        .collect();
        assert_eq!(
            got,
            [
                ("/proj/src/a.ts".to_string(), "read", Some(86)),
                ("/proj/src/b.ts".to_string(), "read", None),
                ("/proj/docs/c.md".to_string(), "read", Some(1)),
                ("/proj/d.rs".to_string(), "read", Some(1)),
            ]
        );
        // Only a command that is just the read shows the file.
        assert!(parse("cd /proj && sed -n '86,480p' src/a.ts", "/w")[0].exact);
        assert!(!parse("sed -n '86,90p' a.ts && grep x b.ts", "/w").iter().any(|o| o.exact));
        assert!(!parse("grep -n x a.ts", "/w")[0].exact);
        // A read never hides a change to the same file.
        let got = parse("cat a.ts; sed -i 's/x/y/' a.ts; cat a.ts", "/proj");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].op, "edit");
    }

    #[test]
    fn powershell_cmdlets() {
        let got: Vec<_> = parse(r#"Set-Content -Path notes.md -Value "x"; Remove-Item old.txt; "a" | Out-File -FilePath out.txt -Append"#, "/proj")
            .into_iter()
            .map(|o| (o.path, o.op))
            .collect();
        assert_eq!(got, [("/proj/notes.md".to_string(), "write"), ("/proj/old.txt".to_string(), "delete"), ("/proj/out.txt".to_string(), "append")]);
    }

    #[test]
    fn git_bash_drives_and_dotdot() {
        if cfg!(windows) {
            assert_eq!(resolve("/d/projects/x/../y/a.rs", "C:/w").as_deref(), Some("D:\\projects\\y\\a.rs"));
            assert_eq!(resolve("src/a.rs", "D:\\p").as_deref(), Some("D:\\p\\src\\a.rs"));
        }
        assert_eq!(resolve("./b/../c.txt", "/home/me").as_deref(), Some("/home/me/c.txt"));
    }
}
