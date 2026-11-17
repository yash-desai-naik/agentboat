# Ccboat

Watch a **Claude Code session as an IDE**: files open and change in the editor, commands run in
the terminal, commits and pushes land in Source Control, live as Claude works or replayed step by
step afterwards. **Read-only**: it never changes anything.

Built with [Tauri 2](https://tauri.app) (Rust, and the WebView your system already has), on the same
foundations as its siblings [Fileboat](https://github.com/yash-desai-naik/fileboat),
[Tableboat](https://github.com/yash-desai-naik/tableboat) and Agentsboat. No Electron, no Node.js at
runtime.

## What you see

- **Editor.** A tab opens for each file Claude reads or changes. Reads open the file at the lines
  read, with their real line numbers. Edits show as an inline diff (green added, red removed).
  While following live or playing a replay, the edit is acted out: the old text is selected and
  removed, the new text typed in at a moving caret, then the diff appears. Images Claude reads
  are shown. Web fetches, MCP tools and questions open as output tabs.
- **Explorer.** Every file Claude has touched up to the current step, as a tree under the project
  folder, marked **R** (read), **M** (modified), **A** (added) or **D** (deleted). That includes
  files written from the terminal (`cat > f <<'EOF'`, `>`/`>>`, `tee`, `cp`, `mv`, `rm`, `sed -i`,
  PowerShell's `Set-Content`, `Out-File`, `Copy-Item`…); a heredoc's file opens in the editor
  with its content. Files outside the project are grouped by folder.
- **Terminal.** Each command typed at a prompt (`PS D:\…>` for PowerShell, `/d/… (branch) $` for
  Bash) with what it printed, stderr in colour, interrupted and background commands marked. One
  terminal per subagent.
- **Search.** Claude's Grep and Glob searches with their results grouped by file.
- **Source Control.** Files changed since the last commit, and the git activity: commits (message
  and hash), pushes and pulls (remote and range), branch switches, stashes, worktrees, `gh pr`.
  The status bar counts commits not pushed yet.
- **Tasks and Subagents.** Claude's task list as of the current step; each subagent with what it
  is doing.
- **Claude panel.** Your prompts, Claude's replies, and each tool call as a line (with time
  taken and lines changed). Click any line to jump there. *+ Agents* shows subagents' steps too.
- **Timeline** (hidden until you want it: the timeline button in the title bar, or Ctrl+T; while
  it's hidden the status bar shows Replay or Step n of m when you're not watching the present, and
  the keys below still work).
  Every step as a mark (prompts tall; reads blue, edits green, commands amber, git
  purple, failures red; subagents underneath). Drag to scrub, or step:

  | Key | |
  |---|---|
  | ← / → | step back / forward |
  | Shift + ← / → | previous / next prompt |
  | Space | play / pause |
  | End | go live (follow Claude) |
  | Home | first step |
  | Ctrl+O | open another session |
  | Ctrl+T | show / hide the timeline |
  | Ctrl+B / J / L | side bar / terminal / Claude panel |

  Replay speed (0.1× to 16×), *Real pauses* (the session's own timing, long gaps shortened) or
  *Even steps*, and the typing animation (normal, fast, off) are set beside it.

Running sessions open following live: each new step appears within a quarter of a second of
Claude Code writing it. If Claude moves faster than the animations, the view skips ahead rather
than falling behind. Step
back and following pauses; **Go live** resumes. Finished sessions open at their last step, ready
to replay.

## Light on resources

Measured on Windows 11 (release build, 12 cores), details in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#memory-and-cpu):

- **~200 MB** of memory in all (about 265 MB replaying a 20 MB transcript), most of it the
  system WebView's own processes; the app itself is ~15 MB.
- Following a live session: **5–9% of one core** while Claude is idle (under 1% of the machine),
  about 13% while it works; **0.7%** while minimized.
- Replaying with the typing animation: 25% of one core at 1×, 35% at 4×.

## What it can't show

Ccboat sees what Claude Code writes to its transcript, so:

- A command's output appears when the command finishes (the transcript doesn't record output
  while a command runs).
- Claude's thinking is shown as "Thinking…" only: Claude Code stores it redacted.
- "Changes since the last commit" is worked out from the session (a commit clears the list); it
  isn't read from git.
- What a script does inside (`python - <<'EOF'` editing a file) can't be seen from its command
  line, so those changes don't appear; nor do the files of a whole-folder copy (`cp -r`).
- Files are shown as Claude saw them: what it read, and its edits applied to that. A file Claude
  edited without reading shows the edit itself (or the patch Claude Code logged).

## Where the data comes from

Only from `~/.claude` (or `CLAUDE_CONFIG_DIR`), read-only:

- `sessions/<pid>.json`: which sessions are running and whether they're working, idle or waiting
  for you;
- `projects/<folder>/<sessionId>.jsonl`: the transcript, read as it grows;
- `projects/<folder>/<sessionId>/subagents/agent-<id>.jsonl` and `.meta.json`: subagents.

It never writes anywhere (except its own window settings in the WebView's storage) and never uses
the network.

## Build from source

Requirements: Windows 10 or 11 with the Microsoft C++ build tools (WebView2 comes with Windows 11),
or macOS 11+ with the Xcode Command Line Tools; [Rust](https://rustup.rs) (stable);
[Node.js](https://nodejs.org) 20+ (only to build the UI).

```sh
npm install
npx tauri dev      # run while developing
npx tauri build    # the installer (Windows) or DMG (macOS)
```

More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT
