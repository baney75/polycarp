//! The launcher's window (`spec/shell.md`, The launcher): a panel that opens on its key over the display you are
//! working on, takes the keyboard while it is up and hides again on Esc, a pick or a click elsewhere. What it shows
//! and what each key does is `shell::launcher`; this file only places, paints and acts. A child of `win`, so it
//! draws with the bar's device and palette.

use super::super::bar::{Align, Face, Rect};
use super::super::launcher::{self as model, Action, App, Command, Key, Launcher, Outcome};
use super::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_WIN, VK_BACK, VK_CONTROL,
    VK_DOWN, VK_ESCAPE, VK_RETURN, VK_SPACE, VK_UP,
};

pub const CLASS: &str = "PolycarpLauncher";
const HOTKEY: i32 = 1;
/// The Start menu is read again when the launcher opens, at most this often.
const RESCAN: Duration = Duration::from_secs(60);

/// Start-menu apps from the scan thread, until the window takes them.
static APPS: Mutex<Option<Vec<App>>> = Mutex::new(None);

pub struct Panel {
    pub hwnd: HWND,
    model: Launcher,
    apps: Vec<App>,
    /// The apps or the feed changed since the names were prepared.
    dirty: bool,
    scanned: Option<Instant>,
    surface: Option<(gfx::Surface, i32, i32, u32)>,
    fonts: Option<(gfx::Fonts, String, f32, u32)>,
    shown: bool,
    /// When the key being handled arrived, for R-L13's key->paint.
    pressed: Option<Instant>,
    /// The first half of a character outside the Basic Multilingual Plane.
    high: Option<u16>,
}

impl Panel {
    pub fn new(hwnd: HWND) -> Panel {
        Panel {
            hwnd,
            model: Launcher::default(),
            apps: vec![],
            dirty: true,
            // `run` reads the Start menu as the shell starts.
            scanned: Some(Instant::now()),
            surface: None,
            fonts: None,
            shown: false,
            pressed: None,
            high: None,
        }
    }
}

/// Creates the hidden panel window. Its class is registered with the shell's others.
pub fn create(inst: HINSTANCE) -> HWND {
    let class = wide(CLASS);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOREDIRECTIONBITMAP,
            class.as_ptr(),
            wide("Polycarp launcher").as_ptr(),
            WS_POPUP,
            0,
            0,
            1,
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            std::ptr::null(),
        )
    };
    if !hwnd.is_null() {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };
        let round = DWMWCP_ROUND;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &round as *const _ as *const c_void,
                4,
            )
        };
    }
    hwnd
}

/// Takes the launcher's key: Ctrl+Win+K, or Alt+Space when another program holds that. Logs which.
pub fn register_key(main: HWND) {
    let held = unsafe {
        if RegisterHotKey(
            main,
            HOTKEY,
            MOD_CONTROL | MOD_WIN | MOD_NOREPEAT,
            u32::from(b'K'),
        ) != 0
        {
            "Ctrl+Win+K"
        } else if RegisterHotKey(main, HOTKEY, MOD_ALT | MOD_NOREPEAT, u32::from(VK_SPACE)) != 0 {
            "Alt+Space"
        } else {
            "none (both keys are taken; `baneyspaces shell launcher` still opens it)"
        }
    };
    log(&format!("launcher key {held}"));
}

/// Reads the Start menu's apps (the Apps folder, which lists desktop and Store apps alike) on a thread of its own.
pub fn scan() {
    std::thread::Builder::new()
        .name("shell-apps".into())
        .spawn(|| {
            let t0 = Instant::now();
            let apps = unsafe { read_apps() };
            match apps {
                Ok(apps) => {
                    log(&format!(
                        "launcher apps {} in {:.0} ms",
                        apps.len(),
                        t0.elapsed().as_secs_f64() * 1000.0
                    ));
                    if let Ok(mut a) = APPS.lock() {
                        *a = Some(apps);
                    }
                    post(WM_APPS, 0);
                }
                Err(e) => log(&format!("error: launcher apps: {e}")),
            }
        })
        .ok();
}

