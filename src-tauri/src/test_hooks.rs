//! Test-only hooks, compiled in only with `--features test-hooks`, which is
//! refused for a release build. With FW_TEST_SCRIPT set to a JavaScript file,
//! the shell evaluates that file in the main window after every page load; the
//! script reports results through the `test_report` command, which prints them
//! to stdout as `FWTEST ...` lines. The dialog plugin is replaced by a stand-in
//! with the same name and commands, since the native save/open panel needs a
//! person: it "picks" the path in FW_TEST_PICK, adds it to the fs scope the way
//! the dialog plugin does after a pick, and returns it. The address-parity and
//! backup round-trip check in scripts/app-check.mjs drives the app this way.
//! On macOS the test build also keeps the page active while its window is
//! occluded (see keep_page_active) and can snapshot the webview
//! (`test_snapshot`).

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

/// Write a TIFF snapshot of the main webview to `path`. A sandboxed frame has
/// an opaque origin, so the page cannot see what it rendered; the art check in
/// scripts/app-check.mjs reads the pixels from this snapshot instead.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn test_snapshot<R: Runtime>(window: tauri::WebviewWindow<R>, path: String) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |pw| {
            let tx = tx.clone();
            let done = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                // SAFETY: WebKit passes a valid NSImage or null.
                let tiff = unsafe { image.as_ref() }.and_then(|i| i.TIFFRepresentation());
                let _ = tx.send(tiff.map(|d| d.to_vec()).ok_or_else(|| "no snapshot".to_string()));
            });
            // SAFETY: on macOS the platform webview is a WKWebView, and
            // with_webview runs this closure on the main thread.
            unsafe {
                let webview = &*(pw.inner() as *const WKWebView);
                webview.takeSnapshotWithConfiguration_completionHandler(None, &done);
            }
        })
        .map_err(|e| e.to_string())?;
    let bytes = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|e| e.to_string())??;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
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
            #[cfg(target_os = "macos")]
            let _ = w.with_webview(|pw| keep_page_active(pw.inner()));
            let _ = w.eval(&script);
        }
    })
}

/// The test window runs on a build host whose screen may be locked, so the
/// window is never visible. WebKit then marks the page hidden, throttles its
/// timers and, a few seconds after load, suspends its web content process, so
/// a test script stalls wherever it happens to be. Three WebKit SPI switches
/// (all optional: each is checked before it is sent) turn off window occlusion
/// detection on the WKWebView, and hidden-page timer throttling and process
/// suppression on its WKPreferences. They put timers back on schedule, but a
/// page that sits idle can still be suspended, so the scripts in
/// scripts/app-check.mjs also keep a heartbeat. Test builds only.
#[cfg(target_os = "macos")]
fn keep_page_active(webview: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};

    unsafe fn responds(obj: &AnyObject, sel: Sel, name: &str) -> bool {
        let known: Bool = msg_send![obj, respondsToSelector: sel];
        println!("FWHOOK {name}={}", known.as_bool());
        known.as_bool()
    }

    // SAFETY: on macOS the platform webview is a WKWebView, and with_webview
    // runs this on the main thread. WKWebView's configuration is a shallow
    // copy, so its preferences object is the one the page uses.
    unsafe {
        let wv = &*(webview as *const AnyObject);
        if responds(wv, sel!(_setWindowOcclusionDetectionEnabled:), "occlusionDetection") {
            let _: () = msg_send![wv, _setWindowOcclusionDetectionEnabled: Bool::NO];
        }
        let config: *mut AnyObject = msg_send![wv, configuration];
        let Some(config) = config.as_ref() else { return };
        let prefs: *mut AnyObject = msg_send![config, preferences];
        let Some(prefs) = prefs.as_ref() else { return };
        if responds(prefs, sel!(_setHiddenPageDOMTimerThrottlingEnabled:), "hiddenTimerThrottling") {
            let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingEnabled: Bool::NO];
        }
        if responds(prefs, sel!(_setPageVisibilityBasedProcessSuppressionEnabled:), "processSuppression") {
            let _: () = msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: Bool::NO];
        }
    }
}
