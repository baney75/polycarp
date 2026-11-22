//! The top bar (`spec/bar.md`): one AppBar docked to the top of each display, so a maximized window stops below it.
//! Left, the workspace numbers (each one in use and the one this display shows, the current one bright over a 2 px
//! accent line); center, the day and the clock; right, Polycarp's mark, which opens nothing yet. Drawn with GDI in the
//! Polycarp theme's colors, or the built-in dark look.
//!
//! It runs in the daemon on a thread of its own with its own message loop, per-monitor DPI aware (v2). It never takes
//! the core's lock: the daemon hands it each shell state line as it publishes one (`publish`, the same `ShellState`
//! the shell's feed sends), and a click on a number goes to the worker as the chord `switch n --monitor <this display>`,
//! the path Win+n takes, asked from the bar's own display (R-S7).
//! Nothing here waits on the hook threads or the worker.
//!
//! The thread's state is a `RefCell` the window procedure only ever tries to borrow: a Win32 call made while it is
//! borrowed (SetWindowPos, SHAppBarMessage) can send a message straight back into the procedure, which then does
//! the stateless part and posts the rest to the loop.
//!
//! Every second a timer redraws the clock and looks again at the theme file (its size and time), Windows' app mode,
//! its 12- or 24-hour clock and the accent color. A file watch would wake sooner; a 1 s look is cheap and also covers
//! the registry and locale settings, which have no watch of their own.

use crate::daemon::say;
use crate::hook::Msg;
use baneyspaces_core::bar::{self as rule, Colors, Rgb};
use baneyspaces_core::shell::ShellState;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, SYSTEMTIME, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmGetColorizationColor;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::System::SystemInformation::GetLocalTime;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABE_TOP, ABM_ACTIVATE, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, APPBARDATA};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

/// The bar window's class: the live test finds the bars by it.
pub const CLASS: &str = "PolycarpBar";

// Thread messages (no window): what the daemon and the window procedure hand the loop.
const WM_BAR_ENABLE: u32 = WM_APP + 40; // wparam 1 on, 0 off
const WM_BAR_STATE: u32 = WM_APP + 41; // a new state line is in LATEST
const WM_BAR_REDOCK: u32 = WM_APP + 42; // wparam: the bar whose position may have changed
const WM_BAR_REBUILD: u32 = WM_APP + 43; // the displays changed; wparam 1: explorer.exe restarted
const WM_BAR_FULLSCREEN: u32 = WM_APP + 44; // wparam: the bar told; lparam 1: a full-screen app opened, 0: it went
const WM_BAR_REPAINT: u32 = WM_APP + 45;
const WM_BAR_QUIT: u32 = WM_APP + 46;
// The AppBar's own notifications, to each bar window.
const WM_BAR_CALLBACK: u32 = WM_APP + 47;

/// Font families, the first installed wins (`spec/bar.md`).
const FONTS: &[&str] = &["Cascadia Mono", "Consolas"];
/// The text's height at 96 dpi, in pixels, and the space around each workspace number and at the bar's ends.
const TEXT_PX: i32 = 13;
const PAD_PX: i32 = 6;
const UNDERLINE_PX: i32 = 2;
const MARK_PX: i32 = 8;

static THREAD: AtomicU32 = AtomicU32::new(0);
static DONE: AtomicBool = AtomicBool::new(false);
static REBUILD_POSTED: AtomicBool = AtomicBool::new(false);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
/// The newest shell state line the daemon published.
static LATEST: Mutex<Option<String>> = Mutex::new(None);
/// The bars registered with the shell now (hwnds), so a crash path can remove them from any thread.
static LIVE: Mutex<Vec<isize>> = Mutex::new(Vec::new());
/// What `state` reports under `bar`.
static STATUS: Mutex<Option<Value>> = Mutex::new(None);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn post(msg: u32, wp: usize, lp: isize) {
    let t = THREAD.load(Ordering::Acquire);
    if t != 0 {
        unsafe { PostThreadMessageW(t, msg, wp, lp) };
    }
}

