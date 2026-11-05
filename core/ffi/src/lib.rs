//! C ABI over `polycarp-voice`, for the native Mac app (Swift).
//!
//! Rules every entry point follows:
//!
//! * **No panic crosses the boundary.** Each call runs inside `catch_unwind`; a panic becomes
//!   the failure value and an error message.
//! * **Errors.** Calls returning `int` give 0 for success and a negative `PC_ERR_*` code
//!   otherwise. Calls returning `char *` give NULL on failure. Either way the reason is read
//!   with `pc_last_error()` on the same thread.
//! * **Strings in** are NUL-terminated UTF-8, borrowed for the call. **Strings out** are
//!   allocated here and must be released with `pc_string_free`.
//! * **Thread-safe.** A `PcCore *` may be used from any thread at once. The two callbacks
//!   may run on any thread, including while the engine holds a short lock: return quickly,
//!   copy what you need, and do not call back into the library from inside a callback.
//! * **Handles.** `pc_open` makes one; `pc_close` frees it. Using a handle after `pc_close`,
//!   or closing it twice, is a caller error. The data folder is process-wide: open one
//!   handle per process.
//!
//! The header is `include/polycarp_core.h`; a test keeps it in step with this file.

use std::cell::RefCell;
use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use polycarp_voice::core::{Core, Host, Shared, Status};
use polycarp_voice::dictionary::Dictionary;
use polycarp_voice::store::{self, Settings};
use polycarp_voice::{audio, models, permissions};
use serde_json::{json, Value};

/// Bumped when an entry point changes shape.
pub const PC_ABI_VERSION: u32 = 1;

pub const PC_OK: c_int = 0;
pub const PC_ERR_ARG: c_int = -1;
pub const PC_ERR_FAILED: c_int = -2;
pub const PC_ERR_PANIC: c_int = -3;

/// `pc_open` flag: no global key listener and no background device pick. For tests and tools.
pub const PC_HEADLESS: u32 = 1;

pub type PcEventFn = Option<extern "C" fn(user: *mut c_void, event: *const c_char, json: *const c_char)>;
pub type PcLevelFn = Option<extern "C" fn(user: *mut c_void, level: c_float)>;

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn set_error(msg: impl AsRef<str>) {
    let clean = msg.as_ref().replace('\0', " ");
    LAST_ERROR.with(|e| *e.borrow_mut() = CString::new(clean).unwrap_or_default());
}

struct Callbacks {
    event: PcEventFn,
    level: PcLevelFn,
    user: *mut c_void,
}

// The caller promises `user` is usable from any thread (documented in the header).
unsafe impl Send for Callbacks {}
unsafe impl Sync for Callbacks {}

struct FfiHost(Callbacks);

impl Host for FfiHost {
    fn emit(&self, event: &str, payload: Value) {
        if let Some(cb) = self.0.event {
            if let (Ok(e), Ok(p)) = (CString::new(event), CString::new(payload.to_string())) {
                let _ = catch_unwind(AssertUnwindSafe(|| cb(self.0.user, e.as_ptr(), p.as_ptr())));
            }
        }
    }

    fn level(&self, level: f32) {
        if let Some(cb) = self.0.level {
            let _ = catch_unwind(AssertUnwindSafe(|| cb(self.0.user, level)));
        }
    }

    // The native app draws its own overlay and menu item from the `status` event.
    fn status_changed(&self, _: Status, _: bool) {}
    fn show_main(&self) {
        self.emit("show-main", json!({}));
    }
    fn listener_returned(&self) {
        self.emit("listener-returned", json!({}));
    }
}

/// Opaque to C.
pub struct PcCore {
    core: Shared,
    flags: u32,
}

fn guard<T>(fail: T, f: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            set_error(e);
            fail
        }
        Err(_) => {
            set_error("internal error (panic)");
            fail
        }
    }
}

