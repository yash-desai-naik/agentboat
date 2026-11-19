// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod attention;
mod desktop;
mod editors;
mod terminal;
mod usage;
mod update;
mod watch;

use tauri::Manager;

fn main() {
    // Run as Claude Code's status line (see agentboat_core::statusline): save its input, run the
    // status line it replaced, and exit. No window, no single-instance check.
    let mut args = std::env::args_os().skip(1);
    if args.next().is_some_and(|a| a == agentboat_core::statusline::FLAG) {
        let dir = args.next().map(std::path::PathBuf::from).unwrap_or_default();
        std::process::exit(agentboat_core::statusline::run(&dir));
    }

    // Ccboat's data and Claude Code settings, once, before the WebView opens its data folder.
    agentboat_core::migrate::run();

    tauri::Builder::default()
        // One window is enough: a second launch shows the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .manage(watch::Open::default())
        .manage(watch::Sessions::default())
        .manage(attention::Attention::default())
        .setup(|app| {
            watch::start(app.handle().clone());
            attention::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            watch::list_sessions,
            watch::open_session,
            watch::close_session,
            watch::step_detail,
            watch::step_details,
            update::update_check,
            update::update_status,
            update::update_install,
            desktop::app_paths,
            desktop::open_app_folder,
            desktop::open_releases_page,
            desktop::open_repo_page,
            desktop::open_url,
            terminal::open_in_claude_code,
            editors::editors,
            editors::open_in_editor,
            attention::attention_list,
            attention::attention_answer,
            attention::attention_dismiss,
            attention::hook_status,
            attention::hook_set,
            usage::usage,
            usage::limits_status,
            usage::limits_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentBoat");
}