/// Starts the bar's thread, with the bar on if `on`. `tx` is the worker's channel, where a click sends its switch.
pub fn start(tx: Sender<Msg>, on: bool) {
    if THREAD.load(Ordering::Acquire) != 0 {
        return;
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name("bar".into()).spawn(move || unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        // The thread's queue exists once it has peeked, so a message posted from now on is kept.
        let mut msg: MSG = std::mem::zeroed();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        let hi = GetModuleHandleW(std::ptr::null());
        let class = wide(CLASS);
        let wc = WNDCLASSW { style: 0, lpfnWndProc: Some(bar_proc), cbClsExtra: 0, cbWndExtra: 0, hInstance: hi, hIcon: std::ptr::null_mut(), hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW), hbrBackground: std::ptr::null_mut(), lpszMenuName: std::ptr::null(), lpszClassName: class.as_ptr() };
        RegisterClassW(&wc);
        TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::Relaxed);
        UI.with(|u| *u.borrow_mut() = Some(Ui::new(tx)));
        THREAD.store(GetCurrentThreadId(), Ordering::Release);
        let _ = ready_tx.send(());
        write_status(&Ui::off_status());
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.hwnd.is_null() {
                if msg.message == WM_BAR_QUIT {
                    break;
                }
                on_thread_message(msg.message, msg.wParam, msg.lParam);
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        with_ui(|ui| ui.disable());
        DONE.store(true, Ordering::SeqCst);
    });
    if spawned.is_err() || ready_rx.recv_timeout(Duration::from_secs(5)).is_err() {
        say("baneyspaces daemon: bar: its thread did not start; bar.enabled has no effect");
        return;
    }
    if on {
        set_enabled(true);
    }
}

/// Turns the bar on or off at once (`bar.enabled`).
pub fn set_enabled(on: bool) {
    post(WM_BAR_ENABLE, on as usize, 0);
}

/// The shell state the daemon just published. Never blocks: the line is kept and the bar's thread told.
pub fn publish(line: &str) {
    if THREAD.load(Ordering::Acquire) == 0 {
        // Kept for when the thread starts.
        if let Ok(mut l) = LATEST.lock() {
            *l = Some(line.to_string());
        }
        return;
    }
    let changed = match LATEST.lock() {
        Ok(mut l) if l.as_deref() != Some(line) => {
            *l = Some(line.to_string());
            true
        }
        _ => false,
    };
    if changed {
        post(WM_BAR_STATE, 0, 0);
    }
}

/// What `state` shows under `bar`: on or off, the font and theme drawn, and each bar's rect and number cells.
pub fn status() -> Value {
    STATUS.lock().ok().and_then(|s| s.clone()).unwrap_or_else(Ui::off_status)
}

fn write_status(v: &Value) {
    if let Ok(mut s) = STATUS.lock() {
        *s = Some(v.clone());
    }
}

/// Takes the bars down (the work area comes back) and ends the thread, waiting up to 2 s.
pub fn stop() {
    if THREAD.load(Ordering::Acquire) == 0 {
        return;
    }
    post(WM_BAR_QUIT, 0, 0);
    let t = Instant::now();
    while !DONE.load(Ordering::SeqCst) && t.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !DONE.load(Ordering::SeqCst) {
        remove_all();
    }
}

/// From any thread, on a path that ends the process (a panic, the session ending): every bar is taken off the shell's
/// list so the work area comes back. The windows go with the process.
pub fn remove_all() {
    let t = Instant::now();
    let list = loop {
        match LIVE.try_lock() {
            Ok(g) => break g.clone(),
            Err(std::sync::TryLockError::Poisoned(p)) => break p.into_inner().clone(),
            Err(_) if t.elapsed() < Duration::from_millis(200) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return,
        }
    };
    for h in list {
        appbar(ABM_REMOVE, h as HWND);
    }
}

/// One AppBar message that needs only the window (new, remove, activate, moved).
fn appbar(msg: u32, h: HWND) -> usize {
    let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: h, uCallbackMessage: WM_BAR_CALLBACK, ..Default::default() };
    unsafe { SHAppBarMessage(msg, &mut abd) }
}

fn live(h: HWND, on: bool) {
    if let Ok(mut l) = LIVE.lock() {
        l.retain(|x| *x != h as isize);
        if on {
            l.push(h as isize);
        }
    }
}

// ---- the thread's state ------------------------------------------------------------------

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

