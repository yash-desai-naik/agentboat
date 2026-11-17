//! Recognising git in the shell commands Claude runs, so the IDE's Source Control view can show
//! commits, pushes and pulls the way a developer's would.
//!
//! Commands are free-form shell (`cd x && git add -A && git commit -m "…" && git push`), so this
//! is a tokenizer good enough for how Claude writes them, not a shell parser. The commit message
//! comes from `-m` / `--message` or a heredoc (`-m "$(cat <<'EOF' … EOF)"`); the hash, branch and
//! remote come from git's own output once the command finishes.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// Every git (and `gh`) subcommand in the command line, in order: `add`, `commit`, `push`…
    pub ops: Vec<String>,
    /// The one that matters most for display (a commit outranks the `add` before it).
    pub primary: String,
    /// The commit message's first line, when this commits.
    pub message: Option<String>,
    /// From git's output: `[main 1a2b3c4] subject`.
    pub hash: Option<String>,
    pub branch: Option<String>,
    /// `origin/main` and the like, from push / pull output.
    pub remote: Option<String>,
    /// `abc123..def456`, from push / pull output.
    pub range: Option<String>,
}

/// Ranked: the first of these present in a command is its primary operation.
const RANK: &[&str] = &[
    "commit",
    "push",
    "pull",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "reset",
    "pr",
    "checkout",
    "switch",
    "worktree",
    "stash",
    "tag",
    "branch",
    "fetch",
    "clone",
    "init",
    "restore",
    "rm",
    "mv",
    "add",
    "apply",
    "diff",
    "log",
    "show",
    "status",
    "blame",
    "remote",
    "config",
    "rev-parse",
];

/// Whether an op belongs in the Source Control view: it changes the repository, its branches or
/// its remotes. `status`, `log`, `show`, `grep` and the like only look.
pub fn is_notable(op: &str) -> bool {
    matches!(
        op,
        "commit"
            | "push"
            | "pull"
            | "merge"
            | "rebase"
            | "cherry-pick"
            | "revert"
            | "reset"
            | "pr"
            | "checkout"
            | "switch"
            | "worktree"
            | "stash"
            | "tag"
            | "branch"
            | "fetch"
            | "clone"
            | "init"
            | "restore"
            | "rm"
            | "mv"
            | "add"
            | "apply"
    )
}

impl GitInfo {
    /// Whether any of its operations belongs in the Source Control view.
    pub fn notable(&self) -> bool {
        self.ops.iter().any(|o| is_notable(o))
    }
}

/// The git operations in a shell command, or `None` if it runs no git.
pub fn parse_command(cmd: &str) -> Option<GitInfo> {
    let words = split_words(cmd);
    let mut ops = Vec::new();
    let mut message = None;
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let is_git = w == "git" || w.ends_with("/git") || w.ends_with("\\git") || w == "git.exe";
        let is_gh = w == "gh" || w == "gh.exe";
        if !(is_git || is_gh) || !starts_command(&words, i) {
            i += 1;
            continue;
        }
        // Skip global options to reach the subcommand: `git -C path --no-pager commit`.
        let mut j = i + 1;
        while j < words.len() && words[j].starts_with('-') {
            if matches!(words[j].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
                j += 1;
            }
            j += 1;
        }
        let Some(sub) = words.get(j) else { break };
        if is_gh {
            // `gh pr create`, `gh pr merge`: shown as a pull-request operation.
            if sub == "pr" {
                ops.push("pr".to_string());
            }
            i = j + 1;
            continue;
        }
        let sub = sub.as_str();
        if sub.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !sub.is_empty() {
            ops.push(sub.to_string());
            if sub == "commit" && message.is_none() {
                message = commit_message(&words[j + 1..], cmd);
            }
        }
        i = j + 1;
    }
    if ops.is_empty() {
        return None;
    }
    let primary = RANK
        .iter()
        .find(|r| ops.iter().any(|o| o == *r))
        .map(|s| s.to_string())
        .unwrap_or_else(|| ops[0].clone());
    Some(GitInfo {
        ops,
        primary,
        message,
        ..Default::default()
    })
}

