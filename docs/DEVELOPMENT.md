# Developing Ccboat

All commands run from the project folder (Rust's `cargo` must be on the PATH).

## Run while developing

```sh
npx tauri dev
```

- The dev server uses port **1422**, so Ccboat can run in dev next to Fileboat or Tableboat (1420)
  and Agentsboat (1421).
- Developer tools on Windows: start with WebView2's remote debugging on a port nothing else uses,
  and check the target is Ccboat before driving it:

  ```powershell
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9488"; npx tauri dev
  ```

  `CDP_PORT=9488 node scripts/cdp.mjs steps.json` drives that window (evaluate, click, type,
  screenshot).
- See a transcript the way the app reads it, without a window:
  `cd src-tauri && cargo run --release --example dump -- <path to .jsonl> [steps to print]`
  prints the step counts by kind, the last steps, and how long the read took.
- Tests: `cd src-tauri && cargo test --lib` (and `cargo test --bin ccboat` for the desktop side:
  Needs you, Open in Claude Code); the UI: `npm run typecheck`.
- Try **Needs you** without touching your own Claude Code settings: start the dev build with
  `CLAUDE_CONFIG_DIR` pointing at a scratch folder and `--config '{"identifier":"app.ccboat.dev"}'`
  (so it runs beside an installed Ccboat), turn it on there, then run
  `claude -p "<a prompt that fetches a page>" --settings <scratch>/settings.json` and answer the card.

## How a transcript becomes the IDE

Rust, `src-tauri/src/` (the window-free core `ccboat_core`, plus `main.rs` and `watch.rs`):

- `claude.rs`: the data folder, the session registry, finding transcripts (from Agentsboat).
- `sessions.rs`: the session list (`limit` most recent, and how many older ones exist, for
  "Show older sessions"): running ones from the registry (process alive, pid reuse told
  apart by its start time, `alive.rs`), then recent transcripts. Titles come from peeking at a
  file's first 96 KB (for `cwd`) and last 384 KB (`ai-title`, `custom-title`, `last-prompt`);
  peeks are cached by size and modification time.
- `timeline.rs`: transcript lines to **steps**. Each step has a light summary (`Step`: kind,
  category, label, file, state, git info, task list, lines changed) that the UI gets in full,
  and a **detail** (file text, command output, search results) the UI fetches when it shows the
  step. A tool's step is created from its `tool_use` and updated when its `tool_result` arrives
  (state, end time, output; `v` is bumped so the UI refetches the detail).
  - File contents are rebuilt as the session goes: a `Read` gives the text (from
    `toolUseResult.file`, else the numbered output with its numbers stripped); an `Edit` is
    applied to the known text (allowing for CRLF files edited with LF strings) to give the before
    and after; the `originalFile` Claude Code logs with each edit result is the authoritative
    before, and corrects anything missed. A failed edit restores the text.
  - Prompts are user lines with `origin.kind == "human"` (or, in older transcripts, plain text that
    isn't a notification); slash commands are shown as typed. `[Request interrupted…]` ends the
    running tools.
- `git.rs`: recognises git in shell commands (`cd x && git add -A && git commit -m "…" && git
  push`): a small tokenizer, global options skipped, the commit message from `-m`, `--message=`,
  `-am` or a heredoc. Only commands that change something (commit, push, pull, merge, rebase,
  checkout, switch, stash, worktree, `gh pr`…) count as git steps; `status`, `log`, `show`, `diff`
  stay terminal commands. git's own output gives the hash, branch, remote and range.
- `shell_files.rs`: files a shell command writes, copies, moves or deletes (Bash redirections,
  heredocs with their bodies kept as the content, `tee`, `touch`, `cp`, `mv`, `rm`, `sed -i`; the
  PowerShell cmdlets). Heredoc bodies are taken out before tokenizing, so text inside them is never
  mistaken for commands; `cd` within the command is followed; Git Bash drives (`/d/x`) become
  `D:\x`; `$VAR` paths, `/dev/null`, recursive copies and deletes are skipped. A heredoc's content
  becomes the file's known text, so a later Edit of it has a "before".
- `viewer.rs`: one open session: the main transcript and each subagent's, read incrementally
  (only bytes appended since the last poll; a line without its newline waits). New lines from all
  transcripts are merged by timestamp, keeping each file's order. Subagents are found every
  second and tied to the `Agent` step that started them (`meta.json`'s `toolUseId`, or the
  result's `agentId`). Status comes from the registry; a transcript written in the last 30 s but
  not registered (`claude -p`, SDK) counts as active.
- `hooks.rs`: Ccboat's `PermissionRequest` hook in Claude Code's `settings.json`: found by its URL
  path (`/ccboat/permission`), added and removed without touching anything else (a file that
  doesn't parse is never written over; the original is backed up once; writes replace the file in
  one step), and the token it carries.
- `attention.rs` (desktop side): **Needs you**. A plain `std::net` HTTP/1.1 listener on
  `127.0.0.1:47821` (`CCBOAT_HOOK_PORT` moves it) takes each hook POST (token checked, `Origin`
  refused), shows it as a card (`ccb:attention`) and holds the connection until the UI answers
  (`attention_answer`), Claude Code hangs up, or the registry shows the session moved on from
  `waiting` (answered in the terminal); then it replies with the decision, or `{}` for none. A
  thread reads the registry every second for `waiting` sessions without a request and `busy` →
  `idle` turns (`done` cards). Answers: `allow` (+ the suggested `updatedPermissions`), `deny`
  (`message`, `interrupt`), `AskUserQuestion` as `allow` with `updatedInput.answers` (question →
  label, several joined with ", "), `ExitPlanMode` as `allow` with its input echoed back.
- `terminal.rs` (desktop side): **Open in Claude Code**. A running session's host window is found
  by walking up its parent processes to the first one with a visible top-level window
  (`WindowsTerminal.exe`, `Code.exe`, a console); a finished one runs
  `claude --resume <id>` in a new Windows Terminal tab (or a new PowerShell console) in its folder.
  Only a validated session id goes on the command line.
- `statusline.rs`: **Show usage limits**. Puts `"<ccboat.exe>" --statusline "<data>/statusline"` in
  Claude Code's `statusLine` (yours kept in `original.json` there, with its `padding` and
  `refreshInterval` carried over, and restored when turned off). Run that way (`main.rs` checks the
  flag before Tauri starts, so no window and no single-instance check), Ccboat saves stdin as
  `<session id>.json` and runs your original command with it through the shell Claude Code uses
  (Git Bash on Windows when installed, else PowerShell; `sh` elsewhere), passing its output and exit
  code back. `read` gives the open session's window size, the newest `rate_limits` of any session
  (they're account-wide; `resets_at` is Unix seconds) and window sizes per model; snapshots older
  than a week are deleted. Desktop side: `usage.rs` (`usage`, `limits_status`, `limits_set`).
- `update.rs`: the updater (check, download, verify, install), driven by the UI's schedule;
  `desktop.rs`: the About box's folders and the GitHub links (fixed addresses only).
- `watch.rs`: one thread polls the open session every 250 ms (1 s while hidden) and emits
  `ccb:update` (new steps, changed earlier ones, the head) only when something changed. Commands:
  `list_sessions`, `open_session`, `close_session`, `step_detail(s)`.

A 20 MB transcript (1,600 steps, 4 subagents) opens in about 130 ms in release builds; its
details take about 3.5 MB.

UI, `src/` (React 19, CodeMirror 6, no state library):

- `lib/store.ts`: the open session, the cursor, follow/play, and the **director**: following
  live, the cursor moves to each new step with time for its animation (edits ~1.1 s, commands
  ~0.85 s, replies ~0.65 s; half with "fast"), skipping ahead when more than four steps behind;
  playing, the same pacing divided by the speed, or the session's own gaps (capped at 2.5 s).
  `anim` marks the step that became current that way; only it animates. Details are fetched in
  batches and cached by step and version.
- `lib/derive.ts`: the IDE at the cursor (files and their R/M/A marks, open tabs, terminals, git,
  changes, tasks, running tools), folded from the step summaries on every cursor move.
- `ide/CodeEditor.tsx`: read-only CodeMirror with the typing animation (common prefix and suffix
  of before and after give the change; the old text is marked, removed, the new text typed,
  then `unifiedMergeView` shows the diff).
- `ide/EditorArea.tsx` (file tabs, the browser tab for web fetches and searches, the question
  dialog, the command palette), `TerminalPanel.tsx`, `ChatPanel.tsx`, `Sidebar.tsx` (Explorer,
  Search, Source Control, Tasks, Subagents), `TimelineBar.tsx` (canvas: one mark per step, the
  most significant per pixel column), `StatusBar.tsx`.
- `ide/termColor.tsx`: the terminal's colours. Commands are tokenized (programs, flags, strings,
  variables, operators, comments, heredoc bodies). Output with ANSI SGR codes keeps its colours
  (16-colour palette in `ide.css`, both themes); plain output is coloured per line by what it
  says (errors, warnings, passes, progress verbs, `file:line` locations, diffs, `git status`).
  `\r` progress lines keep only what was drawn last.
- `ide/NetworkPanel.tsx`: MCP, web and other tool calls as a DevTools-style request list
  (server badge coloured from its name, status, time, size from the step summary) and an
  inspector (Preview / Response / Request).
- `ide/DataView.tsx`: shows any response by its shape, never by its server: an object that names
  something becomes a record card (title, id, status-like fields as badges, people as chips,
  long text rendered, nested parts collapsible); a list of objects, or an object wrapping one,
  becomes a table of its most telling columns; text is markdown when it looks like it; anything
  else is a JSON tree. Where each tool goes is decided in `lib/derive.ts` (`isNetworkStep`,
  `isPaletteStep`); `panels.css` has their styles.
- `styles.css` (Fileboat's palette, both themes, title bar, session list) and `ide.css`.

## Release a new version

Releases are built by GitHub Actions (`.github/workflows/release.yml`), so every download is built
from the source at its tag.

1. Pick the version ([Semantic Versioning](https://semver.org)).
2. Set it in all three files: `"version"` in `package.json` and `src-tauri/tauri.conf.json`, and
   `version` in `src-tauri/Cargo.toml` (then run `cargo build` once so `Cargo.lock` follows).
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it, and add the version links at the bottom. Write entries for users.
4. Commit, then tag and push:

   ```sh
   git commit -am "chore(release): x.y.z"
   git tag -a vx.y.z -m "Ccboat x.y.z"
   git push origin main vx.y.z
   ```

5. The Release workflow checks the version matches the tag in all three files, runs the Rust tests,
   builds on `windows-latest`, and creates a **draft** release with the installer,
   `SHA256SUMS.txt`, and notes from the changelog plus `.github/release-footer.md`.
6. Read the draft under Releases, then press **Publish release**.

Installed copies find the new version through `latest.json` on the latest published release
(`releases/latest/download/latest.json`), which the workflow builds with the installer's updater
signature. Drafts and pre-releases are never offered. macOS isn't built yet; when it is, it goes in the workflow as Fileboat's does
(`macos-latest`, `--target aarch64-apple-darwin`, an ad-hoc signed DMG).

### The updater key

- Every update must be signed with Ccboat's updater key; installed copies check it against the
  public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- Private key: `~/.tauri/ccboat-updater.key` on the maintainer's PC (no password), and the GitHub
  repository secret `TAURI_SIGNING_PRIVATE_KEY` (its contents) for the Release workflow:

  ```sh
  gh secret set TAURI_SIGNING_PRIVATE_KEY -R yash-desai-naik/ccboat < ~/.tauri/ccboat-updater.key
  ```

- **Keep a backup of the key** (e.g. in a password manager). Without it, no new version can be signed
  for existing installs.
- Local builds don't need it. A signed one, as the workflow makes:
  `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ccboat-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri build --config src-tauri/tauri.release.conf.json`.
- Test the updater against a local feed: `CCBOAT_UPDATE_URL=http://127.0.0.1:8765/latest.json`
  points a build at another feed. Tauri only accepts https feeds, so a local test build needs a
  config with `"plugins": { "updater": { "dangerousInsecureTransportProtocol": true } }` passed with
  `--config` (never in a release). The feed's `version` must match the version the installer was
  built with: the signature names it, and a mismatch is refused as tampering.

## Memory and CPU

WebView2 costs about the same per frame drawn whatever moves (measured for Agentsboat), so:

- Looping animations (status dots, the LIVE badge, spinners, carets, "Thinking…") are **stepped**
  (`steps(2, jump-none)` blinks, `steps(8)` spinners), never smooth 60 fps loops, and their
  durations divide one second. `lib/motion.ts` pins every loop's start to a shared one-second
  grid, so they all change on the same frames: ten blinking dots cost what one does.
- While the window is **minimized or hidden** every animation is paused and the seconds clock
  stops. WebView2 keeps a minimized page "visible", so the window itself is asked.
- The typing animations (editor, terminal, Claude panel) redraw at most ~30 times a second
  (`frameDue`).

Measure with the window shown, the session open:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 -Seconds 120 -Marks marks.txt
```

It samples the app and every WebView2 process it started every 2 s (private working set, as Task
Manager shows it, and CPU), and with `-Marks` (lines of `unix-ms label`, written while measuring)
summarises each phase.

Release build, Windows 11, 12 cores, 1440×880 window, following this very session while it was
being built (CPU as % of **one** core; divide by 12 for the share of the machine):

| Phase | CPU avg | CPU peak | Memory |
|---|---|---|---|
| Live, following, Claude idle | 5.5–9% | 14% | ~200 MB |
| Live, following, Claude busy | 13% | 26% | ~195 MB |
| Replay 1×, typing on | 25% | (110% for a moment when it starts) | ~200 MB |
| Replay 4×, the 20 MB session | 35% | 48% | ~265 MB |
| Paused, viewing the past | ~5% between seeks | | ~220 MB |
| Minimized (still following) | **0.7%** | 4.5% | ~210 MB |

Memory is ~15 MB for the app itself; the rest is the WebView (its browser, GPU and renderer
processes). Before the animation rules above, the same session cost 15% idle and 14.7% minimized,
almost all of it in the WebView's GPU and renderer processes redrawing smooth loops; the Rust side
(polling the transcripts every 250 ms) is about 0.3%.