/// Runs `f` on the thread's state, or does nothing when it is borrowed already (a message sent back into the window
/// procedure by a call made under it).
fn with_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    UI.with(|u| u.try_borrow_mut().ok().and_then(|mut g| g.as_mut().map(f)))
}

struct Bar {
    hwnd: HWND,
    monitor: String,
    hmon: HMONITOR,
    /// Where the shell let the bar sit, in screen pixels.
    rect: RECT,
    dpi: u32,
    /// Hidden while a full-screen app is up on its display.
    hidden: bool,
    /// The workspace numbers as last drawn: (n, x, width), x from the bar's left.
    cells: Vec<(u8, i32, i32)>,
}

/// The look in force and what it came from.
struct Look {
    colors: Colors,
    /// `built-in` or `polycarp theme <name>`.
    source: String,
    font: String,
    dark: bool,
    twenty_four: bool,
    accent: Option<Rgb>,
    /// The theme file's size and time when last read, and the mode it was read in.
    stamp: Option<(u64, Option<SystemTime>, bool)>,
    /// Why the theme file was last ignored, logged once until it changes.
    ignored: Option<String>,
}

struct Ui {
    tx: Sender<Msg>,
    on: bool,
    bars: Vec<Bar>,
    state: ShellState,
    line: String,
    look: Look,
    clock: String,
    timer: usize,
}

impl Ui {
    fn new(tx: Sender<Msg>) -> Self {
        Ui {
            tx,
            on: false,
            bars: vec![],
            state: ShellState::default(),
            line: String::new(),
            look: Look { colors: Colors::builtin(None), source: "built-in".into(), font: FONTS[1].into(), dark: true, twenty_four: true, accent: None, stamp: None, ignored: None },
            clock: String::new(),
            timer: 0,
        }
    }

    fn off_status() -> Value {
        json!({ "enabled": false, "bars": [] })
    }

    fn report(&self) {
        if !self.on {
            write_status(&Ui::off_status());
            return;
        }
        let bars: Vec<Value> = self
            .bars
            .iter()
            .map(|b| {
                json!({
                    "hwnd": b.hwnd as isize as i64,
                    "monitor": b.monitor,
                    "rect": [b.rect.left, b.rect.top, b.rect.right, b.rect.bottom],
                    "dpi": b.dpi,
                    "height": b.rect.bottom - b.rect.top,
                    "hidden": b.hidden,
                    "cells": b.cells.iter().map(|(n, x, w)| json!({ "n": n, "x": x, "w": w })).collect::<Vec<_>>(),
                })
            })
            .collect();
        write_status(&json!({ "enabled": true, "font": self.look.font, "theme": self.look.source, "clock": self.clock, "bars": bars }));
    }

    fn enable(&mut self) {
        if self.on {
            return;
        }
        self.on = true;
        self.look.font = installed_font();
        self.read_state();
        self.refresh_look();
        self.clock = clock_now(self.look.twenty_four);
        self.timer = unsafe { SetTimer(std::ptr::null_mut(), 0, 1000, None) };
        self.rebuild(false);
        say(&format!("baneyspaces daemon: bar: on, {} display(s), {} in {}", self.bars.len(), self.look.font, self.look.source));
    }

    fn disable(&mut self) {
        if !self.on {
            return;
        }
        self.on = false;
        if self.timer != 0 {
            unsafe { KillTimer(std::ptr::null_mut(), self.timer) };
            self.timer = 0;
        }
        for b in self.bars.drain(..) {
            remove(&b);
        }
        self.report();
        say("baneyspaces daemon: bar: off, the work area is given back");
    }

    /// The displays as they are now: a bar for each new one, gone with each that went, and every other one docked
    /// again (its size or scale may have changed). `renew`: explorer.exe restarted and knows no bar, so each is
    /// registered again.
    fn rebuild(&mut self, renew: bool) {
        if !self.on {
            return;
        }
        let now = displays();
        let mut kept = vec![];
        for b in self.bars.drain(..) {
            match now.iter().find(|d| d.1 == b.monitor) {
                Some(d) => kept.push(Bar { hmon: d.0, ..b }),
                None => remove(&b),
            }
        }
        self.bars = kept;
        for (hmon, name) in now {
            if !self.bars.iter().any(|b| b.monitor == name) {
                if let Some(b) = create(hmon, &name) {
                    self.bars.push(b);
                }
            } else if renew {
                if let Some(b) = self.bars.iter().find(|b| b.monitor == name) {
                    appbar(ABM_REMOVE, b.hwnd);
                    appbar(ABM_NEW, b.hwnd);
                }
            }
        }
        for b in &mut self.bars {
            dock(b, true);
            unsafe { InvalidateRect(b.hwnd, std::ptr::null(), 0) };
        }
        self.report();
    }