/// Fills in what git printed: the new commit's hash and branch, the pushed or pulled range.
pub fn read_output(info: &mut GitInfo, out: &str) {
    for line in out.lines() {
        let t = line.trim();
        // `[main 1a2b3c4] subject` or `[main (root-commit) 1a2b3c4] subject`.
        if info.hash.is_none()
            && t.starts_with('[')
            && let Some(close) = t.find("] ")
        {
            let inner = &t[1..close];
            let parts: Vec<&str> = inner.split_whitespace().collect();
            if let (Some(branch), Some(hash)) = (parts.first(), parts.last())
                && parts.len() >= 2
                && hash.len() >= 7
                && hash.chars().all(|c| c.is_ascii_hexdigit())
            {
                info.branch = Some(branch.to_string());
                info.hash = Some(hash.to_string());
                // git's own summary line is the message as committed (`-m "$msg"` isn't).
                info.message = Some(t[close + 2..].to_string());
            }
        }
        // `   1a2b3c4..5d6e7f8  main -> main` (push) / `Updating 1a2b3c4..5d6e7f8` (pull).
        if info.range.is_none() {
            if let Some(rest) = t.strip_prefix("Updating ") {
                info.range = Some(rest.trim().to_string());
            } else if let Some(arrow) = t.find(" -> ") {
                let left: Vec<&str> = t[..arrow].split_whitespace().collect();
                if let Some(range) = left.iter().find(|w| w.contains("..")) {
                    info.range = Some(range.to_string());
                }
                if info.remote.is_none() {
                    info.remote = Some(t[arrow + 4..].trim().to_string());
                }
            } else if t.starts_with("* [new branch]") {
                info.range = Some("new branch".to_string());
                if let Some(arrow) = t.find("->") {
                    info.remote = Some(t[arrow + 2..].trim().to_string());
                }
            }
        }
        if let Some(rest) = t.strip_prefix("To ").or_else(|| t.strip_prefix("From "))
            && info.remote.is_none()
            && !rest.contains(' ')
        {
            info.remote = Some(rest.to_string());
        }
    }
}

/// Whether word `i` starts a command (the beginning, or after `&&`, `||`, `;`, `|`, `(`).
fn starts_command(words: &[String], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let prev = words[i - 1].as_str();
    matches!(prev, "&&" | "||" | ";" | "|" | "(" | "{" | "then" | "do" | "&" | "time" | "sudo" | "!")
        || prev.ends_with(';')
        || prev.ends_with('(')
}

/// The commit message from `-m` / `--message=` / `-F -` with a heredoc, first line only.
fn commit_message(args: &[String], raw: &str) -> Option<String> {
    let mut k = 0;
    while k < args.len() {
        let a = args[k].as_str();
        if matches!(a, "&&" | "||" | ";" | "|") {
            break;
        }
        let value = if a == "-m" || a == "--message" {
            args.get(k + 1).map(|s| s.as_str())
        } else if let Some(v) = a.strip_prefix("--message=") {
            Some(v)
        } else if let Some(v) = a.strip_prefix("-m").filter(|v| !v.is_empty() && !a.starts_with("-m-")) {
            Some(v)
        } else if a.starts_with('-') && !a.starts_with("--") && a.ends_with('m') && a.len() > 2 {
            // `-am "msg"`
            args.get(k + 1).map(|s| s.as_str())
        } else {
            None
        };
        if let Some(v) = value {
            if v.contains("<<") || v.starts_with("$(") {
                return heredoc_first_line(raw);
            }
            let first = v.lines().map(str::trim).find(|l| !l.is_empty())?;
            return Some(first.to_string());
        }
        k += 1;
    }
    // `git commit -F - <<'EOF'` or `-F file`: try a heredoc anywhere in the command.
    heredoc_first_line(raw)
}

/// The first non-empty line inside the first heredoc of a command.
fn heredoc_first_line(raw: &str) -> Option<String> {
    let start = raw.find("<<")?;
    let after = &raw[start + 2..];
    let after = after.trim_start_matches('-');
    let tag: String = after
        .trim_start()
        .trim_start_matches(['\'', '"'])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if tag.is_empty() {
        return None;
    }
    let body_start = after.find('\n')? + 1;
    let body = &after[body_start..];
    body.lines()
        .map(str::trim)
        .take_while(|l| *l != tag)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Shell-ish word splitting: quotes group, `&&` `||` `;` `|` `(` `)` are their own words. Newlines
/// separate commands like `;`.
pub(crate) fn split_words(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = cmd.chars().peekable();
    let mut quote: Option<char> = None;
    let mut in_word = false;
    let flush = |cur: &mut String, out: &mut Vec<String>, in_word: &mut bool| {
        if *in_word {
            out.push(std::mem::take(cur));
            *in_word = false;
        }
    };
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && q == '"' && chars.peek() == Some(&'"') {
                cur.push(chars.next().unwrap_or('"'));
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                in_word = true;
            }
            ' ' | '\t' | '\r' => flush(&mut cur, &mut out, &mut in_word),
            '\n' => {
                flush(&mut cur, &mut out, &mut in_word);
                out.push(";".into());
            }
            '&' | '|' => {
                flush(&mut cur, &mut out, &mut in_word);
                if chars.peek() == Some(&c) {
                    chars.next();
                    out.push(format!("{c}{c}"));
                } else {
                    out.push(c.to_string());
                }
            }
            ';' | '(' | ')' => {
                flush(&mut cur, &mut out, &mut in_word);
                out.push(c.to_string());
            }
            _ => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    flush(&mut cur, &mut out, &mut in_word);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_git_in_chains() {
        let g = parse_command(r#"cd D:/p && git add -A && git commit -m "fix: parse lines" && git push origin main"#).unwrap();
        assert_eq!(g.ops, ["add", "commit", "push"]);
        assert_eq!(g.primary, "commit");
        assert_eq!(g.message.as_deref(), Some("fix: parse lines"));
    }

    #[test]
    fn global_options_and_read_only_ops() {
        let g = parse_command("git -C D:/work/x --no-pager log --oneline -5").unwrap();
        assert_eq!(g.ops, ["log"]);
        assert!(!g.notable());
        assert!(!parse_command("git show HEAD:a.rs | git grep x").unwrap().notable());
        assert!(parse_command("echo git is great").is_none());
        assert!(parse_command("npm run digit").is_none());
    }

    #[test]
    fn heredoc_commit_messages() {
        let cmd = "git commit -m \"$(cat <<'EOF'\nfeat: timeline bar\n\nLonger body.\n\nCo-Authored-By: Claude\nEOF\n)\"";
        let g = parse_command(cmd).unwrap();
        assert_eq!(g.message.as_deref(), Some("feat: timeline bar"));
        let ps = "git commit -F - <<'EOF'\nchore: bump\nEOF";
        assert_eq!(parse_command(ps).unwrap().message.as_deref(), Some("chore: bump"));
    }

    #[test]
    fn gh_pr_and_am() {
        let g = parse_command("gh pr create --title x --body y").unwrap();
        assert_eq!(g.primary, "pr");
        let g = parse_command("git commit -am 'quick fix'").unwrap();
        assert_eq!(g.message.as_deref(), Some("quick fix"));
    }

    #[test]
    fn reads_commit_and_push_output() {
        let mut g = parse_command("git commit -m x && git push").unwrap();
        read_output(
            &mut g,
            "[feature/cu-86 1a2b3c4d] x\n 2 files changed, 10 insertions(+)\nTo https://github.com/a/b.git\n   9f8e7d6..1a2b3c4  feature/cu-86 -> feature/cu-86\n",
        );
        assert_eq!(g.hash.as_deref(), Some("1a2b3c4d"));
        assert_eq!(g.branch.as_deref(), Some("feature/cu-86"));
        assert_eq!(g.range.as_deref(), Some("9f8e7d6..1a2b3c4"));
        assert_eq!(g.remote.as_deref(), Some("https://github.com/a/b.git"));

        let mut g = parse_command("git commit -m first").unwrap();
        read_output(&mut g, "[main (root-commit) 0abc123] first\n");
        assert_eq!(g.hash.as_deref(), Some("0abc123"));
        assert_eq!(g.branch.as_deref(), Some("main"));

        let mut g = parse_command("git commit -m \"$msg\"").unwrap();
        read_output(&mut g, "[dev 1234567] fix: real subject\n");
        assert_eq!(g.message.as_deref(), Some("fix: real subject"));

        let mut g = parse_command("git pull").unwrap();
        read_output(&mut g, "Updating 1111111..2222222\nFast-forward\n");
        assert_eq!(g.range.as_deref(), Some("1111111..2222222"));
    }
}