unsafe fn read_apps() -> windows::core::Result<Vec<App>> {
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::*;
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
    let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
    let text = |item: &IShellItem, kind: SIGDN| -> Option<String> {
        let p = item.GetDisplayName(kind).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s.filter(|s| !s.is_empty())
    };
    let mut apps = vec![];
    loop {
        let mut one = [None];
        if items.Next(&mut one, None).is_err() {
            break;
        }
        let Some(item) = one[0].take() else { break };
        if let (Some(name), Some(target)) = (
            text(&item, SIGDN_NORMALDISPLAY),
            text(&item, SIGDN_PARENTRELATIVEPARSING),
        ) {
            apps.push(App { name, target });
        }
    }
    Ok(apps)
}

/// The apps scan finished.
pub fn took_apps(s: &mut Shell) {
    if let Some(apps) = APPS.lock().ok().and_then(|mut a| a.take()) {
        s.panel.apps = apps;
        s.panel.dirty = true;
        if s.panel.shown {
            prepare(s);
            paint(s);
        }
    }
}

/// The feed changed what is open or where.
pub fn state_changed(s: &mut Shell) {
    s.panel.dirty = true;
    if s.panel.shown {
        prepare(s);
        paint(s);
    }
}

/// Every name is prepared again when what it finds changed, never per key (R-L12).
fn prepare(s: &mut Shell) {
    if s.panel.dirty {
        s.panel.model.set_sources(&s.panel.apps, &s.state);
        s.panel.dirty = false;
    }
}

pub fn toggle(s: &mut Shell, by: &str) {
    if s.panel.shown {
        hide(s, by);
    } else {
        show(s, by);
    }
}

pub fn show(s: &mut Shell, by: &str) {
    if s.panel.shown {
        unsafe { SetForegroundWindow(s.panel.hwnd) };
        return;
    }
    let t0 = Instant::now();
    prepare(s);
    s.panel.model.reset();
    let (x, y, w, h, dpi) = place(s);
    let drawn = paint(s);
    s.panel.shown = true;
    let front = unsafe {
        ShowWindow(s.panel.hwnd, SW_SHOW);
        crate::winapi::set_foreground(s.panel.hwnd)
    };
    log(&format!(
        "launcher shown by {by} at {x},{y} {w}x{h} px, dpi {dpi}, first frame {} results={}, {}",
        if drawn {
            format!("{:.1} ms", t0.elapsed().as_secs_f64() * 1000.0)
        } else {
            "not drawn".into()
        },
        s.panel.model.rows.len(),
        if front { "in front" } else { "not in front (Windows kept the front elsewhere)" }
    ));
    if s.panel.scanned.is_none_or(|t| t.elapsed() > RESCAN) {
        s.panel.scanned = Some(Instant::now());
        scan();
    }
}