    fn redock(&mut self, h: HWND) {
        if let Some(b) = self.bars.iter_mut().find(|b| b.hwnd == h) {
            dock(b, false);
        }
        self.report();
    }

    /// A full-screen app opened or went (`ABN_FULLSCREENAPP`, sent to bar `h`). Whether the shell tells only the bar on
    /// that display or every bar is not known, so the notice only says when to look: every bar's display is decided
    /// again from the windows on it (`rule::full_screen_bars`), whichever bar was told and whatever it was told.
    fn fullscreen(&mut self, h: HWND, open: bool) {
        let bars: Vec<(rule::Rect, bool)> = self.bars.iter().map(|b| (display_rect(b.hmon), b.hidden)).collect();
        let change = rule::full_screen_bars(&bars, &front_windows());
        for &(i, hide) in &change {
            let b = &mut self.bars[i];
            b.hidden = hide;
            unsafe { ShowWindow(b.hwnd, if hide { SW_HIDE } else { SW_SHOWNOACTIVATE }) };
        }
        let told = self.bars.iter().find(|b| b.hwnd == h).map_or("no bar", |b| b.monitor.as_str());
        let hidden: Vec<&str> = self.bars.iter().filter(|b| b.hidden).map(|b| b.monitor.as_str()).collect();
        say(&format!("baneyspaces daemon: bar: full-screen app {} (told {told}); {} bar(s) changed, hidden on [{}]", if open { "opened" } else { "went" }, change.len(), hidden.join(", ")));
        self.report();
    }

    /// Reads the newest state line; true if it differs from the one drawn.
    fn read_state(&mut self) -> bool {
        let Some(line) = LATEST.lock().ok().and_then(|l| l.clone()) else { return false };
        if line == self.line {
            return false;
        }
        self.line = line;
        if let Some(s) = ShellState::parse_line(&self.line) {
            self.state = s;
        }
        true
    }

    /// The colors from the theme file, Windows' app mode and accent, and the clock's 12 or 24 hours. True if any changed.
    fn refresh_look(&mut self) -> bool {
        let dark = apps_dark();
        let twenty_four = twenty_four_hour();
        let accent = system_accent();
        let mut changed = dark != self.look.dark || twenty_four != self.look.twenty_four || accent != self.look.accent;
        self.look.dark = dark;
        self.look.twenty_four = twenty_four;
        self.look.accent = accent;
        let file = crate::paths::polycarp_theme_file();
        let meta = file.as_ref().and_then(|f| std::fs::symlink_metadata(f).ok());
        let stamp = meta.as_ref().map(|m| (m.len(), m.modified().ok(), dark));
        if stamp != self.look.stamp || changed {
            self.look.stamp = stamp;
            let read = match (&file, &meta) {
                (_, None) => Err(None),
                (Some(f), Some(m)) if m.is_file() && m.len() <= rule::THEME_MAX_BYTES => std::fs::read_to_string(f).map_err(|e| Some(format!("cannot read it: {e}"))).and_then(|t| rule::theme_colors(&t, dark).map_err(Some)),
                (_, Some(m)) if !m.is_file() => Err(Some("not a regular file".into())),
                _ => Err(Some(format!("larger than {} KB", rule::THEME_MAX_BYTES / 1024))),
            };
            let (colors, source) = match read {
                Ok((c, name)) => {
                    self.look.ignored = None;
                    (c, format!("polycarp theme {name}"))
                }
                Err(why) => {
                    if why.is_some() && why != self.look.ignored {
                        say(&format!("baneyspaces daemon: bar: polycarp theme: ignored {}: {}; drawing the built-in look", file.as_ref().map(|f| f.display().to_string()).unwrap_or_default(), why.as_deref().unwrap_or("")));
                    }
                    self.look.ignored = why;
                    (Colors::builtin(accent), "built-in".to_string())
                }
            };
            changed |= colors != self.look.colors || source != self.look.source;
            self.look.colors = colors;
            self.look.source = source;
        }
        changed
    }

