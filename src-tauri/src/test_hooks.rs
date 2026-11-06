//! Test-only hooks, compiled in only with `--features test-hooks`, which is
//! refused for a release build. With FW_TEST_SCRIPT set to a JavaScript file,
//! the shell evaluates that file in the main window after every page load; the
//! script reports results through the `test_report` command, which prints them
//! to stdout as `FWTEST ...` lines. The dialog plugin is replaced by a stand-in
//! with the same name and commands, since the native save/open panel needs a
//! person: it "picks" the path in FW_TEST_PICK, adds it to the fs scope the way
//! the dialog plugin does after a pick, and returns it. The address-parity and
//! backup round-trip check in scripts/app-check.mjs drives the app this way.

#[cfg(not(debug_assertions))]
compile_error!("the test-hooks feature is for debug builds only");

use tauri::webview::PageLoadEvent;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Runtime, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

#[tauri::command]
pub fn test_report(text: String) {
    println!("FWTEST {text}");
}

mod panel {
    use super::*;

    fn pick<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
        let Some(path) = std::env::var_os("FW_TEST_PICK") else { return Ok(None) };
        let path = path.to_string_lossy().into_owned();
        app.fs_scope().allow_file(&path).map_err(|e| e.to_string())?;
        Ok(Some(path))
    }

    #[tauri::command]
    pub fn save<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
        pick(&app)
    }

    #[tauri::command]
    pub fn open<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
        pick(&app)
    }
}

pub fn dialog_stand_in<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("dialog")
        .invoke_handler(tauri::generate_handler![panel::save, panel::open])
        .build()
}

pub fn attach<'a, R: Runtime, M: tauri::Manager<R>>(
    window: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let Some(script) = std::env::var_os("FW_TEST_SCRIPT").and_then(|p| std::fs::read_to_string(p).ok()) else {
        return window;
    };
    window.on_page_load(move |w, p| {
        if p.event() == PageLoadEvent::Finished {
            let _ = w.eval(&script);
        }
    })
}
