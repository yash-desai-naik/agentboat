//! Reads a transcript the way the app does and prints a summary of its timeline.
//! `cargo run --release --example dump -- <path to .jsonl> [steps to print]`

use ccboat_core::viewer::Viewer;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("path to a transcript");
    let show: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(40);
    let t = Instant::now();
    let v = Viewer::open(path.into());
    let took = t.elapsed();
    let head = v.head();
    println!(
        "{} steps, {} agents, status {}, title {:?}, opened in {:?}",
        head.steps,
        head.agents.len(),
        head.status,
        head.title,
        took
    );
    for a in &head.agents {
        println!("  agent {:?} {:?} step {:?}", a.description, a.kind, a.step);
    }
    let mut cats = std::collections::BTreeMap::<String, usize>::new();
    for s in v.steps() {
        *cats.entry(format!("{}:{}", s.kind, s.cat)).or_default() += 1;
    }
    println!("{cats:?}");
    let n = v.steps().len();
    for s in &v.steps()[n.saturating_sub(show)..] {
        let d = v.timeline.detail(s.i as usize);
        let has = |k: &str| d.and_then(|d| d.get(k)).is_some_and(|x| !x.is_null());
        println!(
            "#{:<5} a{} t{:<3} {:<9} {:<7} {:<4} {}{}{}{}",
            s.i,
            s.agent,
            s.turn,
            s.kind,
            s.cat,
            s.state,
            s.label.chars().take(90).collect::<String>(),
            if has("before") { "  [before]" } else { "" },
            if has("after") { " [after]" } else { "" },
            if has("content") { " [content]" } else { "" },
        );
        if let Some(g) = &s.git {
            println!("        git {:?}", g);
        }
    }
    let total_bytes: usize = (0..n)
        .filter_map(|i| v.timeline.detail(i))
        .map(|d| serde_json::to_string(d).map(|s| s.len()).unwrap_or(0))
        .sum();
    println!("details: {} KB", total_bytes / 1024);
}
