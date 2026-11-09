//! FreeWallet desktop shell.
//!
//! The wallet itself is the web app (index.html, html/, js/, css/, images/),
//! staged into `web/` by `scripts/stage.mjs`. The page still calls the NW.js API
//! (`require('nw.gui')`, `nw.Shell`, `nw.Clipboard`, `nw.Menu`, `nw.App`);
//! `shim/fw-host.js` provides that surface on top of Tauri and is injected into
//! the main frame before any page script runs.

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

#[cfg(feature = "test-hooks")]
mod test_hooks;

const HOST_SHIM: &str = include_str!("../shim/fw-host.js");

/// Origins an iframe inside the wallet may load. Every other navigation, top
/// level or framed, is cancelled; links leave through the opener plugin.
const FRAME_ORIGINS: &[&str] = &["https://www.youtube.com", "https://w.soundcloud.com"];

fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        // The bundled app (macOS serves it as tauri://localhost).
        "tauri" => url.host_str() == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "https" => FRAME_ORIGINS.contains(&url.origin().ascii_serialization().as_str()),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init());
    #[cfg(not(feature = "test-hooks"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "test-hooks")]
    let builder = builder
        .plugin(test_hooks::dialog_stand_in())
        .invoke_handler(tauri::generate_handler![test_hooks::test_report]);
    builder
        .setup(|app| {
            // nw.App.manifest.version is read synchronously by the page, so the
            // version is handed to the shim before it runs.
            let boot = format!(
                "window.__FW_HOST_BOOT__ = Object.freeze({{ version: {} }});\n",
                serde_json::to_string(&app.package_info().version.to_string())?
            );
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("FreeWallet")
                .inner_size(1200.0, 768.0)
                .min_inner_size(1024.0, 768.0)
                .resizable(true)
                .initialization_script(boot + HOST_SHIM)
                .on_navigation(|url| navigation_allowed(url));
            #[cfg(feature = "test-hooks")]
            let window = test_hooks::attach(window);
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running FreeWallet");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(u: &str) -> bool {
        navigation_allowed(&Url::parse(u).unwrap())
    }

    #[test]
    fn navigation_stays_in_the_app() {
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("about:blank"));
        assert!(allowed("https://www.youtube.com/embed/x"));
        assert!(allowed("https://w.soundcloud.com/player/?url=x"));
        assert!(!allowed("tauri://evil/index.html"));
        assert!(!allowed("https://example.com/"));
        assert!(!allowed("http://www.youtube.com/embed/x"));
        assert!(!allowed("https://www.youtube.com.evil.com/"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("about:config"));
    }
}