/// Draws every printable ASCII character in both faces once, into the hidden panel, as the shell starts: the first
/// keystroke after an open then finds its glyphs ready instead of rasterizing them.
pub fn warm(s: &mut Shell) {
    let t0 = Instant::now();
    place(s);
    if !fonts_ready(s) {
        return;
    }
    let all: Vec<char> = (0x20u8..0x7f).map(char::from).collect();
    let mut ops = vec![];
    for (f, face) in [Face::Ui, Face::UiStrong].into_iter().enumerate() {
        for (i, chunk) in all.chunks(24).enumerate() {
            let r = Rect { x: 8.0, y: 8.0 + (f * 5 + i) as f32 * 30.0, w: model::WIDTH - 16.0, h: 30.0 };
            ops.push(Op::Text { r, text: chunk.iter().collect(), face, ink: Ink::Foreground, align: Align::Start });
        }
    }
    let p = s.palette().clone();
    if let (Some((surf, ..)), Some((fonts, ..))) = (s.panel.surface.as_ref(), s.panel.fonts.as_ref()) {
        if unsafe { surf.draw(fonts, color(p.surface), &draws(&p, &ops)) }.is_ok() {
            log(&format!("launcher warmed in {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0));
        }
    }
}

/// Sizes and places the hidden panel for the display you are working on and makes its surface. Returns where.
fn place(s: &mut Shell) -> (i32, i32, i32, i32, u32) {
    // Over the display you are working on: the one with the window in front, else the pointer's.
    let (work, dpi) = unsafe {
        let fg = GetForegroundWindow();
        let m = if fg.is_null() {
            let mut pt = POINT { x: 0, y: 0 };
            GetCursorPos(&mut pt);
            MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY)
        } else {
            MonitorFromWindow(fg, MONITOR_DEFAULTTOPRIMARY)
        };
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(m, &mut info);
        let (mut x, mut y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut x, &mut y);
        (info.rcWork, x.max(96))
    };
    let scale = dpi as f32 / 96.0;
    let w = (model::WIDTH * scale).round() as i32;
    let h = (model::height(&s.theme) * scale).round() as i32;
    let (ww, wh) = (work.right - work.left, work.bottom - work.top);
    let (x, y) = (work.left + (ww - w) / 2, work.top + wh / 5);
    unsafe { SetWindowPos(s.panel.hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE) };
    if !matches!(&s.panel.surface, Some((_, sw, sh, sd)) if (*sw, *sh, *sd) == (w, h, dpi)) {
        s.panel.surface = None;
        match unsafe { s.dev.surface(s.panel.hwnd, w as u32, h as u32, dpi as f32) } {
            Ok(surf) => s.panel.surface = Some((surf, w, h, dpi)),
            Err(e) => log(&format!("error: launcher surface: {e}")),
        }
    }
    (x, y, w, h, dpi)
}

pub fn hide(s: &mut Shell, why: &str) {
    if !s.panel.shown {
        return;
    }
    s.panel.shown = false;
    unsafe { ShowWindow(s.panel.hwnd, SW_HIDE) };
    log(&format!("launcher hidden: {why}"));
}

/// The panel's fonts for the theme, made when the theme's family, size or weight changed.
fn fonts_ready(s: &mut Shell) -> bool {
    let family = unsafe { s.dev.family(&s.theme.font_ui) };
    let size = (s.theme.size * 0.875).round().max(11.0);
    if !matches!(&s.panel.fonts, Some((_, f, z, w)) if *f == family && *z == size && *w == s.theme.weight)
    {
        s.panel.fonts = match unsafe { s.dev.fonts(&family, size, s.theme.weight) } {
            Ok(f) => Some((f, family, size, s.theme.weight)),
            Err(e) => {
                log(&format!("error: launcher fonts: {e}"));
                None
            }
        };
    }
    s.panel.fonts.is_some()
}

fn paint(s: &mut Shell) -> bool {
    if !fonts_ready(s) {
        return false;
    }
    let lay = model::layout(&s.panel.model, &s.theme);
    let p = s.palette().clone();
    let (Some((surf, ..)), Some((fonts, ..))) = (s.panel.surface.as_ref(), s.panel.fonts.as_ref())
    else {
        return false;
    };
    match unsafe { surf.draw(fonts, color(p.surface), &draws(&p, &lay.ops)) } {
        Ok(()) => true,
        Err(e) => {
            log(&format!("error: drawing the launcher: {e}"));
            false
        }
    }
}

fn key(s: &mut Shell, k: Key) {
    let pressed = s.panel.pressed.take().unwrap_or_else(Instant::now);
    let start = Instant::now();
    let outcome = s.panel.model.key(k);
    let ranked = Instant::now();
    match outcome {
        Outcome::Same => {}
        Outcome::Redraw => {
            if paint(s) {
                let ms = |a: Instant, b: Instant| b.duration_since(a).as_secs_f64() * 1000.0;
                let end = Instant::now();
                // R-L13: the time and the count, never what was typed.
                log(&format!("launcher key->paint={:.1} results={}", ms(pressed, end), s.panel.model.rows.len()));
                // Where a slow key's time went: Windows handing over its character, ranking, or drawing.
                if ms(pressed, end) > 8.0 {
                    log(&format!(
                        "launcher slow key: {:.1} ms to the character, {:.1} ms ranking, {:.1} ms drawing",
                        ms(pressed, start),
                        ms(start, ranked),
                        ms(ranked, end)
                    ));
                }
            }
        }
        Outcome::Close => hide(s, "Esc"),
        Outcome::Run(a) => {
            hide(s, "picked");
            run(s, a);
        }
    }
}

/// Carries out a pick. The panel was in front, so it may hand the front on: to the app it starts, to the daemon
/// for a switch, or to the window picked.
fn run(s: &mut Shell, a: Action) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
    unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    let paths = s.paths.clone();
    let call = move |req: serde_json::Value| {
        let r = crate::ipc::call(&paths, &req);
        if !r.ok {
            log(&format!(
                "launcher: {} refused: {:?}",
                req["op"],
                r.error.map(|e| e.message)
            ));
        }
        r.ok
    };
    match a {
        Action::Launch(target) => {
            log("launcher run: app");
            std::thread::spawn(move || unsafe {
                use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
                CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
                let file = wide(&format!(r"shell:AppsFolder\{target}"));
                let r = ShellExecuteW(
                    std::ptr::null_mut(),
                    wide("open").as_ptr(),
                    file.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                );
                if r as isize <= 32 {
                    log(&format!(
                        "error: launcher could not start the app (ShellExecute {})",
                        r as isize
                    ));
                }
            });
        }
        Action::Window { id, workspace } => {
            log(&format!("launcher run: window on workspace {workspace}"));
            let hwnd = id
                .strip_prefix("w-")
                .and_then(|n| n.parse::<isize>().ok())
                .unwrap_or(0);
            std::thread::spawn(move || {
                if call(serde_json::json!({ "op": "switch", "args": { "n": workspace } }))
                    && hwnd != 0
                {
                    crate::winapi::set_foreground(hwnd as HWND);
                }
            });
        }
        Action::Switch(n) => {
            log(&format!("launcher run: workspace {n}"));
            std::thread::spawn(move || {
                call(serde_json::json!({ "op": "switch", "args": { "n": n } }));
            });
        }
        Action::Command(Command::AgentWorkspace) => {
            log("launcher run: agent workspace");
            std::thread::spawn(move || {
                call(serde_json::json!({ "op": "agent_toggle" }));
            });
        }
        Action::Command(Command::QuitBar) => {
            log("launcher run: quit");
            post(WM_CLOSE, 0);
        }
    }
}