fn code(f: impl FnOnce() -> Result<(), String>) -> c_int {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => PC_OK,
        Ok(Err(e)) => {
            let arg_error = e.starts_with("argument:");
            set_error(e);
            if arg_error {
                PC_ERR_ARG
            } else {
                PC_ERR_FAILED
            }
        }
        Err(_) => {
            set_error("internal error (panic)");
            PC_ERR_PANIC
        }
    }
}

fn text(f: impl FnOnce() -> Result<String, String>) -> *mut c_char {
    guard(std::ptr::null_mut(), || {
        let s = f()?;
        CString::new(s).map(CString::into_raw).map_err(|e| e.to_string())
    })
}

fn json_out<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

unsafe fn arg<'a>(p: *const c_char, what: &str) -> Result<&'a str, String> {
    if p.is_null() {
        return Err(format!("argument: {what} is NULL"));
    }
    CStr::from_ptr(p)
        .to_str()
        .map_err(|_| format!("argument: {what} is not UTF-8"))
}

unsafe fn handle<'a>(c: *const PcCore) -> Result<&'a PcCore, String> {
    c.as_ref().ok_or_else(|| "argument: core is NULL".to_string())
}

// ------------------------------------------------------------------ library

/// The ABI version this library was built with (`PC_ABI_VERSION`).
#[no_mangle]
pub extern "C" fn pc_abi_version() -> u32 {
    PC_ABI_VERSION
}

/// The message for the last failure on this thread, or "" if none. The pointer is valid until
/// the next call into the library on the same thread. Do not free it.
#[no_mangle]
pub extern "C" fn pc_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

/// Release a string returned by this library. NULL is fine.
///
/// # Safety
/// `s` must come from this library and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn pc_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

// ------------------------------------------------------------------ lifecycle

/// Create the engine. Nothing runs yet (no model load, no key listener): call `pc_start`.
///
/// `data_dir`: the folder for settings, dictionary, history and models. Created if missing.
/// `flags`: 0, or `PC_HEADLESS`. `on_event` receives `(user, event, json)` for `status`,
/// `transcript`, `learned`, `model-progress`, `benchmark-*`, `show-main`; `on_level` receives
/// the microphone level 0..1 while recording. Either may be NULL. Returns NULL on failure.
///
/// # Safety
/// `data_dir` must be a valid C string; `user` must be usable from any thread.
#[no_mangle]
pub unsafe extern "C" fn pc_open(
    data_dir: *const c_char,
    flags: u32,
    on_event: PcEventFn,
    on_level: PcLevelFn,
    user: *mut c_void,
) -> *mut PcCore {
    guard(std::ptr::null_mut(), || {
        let dir = PathBuf::from(arg(data_dir, "data_dir")?);
        std::fs::create_dir_all(&dir).map_err(|e| format!("data folder: {e}"))?;
        store::set_data_dir(Some(dir));
        let host = Arc::new(FfiHost(Callbacks { event: on_event, level: on_level, user }));
        let core = Core::new(host);
        Ok(Box::into_raw(Box::new(PcCore { core, flags })))
    })
}

/// Free the handle. Dictation stops being delivered. The key listener thread, if started,
/// ends with the process.
///
/// # Safety
/// `core` must come from `pc_open` and not be used afterward.
#[no_mangle]
pub unsafe extern "C" fn pc_close(core: *mut PcCore) {
    if core.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let b = Box::from_raw(core);
        b.core.set_enabled(false);
    }));
}

/// Start (or resume) dictation: load the chosen model, pick one for this device if none is
/// set, and listen for the hotkey. Safe to call again. Never unloads the model.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_start(core: *const PcCore) -> c_int {
    code(|| {
        let c = handle(core)?;
        c.core.set_enabled(true);
        if c.flags & PC_HEADLESS != 0 {
            c.core.load_model();
        } else {
            polycarp_voice::start_service(&c.core);
        }
        Ok(())
    })
}