    fn tick(&mut self) {
        let mut changed = self.refresh_look();
        let clock = clock_now(self.look.twenty_four);
        if clock != self.clock {
            self.clock = clock;
            changed = true;
        }
        if changed {
            self.repaint();
        }
    }

    fn repaint(&self) {
        for b in &self.bars {
            unsafe { InvalidateRect(b.hwnd, std::ptr::null(), 0) };
        }
    }

    /// A press on a bar: the number under it, sent to the worker the way Win+n is, asked from the bar's display.
    fn click(&self, h: HWND, x: i32) {
        let Some(b) = self.bars.iter().find(|b| b.hwnd == h) else { return };
        if let Some(n) = rule::hit(&b.cells, x) {
            let _ = self.tx.send(Msg::Chord { args: click_args(n, &b.monitor), at: crate::winapi::tick_ms() });
        }
    }

    fn paint(&mut self, h: HWND) {
        let Some(i) = self.bars.iter().position(|b| b.hwnd == h) else { return };
        let current = self.state.current_on(&self.bars[i].monitor).unwrap_or(0);
        let numbers = rule::workspaces(&self.state.occupied, current);
        let cells = unsafe { draw(&self.bars[i], &self.look, &self.clock, &numbers, current) };
        if cells != self.bars[i].cells {
            self.bars[i].cells = cells;
            self.report();
        }
    }
}

/// The chord a press on number `n` of the bar on display `monitor` sends. The bar never takes the front, so the display
/// you were on may be another one: the switch names this one, and `n` comes here or you go to the display that shows
/// it (`spec/bar.md`, R-S7).
fn click_args(n: u8, monitor: &str) -> Vec<String> {
    vec!["switch".into(), n.to_string(), "--monitor".into(), monitor.into()]
}

fn on_thread_message(msg: u32, wp: WPARAM, lp: LPARAM) {
    match msg {
        WM_BAR_ENABLE => {
            with_ui(|ui| if wp != 0 { ui.enable() } else { ui.disable() });
        }
        WM_BAR_STATE => {
            with_ui(|ui| {
                if ui.on && ui.read_state() {
                    ui.repaint();
                }
            });
        }
        WM_BAR_REDOCK => {
            with_ui(|ui| ui.redock(wp as HWND));
        }
        WM_BAR_REBUILD => {
            REBUILD_POSTED.store(false, Ordering::SeqCst);
            with_ui(|ui| ui.rebuild(wp != 0));
        }
        WM_BAR_FULLSCREEN => {
            with_ui(|ui| ui.fullscreen(wp as HWND, lp != 0));
        }
        WM_BAR_REPAINT => {
            with_ui(|ui| ui.repaint());
        }
        WM_TIMER => {
            with_ui(|ui| ui.tick());
        }
        _ => {}
    }
}

fn rebuild_soon(renew: bool) {
    if renew || !REBUILD_POSTED.swap(true, Ordering::SeqCst) {
        post(WM_BAR_REBUILD, renew as usize, 0);
    }
}

