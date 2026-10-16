//! Menu-bar tray: quick dictation / meeting controls.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::state;

const TRAY_ID: &str = "hush-tray";

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let st = state::get();
    let s = st.settings();
    let recording_meeting = st.meetings.active_id().is_some();
    let dictate = MenuItem::with_id(app, "dictate", format!("Dictate  ({})", s.dictation.hotkey), true, None::<&str>)?;
    let meeting = MenuItem::with_id(
        app,
        "meeting",
        if recording_meeting { "Stop meeting recording" } else { "Start meeting recording" },
        true,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "Open Hush", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hush", true, Some("CmdOrCtrl+Q"))?;
    Menu::with_items(
        app,
        &[
            &dictate,
            &meeting,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "dictate" => {
                std::thread::spawn(|| state::get().dictation.toggle());
            }
            "meeting" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let st = state::get();
                    if st.meetings.active_id().is_some() {
                        if let Ok(id) = st.meetings.stop().await {
                            crate::show_main(&app, Some(&format!("/meetings/{id}")));
                        }
                    } else {
                        match tokio::task::spawn_blocking(|| state::get().meetings.start(None, None)).await {
                            Ok(Ok(rec)) => crate::show_main(&app, Some(&format!("/meetings/{}", rec.id))),
                            Ok(Err(e)) => crate::notify(&app, "Couldn't start recording", &format!("{e}")),
                            Err(_) => {}
                        }
                    }
                });
            }
            "open" => crate::show_main(app, None),
            "settings" => crate::show_main(app, Some("/settings")),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the menu to reflect current state.
pub fn refresh() {
    let st = state::get();
    let app = st.app.clone();
    let _ = st.app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(&app)) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = app.get_webview_window("main");
    });
}