/// Pause dictation: drop a recording in progress and ignore the hotkey. The model stays
/// loaded, so `pc_start` resumes at once.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_stop(core: *const PcCore) -> c_int {
    code(|| {
        handle(core)?.core.set_enabled(false);
        Ok(())
    })
}

/// Start or finish a dictation from a button, as a tap on the hotkey would.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_toggle_recording(core: *const PcCore) -> c_int {
    code(|| {
        let c = handle(core)?;
        if !c.core.is_enabled() {
            return Err("dictation is paused".into());
        }
        let out = c.core.machine.lock().toggle_from_ui();
        c.core.act(out);
        Ok(())
    })
}

// ------------------------------------------------------------------ state

/// JSON: `{status, detail, model, hotkey, hotkeyLabel, enabled, listener, permissions}`.
/// `status` is loading | needs_model | ready | recording | transcribing | typing | error.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_status(core: *const PcCore) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let (status, detail) = c.core.status();
        let hotkey = c.core.settings.lock().hotkey.clone();
        json_out(&json!({
            "status": status,
            "detail": detail,
            "model": c.core.active_model(),
            "hotkeyLabel": store::hotkey_label(&hotkey),
            "hotkey": hotkey,
            "enabled": c.core.is_enabled(),
            "listener": c.core.listener_ok.load(std::sync::atomic::Ordering::Relaxed),
            "permissions": permissions::check(),
        }))
    })
}

// ------------------------------------------------------------------ settings

/// The settings as JSON (camelCase keys: hotkey, tapToToggle, model, language, ...).
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_settings_get(core: *const PcCore) -> *mut c_char {
    text(|| json_out(&handle(core)?.core.settings.lock().clone()))
}

/// Replace the settings with `json` (same shape as `pc_settings_get`; missing keys take
/// defaults). The model and who chose it are kept; change models with `pc_model_select`.
/// The hotkey must parse. Returns the stored settings as JSON, or NULL.
///
/// # Safety
/// `core` must be a live handle; `json` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_settings_set(core: *const PcCore, json: *const c_char) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let s: Settings = serde_json::from_str(arg(json, "json")?).map_err(|e| format!("settings: {e}"))?;
        let (stored, _) = c.core.apply_settings(s)?;
        json_out(&stored)
    })
}

/// Wait up to `timeout_ms` for the user to press the key to use as the hotkey; returns its
/// name (as stored in settings) or NULL on timeout. Blocks: call off the main thread.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_hotkey_capture(core: *const PcCore, timeout_ms: u32) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let (tx, rx) = std::sync::mpsc::channel();
        *c.core.capture.lock() = Some(tx);
        let got = rx.recv_timeout(Duration::from_millis(timeout_ms as u64));
        c.core.capture.lock().take();
        got.map_err(|_| "No key pressed".to_string())
    })
}

/// JSON array of microphone names. Listing never opens a microphone.
#[no_mangle]
pub extern "C" fn pc_microphones() -> *mut c_char {
    text(|| json_out(&audio::microphones()))
}

// ------------------------------------------------------------------ models

/// JSON array of models: id, name, size, installed, active, recommendation fields.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_models_list(core: *const PcCore) -> *mut c_char {
    text(|| {
        let active = handle(core)?.core.settings.lock().model.clone();
        json_out(&models::list(Some(&active)))
    })
}

/// Choose an installed model and load it. `auto` is nonzero when setup picks for the user.
///
/// # Safety
/// `core` must be a live handle; `id` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_model_select(core: *const PcCore, id: *const c_char, auto: c_int) -> c_int {
    code(|| {
        let c = handle(core)?;
        let id = arg(id, "id")?;
        if !models::installed(id) {
            return Err("Download that model first".into());
        }
        c.core.select_model(id, auto != 0);
        Ok(())
    })
}