pub unsafe extern "system" fn panel_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_KEYDOWN => {
            let ctrl = GetKeyState(i32::from(VK_CONTROL)) < 0;
            let k = match wp as u16 {
                VK_BACK if ctrl => Some(Key::Clear),
                VK_BACK => Some(Key::Back),
                VK_UP => Some(Key::Up),
                VK_DOWN => Some(Key::Down),
                VK_RETURN => Some(Key::Enter),
                VK_ESCAPE => Some(Key::Esc),
                _ => None,
            };
            let at = Instant::now();
            with_shell(|s| match k {
                Some(k) => {
                    s.panel.pressed = Some(at);
                    key(s, k)
                }
                // Its character comes as WM_CHAR next; time it from here.
                None => s.panel.pressed = Some(at),
            });
            0
        }
        WM_CHAR => {
            let unit = wp as u16;
            with_shell(|s| {
                let c = match (s.panel.high.take(), unit) {
                    (_, 0xD800..=0xDBFF) => {
                        s.panel.high = Some(unit);
                        return;
                    }
                    (Some(h), 0xDC00..=0xDFFF) => {
                        char::decode_utf16([h, unit]).next().and_then(Result::ok)
                    }
                    (_, u) => char::from_u32(u32::from(u)),
                };
                // Backspace, Enter and Esc came as keys already.
                if let Some(c) = c.filter(|c| !c.is_control()) {
                    key(s, Key::Char(c));
                }
            });
            0
        }
        WM_ACTIVATE => {
            if (wp & 0xffff) as u32 == WA_INACTIVE {
                with_shell(|s| hide(s, "clicked away"));
            }
            0
        }
        WM_LBUTTONUP => {
            let x = (lp & 0xffff) as u16 as i16 as f32;
            let y = ((lp >> 16) & 0xffff) as u16 as i16 as f32;
            with_shell(|s| {
                let scale = s
                    .panel
                    .surface
                    .as_ref()
                    .map_or(1.0, |(_, _, _, d)| *d as f32 / 96.0);
                let lay = model::layout(&s.panel.model, &s.theme);
                if let Some((_, i)) = lay
                    .hits
                    .iter()
                    .find(|(r, _)| r.contains(x / scale, y / scale))
                {
                    s.panel.model.selected = *i;
                    key(s, Key::Enter);
                }
            });
            0
        }
        WM_ERASEBKGND => 1,
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}
