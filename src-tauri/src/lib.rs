//! Ccboat's window-free core: finding Claude Code sessions, and turning a session's transcripts
//! into the timeline of steps the IDE view shows. The desktop app (`main.rs`) follows the open
//! session on a timer and sends the UI what changed.

pub mod alive;
pub mod claude;
pub mod git;
pub mod hooks;
pub mod sessions;
pub mod statusline;
pub mod shell_files;
pub mod time;
pub mod timeline;
pub mod viewer;