/// Download a model. Blocks until done; progress arrives as `model-progress` events. Call
/// off the main thread. The first model downloaded becomes the active one.
///
/// # Safety
/// `core` must be a live handle; `id` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_model_download(core: *const PcCore, id: *const c_char) -> c_int {
    code(|| {
        let c = handle(core)?;
        let id = arg(id, "id")?;
        c.core.download_model(id).map_err(|e| e.to_string())
    })
}

/// Delete a downloaded model. Refuses while it is the active one.
///
/// # Safety
/// `core` must be a live handle; `id` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_model_delete(core: *const PcCore, id: *const c_char) -> c_int {
    code(|| {
        let c = handle(core)?;
        let id = arg(id, "id")?;
        if c.core.settings.lock().model == id && c.core.active_model().is_some() {
            return Err("Switch to another model before removing this one".into());
        }
        models::remove(id).map_err(|e| e.to_string())
    })
}

// ------------------------------------------------------------------ dictionary

fn with_dict(c: &PcCore, f: impl FnOnce(&mut Dictionary)) -> Result<String, String> {
    let mut d = c.core.dict.lock();
    f(&mut d);
    store::save("dictionary.json", &*d);
    json_out(&*d)
}

/// The dictionary (terms, corrections, pending suggestions) as JSON.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_get(core: *const PcCore) -> *mut c_char {
    text(|| json_out(&handle(core)?.core.dict.lock().clone()))
}

/// Merge a dictionary exported earlier (JSON) into this one and save. Returns the new
/// dictionary as JSON.
///
/// # Safety
/// `core` must be a live handle; `json` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_import(core: *const PcCore, json: *const c_char) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let json = arg(json, "json")?;
        let mut d = c.core.dict.lock();
        d.import(json)
            .map_err(|e| format!("That isn't a dictionary Polycarp can read: {e}"))?;
        store::save("dictionary.json", &*d);
        json_out(&*d)
    })
}

/// Add a term (a word spelled as the user spells it). Returns the dictionary as JSON.
///
/// # Safety
/// `core` must be a live handle; `term` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_add_term(core: *const PcCore, term: *const c_char) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let t = arg(term, "term")?;
        with_dict(c, |d| {
            d.add_term(t, "user");
        })
    })
}

/// Remove a term. Returns the dictionary as JSON.
///
/// # Safety
/// `core` must be a live handle; `term` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_remove_term(core: *const PcCore, term: *const c_char) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let t = arg(term, "term")?;
        with_dict(c, |d| d.remove_term(t))
    })
}

/// Add a correction: whenever `from` is heard, write `to`. Returns the dictionary as JSON.
///
/// # Safety
/// `core` must be a live handle; both strings valid C strings.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_add_correction(
    core: *const PcCore,
    from: *const c_char,
    to: *const c_char,
) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let (f, t) = (arg(from, "from")?, arg(to, "to")?);
        with_dict(c, |d| {
            d.add_correction(f, t, "user");
        })
    })
}

/// Remove a correction by its `from`. Returns the dictionary as JSON.
///
/// # Safety
/// `core` must be a live handle; `from` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_dictionary_remove_correction(core: *const PcCore, from: *const c_char) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let f = arg(from, "from")?;
        with_dict(c, |d| d.remove_correction(f))
    })
}

// ------------------------------------------------------------------ history

/// The newest `limit` dictations as JSON (id, ts, text, raw, durationS, latencyMs, words,
/// corrected). `limit` 0 means all kept (up to 1000).
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_history_get(core: *const PcCore, limit: u32) -> *mut c_char {
    text(|| {
        let c = handle(core)?;
        let h = c.core.history.lock();
        let n = if limit == 0 { h.len() } else { limit as usize };
        json_out(&h.iter().take(n).cloned().collect::<Vec<_>>())
    })
}

/// Delete one dictation from History by id.
///
/// # Safety
/// `core` must be a live handle; `id` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn pc_history_delete(core: *const PcCore, id: *const c_char) -> c_int {
    code(|| {
        let c = handle(core)?;
        let id = arg(id, "id")?;
        let mut h = c.core.history.lock();
        h.retain(|i| i.id != id);
        store::save("history.json", &*h);
        Ok(())
    })
}

