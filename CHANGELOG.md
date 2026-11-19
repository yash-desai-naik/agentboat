# Changelog

All notable changes to Ccboat are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-19

### Added

- **Needs you:** a bell in the title bar lists every running session that is waiting on you,
  across all your sessions, not only the one open. With **Answer prompts in Ccboat** turned on
  (**Ccboat ▾**), you answer them right there: allow or deny a tool (with a note for Claude, or
  "always allow" the rule Claude Code suggests), answer Claude's questions, approve a plan or send
  it back with feedback. The terminal keeps showing the same prompt; answer in either place. The
  panel opens when something new needs you and the taskbar button flashes; Ccboat can also come to
  the front.
- Sessions waiting on you in their terminal, and sessions that just finished their turn, are listed
  too, with a way to open them.
- **Open in Claude Code** (title bar, and on each session in the session list): a running session's
  terminal comes to the front; a finished one is resumed in a new terminal in its folder
  (`claude --resume`).
- **Usage limits in the status bar:** your 5-hour and weekly usage, each with a bar and when it
  resets, with **Show usage limits** on (**Ccboat ▾**). Claude Code reports these only to its status
  line, so Ccboat becomes the status line, keeps a copy, and runs yours as before; turning it off
  puts yours back.

### Changed

- The status bar shows the context in use as a share of the window, with a bar, instead of a token
  count (the count is in its tooltip). The window's size comes from Claude Code when usage limits
  are on; otherwise it is estimated and marked ≈.
- The status bar shows the reasoning effort beside the model (`opus-5-5 · high`).

## [0.3.0] - 2026-11-18

### Added

- **Agents as collaborators:** the IDE shows the main session's screen, and subagents at work
  appear like teammates in a shared workspace instead of pulling the editor to their files: a
  numbered, coloured avatar each on the tab bar (hover for what it's doing), dots on the tabs and
  Explorer files they're on, and their name on the line they're reading or changing.
- **Follow an agent:** pick any agent (the **Watching** menu on the tab bar, its avatar, or its
  card in Subagents) and the IDE becomes its screen: its tabs, its terminal, its steps in the
  Claude panel, with the others (Claude included) as collaborators. A coloured bar says whose screen
  it is; **Back to Claude** or Esc returns.
- **Team view** (**⊞ Team** on the tab bar, or Ctrl+Shift+T): every agent's screen at once, like a
  wall of monitors. Each tile shows what that agent is on (a file's lines, a command and its
  output, or its last words), with its state and steps; working agents first. Click one to follow
  it.
- **Timeline lanes:** a lane per agent under the timeline's main track, showing when each one
  was at work and every step it took; the followed agent's lane is highlighted. Hover a lane for
  that agent's step there; click it to jump to that step and follow the agent.
- A file an agent reads with only a terminal command (`sed -n 'X,Yp' file`, `cat`, `head`) opens in
  its editor at those lines, labelled *Read from the terminal*.
- Files read from the terminal (`cat`, `sed -n 'X,Yp'`, `head`, `grep … file`, `Get-Content`)
  show as read in Explorer, with the line the command starts at.

## [0.2.3] - 2026-11-18

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

[Unreleased]: https://github.com/yash-desai-naik/ccboat/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/yash-desai-naik/ccboat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yash-desai-naik/ccboat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yash-desai-naik/ccboat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yash-desai-naik/ccboat/releases/tag/v0.1.0
