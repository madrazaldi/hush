pub mod ai;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod files;
pub mod llm;
pub mod meetings;
pub mod paths;
pub mod settings;
pub mod shell_env;
pub mod state;
pub mod stt;
pub mod tray;

use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

/// Bring the main window forward, optionally navigating to a route.
pub fn show_main(app: &AppHandle, route: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(r) = route {
        let _ = app.emit_to("main", "navigate", r);
    }
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn apply_dock_visibility(app: &AppHandle, show: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if show { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, show);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,hush_lib=debug")).init();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app, None)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            paths::init(app.path().app_data_dir()?);
            // Resolve the login-shell PATH early (off the main thread) so CLIs are found.
            std::thread::spawn(|| {
                let _ = shell_env::path();
            });

            let mut settings = settings::Settings::load();
            let db = db::Db::open(&paths::db_file())?;
            let state = Arc::new(AppState {
                app: handle.clone(),
                settings: RwLock::new(settings.clone()),
                db,
                dictation: Default::default(),
                meetings: Default::default(),
                files: Default::default(),
                llm_tasks: Mutex::new(Default::default()),
            });
            state::init(state.clone());

            // First run: create LLM profiles for installed agent CLIs.
            if settings.llm_profiles.is_empty() {
                tauri::async_runtime::spawn(async move {
                    let found: Vec<_> =
                        llm::detect_clis().await.into_iter().filter(|c| c.path.is_some()).map(|c| c.kind).collect();
                    let st = state::get();
                    let mut s = st.settings();
                    if s.llm_profiles.is_empty() && !found.is_empty() {
                        s.seed_llm_profiles(&found);
                        let _ = s.save();
                        *st.settings.write() = s;
                        st.emit("settings:changed", ());
                    }
                });
            }
            settings.normalize();

            // Retention cleanup.
            if let Ok(paths) = state.db.prune_dictations(settings.general.history_days) {
                for p in paths {
                    let _ = std::fs::remove_file(p);
                }
            }

            dictation::overlay::create(&handle)?;
            tray::create(&handle)?;
            apply_dock_visibility(&handle, settings.general.show_in_dock);
            state.files.start();
            state.dictation.start_hotkeys();
            state::get().meetings.start_detection();
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps Hush running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::app_info,
            commands::get_permissions,
            commands::open_privacy,
            commands::request_microphone,
            commands::validate_hotkey,
            commands::list_input_devices,
            commands::stats,
            commands::reveal_path,
            commands::list_models,
            commands::download_model,
            commands::cancel_model_download,
            commands::delete_model,
            commands::test_stt,
            commands::detect_clis,
            commands::test_llm,
            commands::llm_models,
            commands::dictation_toggle,
            commands::dictation_cancel,
            commands::list_dictations,
            commands::delete_dictation,
            commands::clear_dictations,
            commands::apply_style,
            commands::add_files,
            commands::add_url,
            commands::list_recordings,
            commands::get_recording,
            commands::update_recording,
            commands::delete_recording,
            commands::retranscribe,
            commands::cancel_job,
            commands::export_recording,
            commands::export_text,
            commands::cancel_llm,
            commands::summarize,
            commands::chat,
            commands::clear_chat,
            commands::run_recipe,
            commands::ask_all,
            commands::translate_recording,
            commands::meeting_start,
            commands::meeting_stop,
            commands::meeting_status,
            commands::meeting_pause,
            commands::meeting_create,
            commands::meeting_enhance,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hush")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_main(app, None);
            }
            if let RunEvent::Exit = event {
                stt::local::shutdown();
            }
            let _ = (app, &event);
        });
}
