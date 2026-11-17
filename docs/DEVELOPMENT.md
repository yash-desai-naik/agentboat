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
- Tests: `cd src-tauri && cargo test --lib`; the UI: `npm run typecheck`.

## How a transcript becomes the IDE

Rust, `src-tauri/src/` (the window-free core `ccboat_core`, plus `main.rs` and `watch.rs`):

- `claude.rs`: the data folder, the session registry, finding transcripts (from Agentsboat).
- `sessions.rs`: the session list: running ones from the registry (process alive, pid reuse told
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
- `ide/EditorArea.tsx`, `TerminalPanel.tsx`, `ChatPanel.tsx`, `Sidebar.tsx` (Explorer, Search,
  Source Control, Tasks, Subagents), `TimelineBar.tsx` (canvas: one mark per step, the most
  significant per pixel column), `StatusBar.tsx`.
- `styles.css` (Fileboat's palette, both themes, title bar, session list) and `ide.css`.

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