unsafe extern "system" fn bar_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_BAR_CALLBACK => {
            match wp as u32 {
                ABN_POSCHANGED => post(WM_BAR_REDOCK, hwnd as usize, 0),
                ABN_FULLSCREENAPP => post(WM_BAR_FULLSCREEN, hwnd as usize, lp),
                _ => {}
            }
            0
        }
        // The shell asks an AppBar to pass these on.
        WM_ACTIVATE => {
            appbar(ABM_ACTIVATE, hwnd);
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_WINDOWPOSCHANGED => {
            appbar(ABM_WINDOWPOSCHANGED, hwnd);
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        // A click never takes the front from your window.
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            if with_ui(|ui| ui.paint(hwnd)).is_none() {
                post(WM_BAR_REPAINT, 0, 0);
                return DefWindowProcW(hwnd, msg, wp, lp);
            }
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            BeginPaint(hwnd, &mut ps);
            EndPaint(hwnd, &ps);
            0
        }
        WM_LBUTTONDOWN => {
            let x = (lp & 0xffff) as u16 as i16 as i32;
            with_ui(|ui| ui.click(hwnd, x));
            0
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            rebuild_soon(false);
            0
        }
        // Only the daemon takes a bar down.
        WM_CLOSE => 0,
        m if m != 0 && m == TASKBAR_CREATED.load(Ordering::Relaxed) => {
            rebuild_soon(true);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

// ---- Win32 --------------------------------------------------------------------------------

/// Every display, as (handle, device name), in physical pixels (the thread is per-monitor aware).
fn displays() -> Vec<(HMONITOR, String)> {
    unsafe extern "system" fn each(m: HMONITOR, _dc: HDC, _r: *mut RECT, lp: LPARAM) -> windows_sys::core::BOOL {
        if let Some(name) = monitor_name(m) {
            (*(lp as *mut Vec<(HMONITOR, String)>)).push((m, name));
        }
        1
    }
    let mut v: Vec<(HMONITOR, String)> = vec![];
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), &mut v as *mut _ as LPARAM) };
    v
}

fn monitor_info(m: HMONITOR) -> Option<MONITORINFOEXW> {
    unsafe {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        (GetMonitorInfoW(m, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) != 0).then_some(info)
    }
}

fn monitor_name(m: HMONITOR) -> Option<String> {
    monitor_info(m).map(|i| crate::winapi::wide_to_string(&i.szDevice))
}

/// The display's whole rect (`rcMonitor`), or an empty one when it is gone, which no window covers.
fn display_rect(m: HMONITOR) -> rule::Rect {
    monitor_info(m).map_or([0; 4], |i| {
        let r = i.monitorInfo.rcMonitor;
        [r.left, r.top, r.right, r.bottom]
    })
}

/// The visible frames of the top-level windows that could be a full-screen app, front to back (`EnumWindows` order):
/// shown, not minimized or cloaked, not click-through or a tool window, and none of the daemon's own (the bars) or the
/// shell's (the desktop, the taskbars). A frame leaves out the invisible resize border, so a window on the next display
/// never reaches onto this one.
fn front_windows() -> Vec<rule::Rect> {
    use crate::winapi as w;
    let me = std::process::id();
    w::list_top_level()
        .into_iter()
        .filter(|&h| {
            let ex = w::ex_style(h);
            let tool = ex & WS_EX_TOOLWINDOW as i64 != 0 && ex & WS_EX_APPWINDOW as i64 == 0;
            w::is_visible(h) && !w::is_iconic(h) && w::cloaked(h) == 0 && !tool && ex & WS_EX_TRANSPARENT as i64 == 0 && w::pid_of(h) != me && !w::SHELL_CLASSES.contains(&w::class(h).as_str())
        })
        .filter_map(w::visible_frame)
        .collect()
}

fn monitor_dpi(m: HMONITOR) -> u32 {
    let (mut x, mut y) = (0u32, 0u32);
    let hr = unsafe { GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut x, &mut y) };
    if hr == 0 && x != 0 {
        x
    } else {
        96
    }
}

fn create(hmon: HMONITOR, name: &str) -> Option<Bar> {
    unsafe {
        let class = wide(CLASS);
        let title = wide("Polycarp bar");
        let ex = WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
        let h = CreateWindowExW(ex, class.as_ptr(), title.as_ptr(), WS_POPUP, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null());
        if h.is_null() {
            say(&format!("baneyspaces daemon: bar: no window for {name} (error {})", windows_sys::Win32::Foundation::GetLastError()));
            return None;
        }
        appbar(ABM_NEW, h);
        live(h, true);
        let mut b = Bar { hwnd: h, monitor: name.to_string(), hmon, rect: RECT { left: 0, top: 0, right: 0, bottom: 0 }, dpi: 96, hidden: false, cells: vec![] };
        dock(&mut b, true);
        ShowWindow(h, SW_SHOWNOACTIVATE);
        Some(b)
    }
}

fn remove(b: &Bar) {
    appbar(ABM_REMOVE, b.hwnd);
    live(b.hwnd, false);
    unsafe { DestroyWindow(b.hwnd) };
}

