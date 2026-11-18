# Changelog

All notable changes to Ccboat are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Subagents showed as **done** with **0 steps** while they were running, when viewing a step soon
  after they started (and their Agent rows showed the launch call's time). An agent is now
  *starting*, *running*, *done* or *stopped* as it really was at that step, with how many steps it
  takes later; finished is read from the agent's own transcript, as newer Claude Code versions don't
  record it in the agent's metadata.

## [0.2.2] - 2026-11-18

### Fixed

- Links in Claude's replies and tool results copy as links (they pasted as plain text), and a
  click opens them in your browser.

## [0.2.1] - 2026-11-17

### Added

- **Alt+Z** wraps long lines in the editor, as in VS Code (remembered).

## [0.2.0] - 2026-11-17

### Added

- **About Ccboat** (the **Ccboat ▾** menu in the title bar): version, build, where Ccboat keeps its
  settings and where it reads sessions from, with Copy details.
- **Updates:** Ccboat checks GitHub for a new release at start-up and once a day (you can turn this
  off in About), shows a notice with what's new, and installs the update in place with
  **Install and restart**. Each update is signed and checked against the key built into the app.
  **Check for updates** in the menu checks right away. This is Ccboat's only use of the network.

## [0.1.0] - 2026-11-17

The first release: watch a Claude Code session as a read-only IDE, live or replayed.

### Added

- **Live:** open a running session and follow it as Claude works. Each new step appears within a
  quarter of a second; edits are typed in, commands typed at the prompt. When Claude is faster
  than the animations, the view skips ahead instead of falling behind.
- **Replay:** any session, step by step. A timeline of every step (drag to scrub), step and
  prompt-to-prompt keys, play at 0.1× to 16× with the session's own pauses or even steps.
- **Editor:** a tab for each file Claude reads or changes, with inline diffs; images Claude reads.
- **Explorer and Source Control:** every file Claude touched, marked read, modified, added or
  deleted, including files written from the terminal (`cat > f <<EOF`, `cp`, `rm`, `sed -i`,
  PowerShell cmdlets); commits, pushes, pulls and branch changes, and changes since the last
  commit.
- **Terminal:** each command at a Bash or PowerShell prompt with its output, in colour, one
  terminal per subagent.
- **Network:** every MCP, web and other tool call, with its request and its response shown by
  the shape of its data (record cards, tables, JSON trees), for any server.
- **Browser** tabs for web fetches and searches; a **dialog** for questions Claude asks you; a
  **command palette** for skills and tool searches.
- **Claude panel:** your prompts, Claude's replies and every tool call; click any to jump there.
- **Search, Tasks and Subagents** views; a status bar coloured by the session's state.
- Light on resources: about 200 MB of memory, 5–9% of one core following a live session, under 1%
  minimized. Never writes anywhere and never uses the network.

[Unreleased]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yash-desai-naik/ccboat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yash-desai-naik/ccboat/releases/tag/v0.1.0
