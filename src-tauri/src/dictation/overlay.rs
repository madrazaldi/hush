//! The recording indicator: a small, non-activating, click-through pill that
//! floats above everything (including full-screen apps) on the active screen.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

use crate::settings::OverlayPosition;

pub const LABEL: &str = "overlay";
pub const WIDTH: f64 = 260.0;
pub const HEIGHT: f64 = 72.0;

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(OverlayPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};
        let panel = PanelBuilder::<_, OverlayPanel>::new(app, LABEL)
            .url(WebviewUrl::App("overlay".into()))
            .title("Hush")
            .size(tauri::Size::Logical(LogicalSize::new(WIDTH, HEIGHT)))
            .level(PanelLevel::Status)
            .corner_radius(0.0)
            .style_mask(StyleMask::empty().borderless().nonactivating_panel())
            // Start undecorated: removing a title bar after WebKit attached its
            // observers makes AppKit reject the style-mask change.
            .with_window(|w| w.decorations(false).transparent(true).focusable(false).visible(false))
            .collection_behavior(
                CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().ignores_cycle(),
            )
            .transparent(true)
            .opaque(false)
            .has_shadow(false)
            .hides_on_deactivate(false)
            .ignores_mouse_events(true)
            .no_activate(true)
            .build()?;
        panel.hide();
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay".into()))
            .title("Hush")
            .inner_size(WIDTH, HEIGHT)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .visible(false)
            .build()?;
    }
    Ok(())
}

/// Place the overlay on the monitor containing the mouse cursor.
fn position(app: &AppHandle, pos: OverlayPosition) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let scale = m.scale_factor();
    let area = m.work_area();
    let (ax, ay) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (aw, ah) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
    let x = ax + (aw - WIDTH) / 2.0;
    let y = match pos {
        OverlayPosition::Top => ay + 12.0,
        _ => ay + ah - HEIGHT - 28.0,
    };
    let _ = win.set_position(LogicalPosition::new(x, y));
}

pub fn show(app: &AppHandle, pos: OverlayPosition) {
    if pos == OverlayPosition::Hidden {
        return;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        position(&app2, pos);
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app2.get_webview_panel(LABEL) {
                panel.order_front_regardless();
                panel.show();
            }
        }
        #[cfg(not(target_os = "macos"))]
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.show();
        }
    });
}

pub fn hide(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app2.get_webview_panel(LABEL) {
                panel.hide();
            }
        }
        #[cfg(not(target_os = "macos"))]
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.hide();
        }
    });
}