/// Asks the shell where the bar may sit at the top of its display, then takes that place. With `force` off, a place
/// the bar already has is not set again: setting it tells every other AppBar, whose answer would tell this one.
fn dock(b: &mut Bar, force: bool) {
    let Some(info) = monitor_info(b.hmon) else { return };
    let m = info.monitorInfo.rcMonitor;
    b.dpi = monitor_dpi(b.hmon);
    let height = rule::height_px(b.dpi);
    let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: b.hwnd, uCallbackMessage: WM_BAR_CALLBACK, uEdge: ABE_TOP, rc: RECT { left: m.left, top: m.top, right: m.right, bottom: m.top + height }, lParam: 0 };
    unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut abd) };
    abd.rc.bottom = abd.rc.top + height;
    let same = |a: &RECT, c: &RECT| a.left == c.left && a.top == c.top && a.right == c.right && a.bottom == c.bottom;
    if !force && same(&abd.rc, &b.rect) {
        return;
    }
    unsafe { SHAppBarMessage(ABM_SETPOS, &mut abd) };
    let r = abd.rc;
    b.rect = r;
    unsafe { SetWindowPos(b.hwnd, HWND_TOPMOST, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOACTIVATE) };
}

fn rgb(c: Rgb) -> COLORREF {
    c[0] as u32 | (c[1] as u32) << 8 | (c[2] as u32) << 16
}

fn text_size(dc: HDC, s: &[u16]) -> SIZE {
    let mut sz = SIZE { cx: 0, cy: 0 };
    unsafe { GetTextExtentPoint32W(dc, s.as_ptr(), s.len() as i32, &mut sz) };
    sz
}

/// Draws one bar into a memory bitmap and copies it on screen; returns the number cells it drew.
unsafe fn draw(b: &Bar, look: &Look, clock: &str, numbers: &[u8], current: u8) -> Vec<(u8, i32, i32)> {
    let s = |px: i32| rule::scale(px, b.dpi);
    let (w, h) = (b.rect.right - b.rect.left, b.rect.bottom - b.rect.top);
    if w <= 0 || h <= 0 {
        return vec![];
    }
    let screen = GetDC(b.hwnd);
    let dc = CreateCompatibleDC(screen);
    let bmp = CreateCompatibleBitmap(screen, w, h);
    let old_bmp = SelectObject(dc, bmp as HGDIOBJ);
    let c = look.colors;
    let bg = CreateSolidBrush(rgb(c.background));
    FillRect(dc, &RECT { left: 0, top: 0, right: w, bottom: h }, bg);
    DeleteObject(bg as HGDIOBJ);
    let mut lf: LOGFONTW = std::mem::zeroed();
    lf.lfHeight = -s(TEXT_PX);
    lf.lfWeight = 400;
    lf.lfCharSet = DEFAULT_CHARSET;
    lf.lfQuality = CLEARTYPE_QUALITY;
    for (i, u) in look.font.encode_utf16().take(31).enumerate() {
        lf.lfFaceName[i] = u;
    }
    let font = CreateFontIndirectW(&lf);
    let old_font = SelectObject(dc, font as HGDIOBJ);
    SetBkMode(dc, TRANSPARENT as _);
    let labels: Vec<Vec<u16>> = numbers.iter().map(|n| n.to_string().encode_utf16().collect()).collect();
    let widths: Vec<i32> = labels.iter().map(|l| text_size(dc, l).cx).collect();
    let cells = rule::cells(numbers, &widths, s(PAD_PX), s(PAD_PX));
    let accent = CreateSolidBrush(rgb(c.accent));
    for ((n, x, cw), label) in cells.iter().zip(&labels) {
        let sz = text_size(dc, label);
        SetTextColor(dc, rgb(if *n == current { c.foreground } else { c.muted }));
        TextOutW(dc, x + (cw - sz.cx) / 2, (h - sz.cy) / 2, label.as_ptr(), label.len() as i32);
        if *n == current {
            FillRect(dc, &RECT { left: *x, top: h - s(UNDERLINE_PX), right: x + cw, bottom: h }, accent);
        }
    }
    let words: Vec<u16> = clock.encode_utf16().collect();
    let sz = text_size(dc, &words);
    SetTextColor(dc, rgb(c.foreground));
    TextOutW(dc, (w - sz.cx) / 2, (h - sz.cy) / 2, words.as_ptr(), words.len() as i32);
    // The mark: a small accent diamond at the right end. It opens nothing yet.
    let (r, cx, cy) = (s(MARK_PX) / 2, w - s(PAD_PX) - s(MARK_PX) / 2, h / 2);
    let pen = CreatePen(PS_SOLID, 1, rgb(c.accent));
    let old_pen = SelectObject(dc, pen as HGDIOBJ);
    let old_brush = SelectObject(dc, accent as HGDIOBJ);
    let pts = [POINT { x: cx, y: cy - r }, POINT { x: cx + r, y: cy }, POINT { x: cx, y: cy + r }, POINT { x: cx - r, y: cy }];
    Polygon(dc, pts.as_ptr(), pts.len() as i32);
    BitBlt(screen, 0, 0, w, h, dc, 0, 0, SRCCOPY);
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_font);
    SelectObject(dc, old_bmp);
    DeleteObject(pen as HGDIOBJ);
    DeleteObject(accent as HGDIOBJ);
    DeleteObject(font as HGDIOBJ);
    DeleteObject(bmp as HGDIOBJ);
    DeleteDC(dc);
    ReleaseDC(b.hwnd, screen);
    cells
}