/// Clear History.
///
/// # Safety
/// `core` must be a live handle.
#[no_mangle]
pub unsafe extern "C" fn pc_history_clear(core: *const PcCore) -> c_int {
    code(|| {
        let c = handle(core)?;
        let mut h = c.core.history.lock();
        h.clear();
        store::save("history.json", &*h);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The data folder is process-wide, so tests that open a handle run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());
    static EVENTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    static LEVELS: AtomicUsize = AtomicUsize::new(0);

    extern "C" fn on_event(_: *mut c_void, e: *const c_char, j: *const c_char) {
        let (e, j) = unsafe { (CStr::from_ptr(e).to_string_lossy().into_owned(), CStr::from_ptr(j).to_string_lossy().into_owned()) };
        EVENTS.lock().push((e, j));
    }
    extern "C" fn on_level(_: *mut c_void, _: f32) {
        LEVELS.fetch_add(1, Ordering::Relaxed);
    }

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    /// Take a string result and free it, parsed as JSON.
    unsafe fn json(p: *mut c_char) -> Value {
        assert!(!p.is_null(), "failed: {}", CStr::from_ptr(pc_last_error()).to_string_lossy());
        let v = serde_json::from_str(&CStr::from_ptr(p).to_string_lossy()).unwrap();
        pc_string_free(p);
        v
    }

    fn last_error() -> String {
        unsafe { CStr::from_ptr(pc_last_error()).to_string_lossy().into_owned() }
    }

    struct Open {
        core: *mut PcCore,
        _dir: tempfile::TempDir,
        _lock: parking_lot::MutexGuard<'static, ()>,
    }

    impl Drop for Open {
        fn drop(&mut self) {
            unsafe { pc_close(self.core) };
            store::set_data_dir(None);
        }
    }

    fn open() -> Open {
        let lock = SERIAL.lock();
        let dir = tempfile::tempdir().unwrap();
        let d = c(dir.path().to_str().unwrap());
        let core = unsafe { pc_open(d.as_ptr(), PC_HEADLESS, Some(on_event), Some(on_level), std::ptr::null_mut()) };
        assert!(!core.is_null(), "{}", last_error());
        Open { core, _dir: dir, _lock: lock }
    }

    #[test]
    fn abi_version_matches_the_header() {
        assert_eq!(pc_abi_version(), PC_ABI_VERSION);
        let h = include_str!("../include/polycarp_core.h");
        assert!(h.contains(&format!("#define PC_ABI_VERSION {PC_ABI_VERSION}u")));
    }

    #[test]
    fn the_header_declares_every_entry_point() {
        let src = include_str!("lib.rs");
        let h = include_str!("../include/polycarp_core.h");
        let body = src.split("#[cfg(test)]").next().unwrap();
        let mut n = 0;
        for line in body.lines() {
            if let Some(rest) = line.split("extern \"C\" fn ").nth(1) {
                let name = rest.split('(').next().unwrap();
                assert!(h.contains(&format!("{name}(")), "{name} is missing from polycarp_core.h");
                n += 1;
            }
        }
        assert_eq!(n, 26, "an entry point was added or removed: update this count and the header");
    }

    #[test]
    fn last_error_and_string_free_accept_nothing_and_everything() {
        unsafe { pc_string_free(std::ptr::null_mut()) };
        let _ = unsafe { pc_settings_get(std::ptr::null()) };
        assert!(last_error().contains("NULL"));
        let s = CString::new("x").unwrap().into_raw();
        unsafe { pc_string_free(s) };
    }

    #[test]
    fn open_and_close_make_and_release_a_handle() {
        let o = open();
        assert!(!o.core.is_null());
        unsafe { pc_close(std::ptr::null_mut()) }; // NULL is fine
        let bad = unsafe { pc_open(std::ptr::null(), 0, None, None, std::ptr::null_mut()) };
        assert!(bad.is_null());
        assert!(last_error().contains("data_dir"));
    }

    #[test]
    fn start_stop_and_toggle_never_touch_the_mic_without_a_model() {
        let o = open();
        unsafe {
            assert_eq!(pc_start(o.core), PC_OK);
            let st = json(pc_status(o.core));
            assert_eq!(st["status"], "needs_model", "{st}");
            assert_eq!(st["enabled"], true);
            // No model: the toggle is ignored before any recording starts.
            assert_eq!(pc_toggle_recording(o.core), PC_OK);
            assert_eq!(json(pc_status(o.core))["status"], "needs_model");
            assert_eq!(pc_stop(o.core), PC_OK);
            assert_eq!(json(pc_status(o.core))["enabled"], false);
            assert_eq!(pc_toggle_recording(o.core), PC_ERR_FAILED);
            assert!(last_error().contains("paused"));
            assert_eq!(pc_start(o.core), PC_OK);
            assert_eq!(json(pc_status(o.core))["enabled"], true);
            assert_eq!(pc_start(std::ptr::null()), PC_ERR_ARG);
        }
        assert!(EVENTS.lock().iter().any(|(e, _)| e == "status"));
    }

    #[test]
    fn status_reports_the_hotkey() {
        let o = open();
        let st = unsafe { json(pc_status(o.core)) };
        assert!(st["hotkey"].is_string());
        assert!(st["hotkeyLabel"].is_string());
        assert!(st["permissions"].is_object());
    }

    #[test]
    fn settings_round_trip_and_keep_the_model() {
        let o = open();
        unsafe {
            let mut s = json(pc_settings_get(o.core));
            let model = s["model"].clone();
            s["trailingSpace"] = json!(!s["trailingSpace"].as_bool().unwrap());
            s["model"] = json!("not-a-model");
            let j = c(&s.to_string());
            let stored = json(pc_settings_set(o.core, j.as_ptr()));
            assert_eq!(stored["trailingSpace"], s["trailingSpace"]);
            assert_eq!(stored["model"], model, "the model belongs to the core");
            assert_eq!(json(pc_settings_get(o.core))["trailingSpace"], s["trailingSpace"]);
            // It reached disk.
            assert!(store::exists("settings.json"));
            // A hotkey that does not parse is refused.
            s["hotkey"] = json!("NotAKey");
            let j = c(&s.to_string());
            assert!(pc_settings_set(o.core, j.as_ptr()).is_null());
            assert!(last_error().contains("not a key"));
            let junk = c("{not json");
            assert!(pc_settings_set(o.core, junk.as_ptr()).is_null());
            assert!(pc_settings_set(o.core, std::ptr::null()).is_null());
        }
    }

    #[test]
    fn hotkey_capture_times_out_without_a_key() {
        let o = open();
        let p = unsafe { pc_hotkey_capture(o.core, 20) };
        assert!(p.is_null());
        assert!(last_error().contains("No key"));
    }

    #[test]
    fn microphones_lists_names_as_json() {
        let v = unsafe { json(pc_microphones()) };
        assert!(v.is_array());
    }

    #[test]
    fn models_list_select_download_and_delete_guard_their_input() {
        let o = open();
        unsafe {
            let list = json(pc_models_list(o.core));
            let arr = list.as_array().unwrap();
            assert!(!arr.is_empty());
            assert!(arr.iter().all(|m| m["installed"] == false), "temp folder has no models");
            let id = c(arr[0]["id"].as_str().unwrap());
            // Not installed: refused, nothing is downloaded by select.
            assert_eq!(pc_model_select(o.core, id.as_ptr(), 0), PC_ERR_FAILED);
            assert!(last_error().contains("Download"));
            assert_eq!(pc_model_select(o.core, std::ptr::null(), 0), PC_ERR_ARG);
            // Deleting a model that is not there is not an error that panics.
            let r = pc_model_delete(o.core, id.as_ptr());
            assert!(r == PC_OK || r == PC_ERR_FAILED);
            assert_eq!(pc_model_delete(o.core, std::ptr::null()), PC_ERR_ARG);
            // An unknown id fails without touching the network.
            let bad = c("no-such-model");
            assert_eq!(pc_model_download(o.core, bad.as_ptr()), PC_ERR_FAILED);
            assert_eq!(pc_model_download(o.core, std::ptr::null()), PC_ERR_ARG);
        }
    }

    #[test]
    fn dictionary_reads_and_writes_through_to_disk() {
        let o = open();
        unsafe {
            let t = c("Polycarp");
            let d = json(pc_dictionary_add_term(o.core, t.as_ptr()));
            assert!(d.to_string().contains("Polycarp"));
            let from = c("poly carp");
            let to = c("Polycarp");
            let d = json(pc_dictionary_add_correction(o.core, from.as_ptr(), to.as_ptr()));
            assert!(d.to_string().contains("poly carp"));
            let export = json(pc_dictionary_get(o.core)).to_string();
            assert!(store::read_raw("dictionary.json").contains("Polycarp"));
            let d = json(pc_dictionary_remove_correction(o.core, from.as_ptr()));
            assert!(!d["corrections"].to_string().contains("poly carp"));
            let d = json(pc_dictionary_remove_term(o.core, t.as_ptr()));
            assert!(!d["terms"].to_string().contains("Polycarp"));
            // Import brings the export back.
            let e = c(&export);
            let d = json(pc_dictionary_import(o.core, e.as_ptr()));
            assert!(d.to_string().contains("Polycarp"));
            let junk = c("[1,2");
            assert!(pc_dictionary_import(o.core, junk.as_ptr()).is_null());
            assert!(pc_dictionary_add_term(o.core, std::ptr::null()).is_null());
        }
    }

    #[test]
    fn history_reads_deletes_and_clears() {
        let mut o = open();
        // Seed a history file and reopen so the core loads it.
        let item = |id: &str| json!({"id": id, "ts": "2026-11-05T10:00:00Z", "text": "hello", "raw": "hello",
            "durationS": 1.0, "latencyMs": 100, "words": 1, "corrected": null});
        store::save("history.json", &json!([item("a"), item("b"), item("c")]));
        unsafe {
            pc_close(o.core);
            let d = c(store::data_dir().to_str().unwrap());
            let core = pc_open(d.as_ptr(), PC_HEADLESS, None, None, std::ptr::null_mut());
            assert!(!core.is_null());
            o.core = core; // dropped (closed) with `o`
            assert_eq!(json(pc_history_get(core, 0)).as_array().unwrap().len(), 3);
            assert_eq!(json(pc_history_get(core, 2)).as_array().unwrap().len(), 2);
            let id = c("b");
            assert_eq!(pc_history_delete(core, id.as_ptr()), PC_OK);
            let left = json(pc_history_get(core, 0));
            assert_eq!(left.as_array().unwrap().len(), 2);
            assert!(!left.to_string().contains("\"b\""));
            assert_eq!(pc_history_delete(core, std::ptr::null()), PC_ERR_ARG);
            assert_eq!(pc_history_clear(core), PC_OK);
            assert_eq!(json(pc_history_get(core, 0)).as_array().unwrap().len(), 0);
            assert_eq!(store::read_raw("history.json").trim(), "[]");
        }
    }

    #[test]
    fn a_panic_in_a_call_becomes_an_error_not_a_crash() {
        assert_eq!(code(|| panic!("boom")), PC_ERR_PANIC);
        assert!(last_error().contains("panic"));
        let p = text(|| -> Result<String, String> { panic!("boom") });
        assert!(p.is_null());
    }
}
