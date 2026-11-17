// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod watch;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // One window is enough: a second launch shows the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(watch::Open::default())
        .manage(watch::Sessions::default())
        .setup(|app| {
            watch::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            watch::list_sessions,
            watch::open_session,
            watch::close_session,
            watch::step_detail,
            watch::step_details,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ccboat");
}