/// The first family in `FONTS` that is installed, else the last (GDI then picks the nearest).
fn installed_font() -> String {
    unsafe extern "system" fn found(_lf: *const LOGFONTW, _tm: *const TEXTMETRICW, _kind: u32, lp: LPARAM) -> i32 {
        *(lp as *mut bool) = true;
        0
    }
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        let pick = FONTS.iter().find(|name| {
            let mut lf: LOGFONTW = std::mem::zeroed();
            lf.lfCharSet = DEFAULT_CHARSET;
            for (i, u) in name.encode_utf16().take(31).enumerate() {
                lf.lfFaceName[i] = u;
            }
            let mut hit = false;
            EnumFontFamiliesExW(dc, &lf, Some(found), &mut hit as *mut bool as LPARAM, 0);
            hit
        });
        ReleaseDC(std::ptr::null_mut(), dc);
        pick.unwrap_or(&FONTS[FONTS.len() - 1]).to_string()
    }
}

/// Windows' app mode is dark (Settings > Personalization > Colors). Unreadable: light, Windows' own default.
fn apps_dark() -> bool {
    let key = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let name = wide("AppsUseLightTheme");
    let (mut v, mut n) = (1u32, 4u32);
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut v as *mut u32 as *mut _, &mut n) };
    r == 0 && v == 0
}

/// Windows' own clock is 24-hour (the user's time format, Settings > Time & language).
fn twenty_four_hour() -> bool {
    let mut buf = [0u16; 80];
    let n = unsafe { windows_sys::Win32::Globalization::GetLocaleInfoEx(std::ptr::null(), windows_sys::Win32::Globalization::LOCALE_STIMEFORMAT, buf.as_mut_ptr(), buf.len() as i32) };
    rule::clock_is_24h(&crate::winapi::wide_to_string(&buf[..n.max(0) as usize]))
}

/// The system's accent color, when DWM gives one.
fn system_accent() -> Option<Rgb> {
    let (mut argb, mut opaque) = (0u32, 0);
    (unsafe { DwmGetColorizationColor(&mut argb, &mut opaque) } == 0).then_some([(argb >> 16) as u8, (argb >> 8) as u8, argb as u8])
}

fn clock_now(twenty_four: bool) -> String {
    let mut t: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut t) };
    rule::clock(t.wDayOfWeek as u8, t.wHour as u8, t.wMinute as u8, twenty_four)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_switches_on_its_own_display() {
        let args = click_args(3, r"\\.\DISPLAY2");
        assert_eq!(args, ["switch", "3", "--monitor", r"\\.\DISPLAY2"]);
        // The worker runs a chord as a command line: this one must parse to a switch that names the display.
        let req = crate::request(args).unwrap();
        assert_eq!(req, json!({ "op": "switch", "args": { "n": "3", "monitor": r"\\.\DISPLAY2" } }));
    }
}
