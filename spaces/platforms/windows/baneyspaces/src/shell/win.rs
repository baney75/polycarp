//! The shell on Windows: one top bar per display, each an AppBar (`SHAppBarMessage`) so the work area, and with it
//! every maximized window, starts below it. Drawn with Direct2D and DirectWrite into a composition swap chain that
//! DirectComposition puts on screen (the stack measured in PR #427). Two threads feed the window thread: the daemon's
//! `subscribe` pipe (`spec/shell.md`) and a change watch on the theme folder. Nothing polls: idle is a blocked read,
//! a blocked wait and a clock timer once a minute.
//!
//! Windows itself goes through `windows-sys` like the rest of the daemon; only the COM graphics use the `windows`
//! crate.

use super::bar::{self, Ink, Op, Slide};
use super::theme::{self, Palette, Rgb, Theme};
use crate::paths::Paths;
use baneyspaces_core::shell::ShellState;
use std::cell::RefCell;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::*;
use windows_sys::Win32::UI::Shell::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const MAIN_CLASS: &str = "PolycarpShell";
const BAR_CLASS: &str = "PolycarpShellBar";

const WM_APPBAR: u32 = WM_APP + 1;
const WM_FEED: u32 = WM_APP + 2;
const WM_FEED_DOWN: u32 = WM_APP + 3;
const WM_THEME: u32 = WM_APP + 4;
const WM_REPLACE: u32 = WM_APP + 5;
/// The Start-menu scan finished.
const WM_APPS: u32 = WM_APP + 6;
/// `baneyspaces shell launcher`: open the launcher.
const WM_LAUNCHER: u32 = WM_APP + 7;

#[path = "win_launcher.rs"]
mod panel;

const T_CLOCK: usize = 1;
const T_ANIM: usize = 2;
const T_THEME: usize = 3;
const T_REBUILD: usize = 4;

/// The main window, for the feed and watch threads to post to.
static MAIN: AtomicIsize = AtomicIsize::new(0);
/// The newest state from the daemon; the feed thread fills it, the window thread takes it.
/// The newest state line from the daemon and when the feed thread read it.
static LATEST: Mutex<Option<(ShellState, Instant)>> = Mutex::new(None);
static LOG: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
static STARTED: OnceLock<Instant> = OnceLock::new();
static TASKBAR_CREATED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

thread_local! {
    static SHELL: RefCell<Option<Shell>> = const { RefCell::new(None) };
}

pub fn log(line: &str) {
    let ms = STARTED.get_or_init(Instant::now).elapsed().as_millis();
    let text = format!("{ms:>7} shell: {line}");
    eprintln!("{text}");
    if let Some(m) = LOG.get() {
        if let Ok(mut f) = m.lock() {
            if let Some(f) = f.as_mut() {
                let _ = writeln!(f, "{text}");
                let _ = f.flush();
            }
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn post(msg: u32, wp: usize) {
    let h = MAIN.load(Ordering::Relaxed);
    if h != 0 {
        unsafe { PostMessageW(h as HWND, msg, wp, 0) };
    }
}

// ---- the graphics -------------------------------------------------------------------------------------------

mod gfx {
    use super::super::bar::{Align, Face};
    use windows::core::{Interface, Result, HSTRING};
    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::Graphics::Direct2D::Common::*;
    use windows::Win32::Graphics::Direct2D::*;
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::DirectComposition::*;
    use windows::Win32::Graphics::DirectWrite::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;

    pub use windows::Win32::Graphics::Direct2D::Common::{D2D1_COLOR_F, D2D_RECT_F};

    /// One device for every bar.
    pub struct Device {
        _d3d: ID3D11Device,
        dxgi: IDXGIDevice,
        factory: IDXGIFactory2,
        d2d: ID2D1Device,
        dcomp: IDCompositionDevice,
        pub dw: IDWriteFactory,
    }

    /// A bar's drawing surface: an opaque swap chain the size of the bar in pixels, drawn in DIPs at its display's DPI.
    pub struct Surface {
        swap: IDXGISwapChain1,
        ctx: ID2D1DeviceContext,
        brush: ID2D1SolidColorBrush,
        _target: IDCompositionTarget,
        _visual: IDCompositionVisual,
    }

    pub struct Fonts {
        ui: IDWriteTextFormat,
        strong: IDWriteTextFormat,
    }

    impl Device {
        pub unsafe fn new() -> Result<Device> {
            let mut d3d: Option<ID3D11Device> = None;
            let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            let hw = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                flags,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                None,
            );
            if hw.is_err() {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    HMODULE::default(),
                    flags,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut d3d),
                    None,
                    None,
                )?;
            }
            let d3d = d3d.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let dxgi: IDXGIDevice = d3d.cast()?;
            let factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;
            let d2f: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let d2d = d2f.CreateDevice(&dxgi)?;
            let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
            let dw: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            Ok(Device { _d3d: d3d, dxgi, factory, d2d, dcomp, dw })
        }

        pub unsafe fn surface(&self, hwnd: *mut core::ffi::c_void, w: u32, h: u32, dpi: f32) -> Result<Surface> {
            let desc = DXGI_SWAP_CHAIN_DESC1 {
                Width: w.max(1),
                Height: h.max(1),
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                AlphaMode: DXGI_ALPHA_MODE_IGNORE,
                ..Default::default()
            };
            let swap = self.factory.CreateSwapChainForComposition(&self.dxgi, &desc, None)?;
            let ctx = self.d2d.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
            let surface: IDXGISurface = swap.GetBuffer(0)?;
            let props = D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_IGNORE },
                dpiX: dpi,
                dpiY: dpi,
                bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
                ..Default::default()
            };
            let bmp = ctx.CreateBitmapFromDxgiSurface(&surface, Some(&props))?;
            ctx.SetTarget(&bmp);
            ctx.SetDpi(dpi, dpi);
            // The bar is opaque, so text can use ClearType like the rest of Windows.
            ctx.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_CLEARTYPE);
            let brush = ctx.CreateSolidColorBrush(&D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }, None)?;
            let target = self.dcomp.CreateTargetForHwnd(HWND(hwnd), true)?;
            let visual = self.dcomp.CreateVisual()?;
            visual.SetContent(&swap)?;
            target.SetRoot(&visual)?;
            self.dcomp.Commit()?;
            Ok(Surface { swap, ctx, brush, _target: target, _visual: visual })
        }

        /// The first family of `stack` that is installed, else the last (the generic fallback, always there).
        pub unsafe fn family(&self, stack: &[String]) -> String {
            let mut coll = None;
            if self.dw.GetSystemFontCollection(&mut coll, false).is_ok() {
                if let Some(coll) = coll {
                    for f in stack {
                        let (mut index, mut exists) = (0u32, windows::core::BOOL::default());
                        if coll.FindFamilyName(&HSTRING::from(f.as_str()), &mut index, &mut exists).is_ok() && exists.as_bool() {
                            return f.clone();
                        }
                    }
                }
            }
            stack.last().cloned().unwrap_or_else(|| "Segoe UI".into())
        }

        pub unsafe fn fonts(&self, family: &str, size: f32, weight: u32) -> Result<Fonts> {
            let make = |w: u32| -> Result<IDWriteTextFormat> {
                let f = self.dw.CreateTextFormat(
                    &HSTRING::from(family),
                    None,
                    DWRITE_FONT_WEIGHT(w.clamp(100, 900) as i32),
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    size,
                    &HSTRING::from("en-us"),
                )?;
                f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
                f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                let sign = self.dw.CreateEllipsisTrimmingSign(&f)?;
                let trim = DWRITE_TRIMMING { granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER, delimiter: 0, delimiterCount: 0 };
                f.SetTrimming(&trim, &sign)?;
                Ok(f)
            };
            Ok(Fonts { ui: make(weight)?, strong: make((weight + 200).max(600))? })
        }
    }

    pub enum Draw<'a> {
        Fill(D2D_RECT_F, f32, D2D1_COLOR_F),
        Stroke(D2D_RECT_F, f32, D2D1_COLOR_F, f32),
        Text(D2D_RECT_F, &'a str, Face, D2D1_COLOR_F, Align),
    }

    impl Surface {
        pub unsafe fn draw(&self, fonts: &Fonts, clear: D2D1_COLOR_F, items: &[Draw]) -> Result<()> {
            let c = &self.ctx;
            c.BeginDraw();
            c.Clear(Some(&clear));
            for d in items {
                match d {
                    Draw::Fill(r, radius, col) => {
                        self.brush.SetColor(col);
                        if *radius > 0.0 {
                            c.FillRoundedRectangle(&D2D1_ROUNDED_RECT { rect: *r, radiusX: *radius, radiusY: *radius }, &self.brush);
                        } else {
                            c.FillRectangle(r, &self.brush);
                        }
                    }
                    Draw::Stroke(r, radius, col, width) => {
                        self.brush.SetColor(col);
                        let half = width / 2.0;
                        let inset = D2D_RECT_F { left: r.left + half, top: r.top + half, right: r.right - half, bottom: r.bottom - half };
                        c.DrawRoundedRectangle(
                            &D2D1_ROUNDED_RECT { rect: inset, radiusX: *radius, radiusY: *radius },
                            &self.brush,
                            *width,
                            None,
                        );
                    }
                    Draw::Text(r, text, face, col, align) => {
                        self.brush.SetColor(col);
                        let f = if *face == Face::UiStrong { &fonts.strong } else { &fonts.ui };
                        let _ = f.SetTextAlignment(match align {
                            Align::Start => DWRITE_TEXT_ALIGNMENT_LEADING,
                            Align::Center => DWRITE_TEXT_ALIGNMENT_CENTER,
                            Align::End => DWRITE_TEXT_ALIGNMENT_TRAILING,
                        });
                        let t: Vec<u16> = text.encode_utf16().collect();
                        c.DrawText(&t, f, r, &self.brush, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
                    }
                }
            }
            c.EndDraw(None, None)?;
            self.swap.Present(1, DXGI_PRESENT(0)).ok()
        }
    }
}

fn color(c: Rgb) -> gfx::D2D1_COLOR_F {
    gfx::D2D1_COLOR_F { r: c.0 as f32 / 255.0, g: c.1 as f32 / 255.0, b: c.2 as f32 / 255.0, a: 1.0 }
}

fn ink(p: &Palette, i: Ink) -> Rgb {
    match i {
        Ink::Surface => p.surface,
        Ink::Border => p.border,
        Ink::Accent => p.accent,
        Ink::OnAccent => p.on_accent,
        Ink::Foreground => p.foreground,
        Ink::Strong => p.strong,
        Ink::Muted => p.muted,
        Ink::Working => p.working,
    }
}

fn rect(r: bar::Rect) -> gfx::D2D_RECT_F {
    gfx::D2D_RECT_F { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h }
}

/// A layout's ops in the palette's colors, ready to draw.
fn draws<'a>(p: &Palette, ops: &'a [Op]) -> Vec<gfx::Draw<'a>> {
    ops.iter()
        .map(|o| match o {
            Op::Fill { r, radius, ink: k } => gfx::Draw::Fill(rect(*r), *radius, color(ink(p, *k))),
            Op::Stroke { r, radius, ink: k, width } => gfx::Draw::Stroke(rect(*r), *radius, color(ink(p, *k)), *width),
            Op::Text { r, text, face, ink: k, align } => gfx::Draw::Text(rect(*r), text.as_str(), *face, color(ink(p, *k)), *align),
        })
        .collect()
}

// ---- the shell ----------------------------------------------------------------------------------------------

struct Display {
    name: String,
    rect: RECT,
    dpi: u32,
}

struct Bar {
    hwnd: HWND,
    monitor: String,
    /// The display's whole area, in pixels.
    area: RECT,
    dpi: u32,
    /// Where the AppBar sits now (pixels); compared before every re-place so two bars never push each other forever.
    placed: RECT,
    surface: Option<gfx::Surface>,
    /// The workspace drawn as current, and the slide toward it.
    current: u8,
    slide: Option<(u8, Instant)>,
    /// When the feed line that changed this bar was read, until its first frame is drawn.
    heard: Option<Instant>,
}

impl Bar {
    fn scale(&self) -> f32 {
        self.dpi as f32 / 96.0
    }
    fn width_dip(&self) -> f32 {
        (self.area.right - self.area.left) as f32 / self.scale()
    }
}

struct Shell {
    main: HWND,
    paths: Paths,
    dev: gfx::Device,
    fonts: Option<gfx::Fonts>,
    theme: Theme,
    config: Option<PathBuf>,
    dark: bool,
    state: ShellState,
    feed_up: bool,
    bars: Vec<Bar>,
    panel: panel::Panel,
}

fn displays() -> Vec<Display> {
    unsafe extern "system" fn each(m: HMONITOR, _dc: HDC, _r: *mut RECT, lp: LPARAM) -> i32 {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(m, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) != 0 {
            let (mut x, mut y) = (96u32, 96u32);
            let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut x, &mut y);
            let end = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
            (*(lp as *mut Vec<Display>)).push(Display {
                name: String::from_utf16_lossy(&info.szDevice[..end]),
                rect: info.monitorInfo.rcMonitor,
                dpi: x.max(96),
            });
        }
        1
    }
    let mut v: Vec<Display> = vec![];
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), &mut v as *mut Vec<Display> as LPARAM) };
    v
}

/// Windows apps are in dark mode (`AppsUseLightTheme` is 0).
fn system_dark() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("AppsUseLightTheme");
    let mut v: u32 = 1;
    let mut size = 4u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut v as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    r == 0 && v == 0
}

/// Windows' own "Animation effects" switch (Settings > Accessibility > Visual effects).
fn animations_on() -> bool {
    let mut on: i32 = 1;
    unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &mut on as *mut i32 as *mut c_void, 0) };
    on != 0
}

fn appbar(hwnd: HWND) -> APPBARDATA {
    let mut d: APPBARDATA = unsafe { std::mem::zeroed() };
    d.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
    d.hWnd = hwnd;
    d
}

fn same(a: &RECT, b: &RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

impl Shell {
    fn palette(&self) -> &Palette {
        self.theme.palette(self.dark)
    }

    fn height_px(&self, dpi: u32) -> i32 {
        (bar::height(&self.theme) * dpi as f32 / 96.0).round() as i32
    }

    fn load_fonts(&mut self) {
        unsafe {
            let family = self.dev.family(&self.theme.font_ui);
            match self.dev.fonts(&family, bar::text_size(&self.theme), self.theme.weight) {
                Ok(f) => {
                    log(&format!("font {family} {} px", bar::text_size(&self.theme)));
                    self.fonts = Some(f);
                }
                Err(e) => log(&format!("error: fonts for {family}: {e}")),
            }
        }
    }

    /// Asks Windows for the top edge of the bar's display and takes it. Skips the ask's answer when it is where
    /// the bar already is: every SETPOS tells the other bars, and an unconditional re-place would loop.
    fn place(&mut self, i: usize, force: bool) {
        let h = self.height_px(self.bars[i].dpi);
        let b = &mut self.bars[i];
        let mut d = appbar(b.hwnd);
        d.uEdge = ABE_TOP;
        d.rc = RECT { left: b.area.left, top: b.area.top, right: b.area.right, bottom: b.area.top + h };
        unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut d) };
        d.rc.bottom = d.rc.top + h;
        if !force && same(&d.rc, &b.placed) {
            return;
        }
        unsafe {
            SHAppBarMessage(ABM_SETPOS, &mut d);
            SetWindowPos(b.hwnd, HWND_TOPMOST, d.rc.left, d.rc.top, d.rc.right - d.rc.left, h, SWP_NOACTIVATE);
        }
        let resized = b.placed.bottom - b.placed.top != h || b.placed.right - b.placed.left != d.rc.right - d.rc.left;
        b.placed = d.rc;
        log(&format!("bar {} at {},{} {}x{} px, dpi {}", b.monitor, d.rc.left, d.rc.top, d.rc.right - d.rc.left, h, b.dpi));
        if resized || b.surface.is_none() {
            b.surface = None;
            match unsafe { self.dev.surface(b.hwnd, (d.rc.right - d.rc.left) as u32, h as u32, b.dpi as f32) } {
                Ok(s) => b.surface = Some(s),
                Err(e) => log(&format!("error: surface for {}: {e}", b.monitor)),
            }
        }
    }

    fn remove_bars(&mut self) {
        for b in self.bars.drain(..) {
            let mut d = appbar(b.hwnd);
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
            drop(b.surface);
            unsafe { DestroyWindow(b.hwnd) };
        }
    }

    /// One bar per display, from scratch: at start, and when displays, DPI or Explorer change.
    fn rebuild(&mut self) {
        self.remove_bars();
        let class = wide(BAR_CLASS);
        let inst = unsafe { GetModuleHandleW(std::ptr::null()) };
        let found = displays();
        for d in found {
            let h = self.height_px(d.dpi);
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP,
                    class.as_ptr(),
                    wide("Polycarp bar").as_ptr(),
                    WS_POPUP,
                    d.rect.left,
                    d.rect.top,
                    d.rect.right - d.rect.left,
                    h,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    inst,
                    std::ptr::null(),
                )
            };
            if hwnd.is_null() {
                log(&format!("error: no window for {}", d.name));
                continue;
            }
            let mut ab = appbar(hwnd);
            ab.uCallbackMessage = WM_APPBAR;
            if unsafe { SHAppBarMessage(ABM_NEW, &mut ab) } == 0 {
                log(&format!("error: {} is already an AppBar", d.name));
            }
            let current = self.state.current_on(&d.name).unwrap_or(0);
            self.bars.push(Bar {
                hwnd,
                monitor: d.name,
                area: d.rect,
                dpi: d.dpi,
                placed: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                surface: None,
                current,
                slide: None,
                heard: None,
            });
            let i = self.bars.len() - 1;
            self.place(i, true);
            self.paint(i);
            unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        }
        log(&format!("{} bars", self.bars.len()));
    }

    fn layout(&self, i: usize) -> bar::Layout {
        let b = &self.bars[i];
        let slide = b
            .slide
            .map(|(from, t0)| Slide { from, t: (t0.elapsed().as_secs_f32() * 1000.0 / self.theme.normal_ms.max(1) as f32).min(1.0) });
        bar::layout(&self.state, &b.monitor, &self.theme, b.width_dip(), &clock(), slide)
    }

    fn paint(&mut self, i: usize) {
        let l = self.layout(i);
        let p = self.palette().clone();
        let (Some(s), Some(f)) = (self.bars[i].surface.as_ref(), self.fonts.as_ref()) else {
            return;
        };
        if let Err(e) = unsafe { s.draw(f, color(p.surface), &draws(&p, &l.ops)) } {
            log(&format!("error: drawing {}: {e}", self.bars[i].monitor));
            return;
        }
        let b = &mut self.bars[i];
        if let Some(t) = b.heard.take() {
            log(&format!(
                "first frame {} current={} {:.1} ms from the feed line",
                b.monitor,
                b.current,
                t.elapsed().as_secs_f64() * 1000.0
            ));
        }
        let b = &self.bars[i];
        if b.slide.is_none() {
            log(&format!(
                "drawn {} current={} theme={} indicator={:?} feed={}",
                b.monitor,
                b.current,
                self.theme.name,
                self.theme.indicator,
                if self.feed_up { "up" } else { "down" }
            ));
        }
    }

    fn paint_all(&mut self) {
        for i in 0..self.bars.len() {
            self.paint(i);
        }
    }

    fn on_state(&mut self, st: ShellState, heard: Instant) {
        let animate = self.theme.normal_ms > 0 && animations_on();
        let mut sliding = false;
        for b in &mut self.bars {
            let now = st.current_on(&b.monitor).unwrap_or(0);
            if now != b.current {
                log(&format!("state {} {} -> {}", b.monitor, b.current, now));
                b.slide = (animate && b.current != 0 && now != 0).then(|| (b.current, Instant::now()));
                sliding |= b.slide.is_some();
                b.current = now;
                b.heard = Some(heard);
            }
        }
        self.state = st;
        self.paint_all();
        if sliding {
            unsafe { SetTimer(self.main, T_ANIM, 8, None) };
        }
    }

    fn tick(&mut self) {
        let ms = self.theme.normal_ms.max(1) as u128;
        let mut left = false;
        for i in 0..self.bars.len() {
            if let Some((_, t0)) = self.bars[i].slide {
                if t0.elapsed().as_millis() >= ms {
                    self.bars[i].slide = None;
                } else {
                    left = true;
                }
                self.paint(i);
            }
        }
        if !left {
            unsafe { KillTimer(self.main, T_ANIM) };
        }
    }

    /// Reads the theme file again. A file that doesn't read keeps the theme on screen (it may be half written);
    /// no file means the theme is off, so the built-in one.
    fn reload_theme(&mut self) {
        let (t, err) = theme::load(self.config.as_deref());
        if let Some(e) = err {
            log(&format!("theme kept ({}): {e}", self.theme.name));
            return;
        }
        if t == self.theme {
            return;
        }
        let height_changed = bar::height(&t) != bar::height(&self.theme);
        log(&format!(
            "theme {} -> {} (indicator {:?}, radius {}, border {}, font {:?})",
            self.theme.name,
            t.name,
            t.indicator,
            t.radius_small,
            t.border_width,
            t.font_ui.first()
        ));
        self.theme = t;
        self.load_fonts();
        if height_changed {
            for i in 0..self.bars.len() {
                self.place(i, true);
            }
        }
        self.paint_all();
    }

    fn click(&mut self, hwnd: HWND, x: i32, y: i32) {
        let Some(i) = self.bars.iter().position(|b| b.hwnd == hwnd) else {
            return;
        };
        let s = self.bars[i].scale();
        let (x, y) = (x as f32 / s, y as f32 / s);
        let Some(hit) = self.layout(i).hits.into_iter().find(|h| h.r.contains(x, y)) else {
            return;
        };
        log(&format!("click: workspace {} on {}", hit.n, self.bars[i].monitor));
        let paths = self.paths.clone();
        // The same request the CLI sends; the feed brings the result back.
        std::thread::spawn(move || {
            let r = crate::ipc::call(&paths, &serde_json::json!({ "op": "switch", "args": { "n": hit.n } }));
            if !r.ok {
                log(&format!("switch {} refused: {:?}", hit.n, r.error.map(|e| e.message)));
            }
        });
    }
}

fn clock() -> String {
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut st) };
    super::clock_text(st.wDayOfWeek, st.wHour, st.wMinute)
}

fn arm_clock(main: HWND) {
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut st);
        SetTimer(main, T_CLOCK, super::until_next_minute(st.wSecond, st.wMilliseconds), None);
    }
}

/// Runs `f` on the shell unless it is already in use (a message sent while the shell is mid-change).
fn with_shell(f: impl FnOnce(&mut Shell)) -> bool {
    SHELL.with(|c| match c.try_borrow_mut() {
        Ok(mut b) => {
            if let Some(s) = b.as_mut() {
                f(s);
            }
            true
        }
        Err(_) => false,
    })
}

unsafe extern "system" fn main_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_FEED => {
            if let Some((st, heard)) = LATEST.lock().ok().and_then(|mut l| l.take()) {
                if !with_shell(|s| {
                    s.feed_up = true;
                    s.on_state(st.clone(), heard);
                    panel::state_changed(s);
                }) {
                    if let Ok(mut l) = LATEST.lock() {
                        l.get_or_insert((st, heard));
                    }
                    PostMessageW(hwnd, WM_FEED, 0, 0);
                }
            }
            0
        }
        WM_FEED_DOWN => {
            with_shell(|s| {
                s.feed_up = false;
                s.paint_all()
            });
            0
        }
        // Many change notices come for one save: read the file once things settle.
        WM_THEME => {
            SetTimer(hwnd, T_THEME, 80, None);
            0
        }
        WM_HOTKEY => {
            with_shell(|s| panel::toggle(s, "key"));
            0
        }
        WM_LAUNCHER => {
            with_shell(|s| panel::show(s, "command"));
            0
        }
        WM_APPS => {
            with_shell(panel::took_apps);
            0
        }
        WM_REPLACE => {
            with_shell(|s| {
                for i in 0..s.bars.len() {
                    s.place(i, false);
                }
            });
            0
        }
        WM_TIMER => {
            match wp {
                T_CLOCK => {
                    with_shell(|s| s.paint_all());
                    arm_clock(hwnd);
                }
                T_ANIM => {
                    with_shell(|s| s.tick());
                }
                T_THEME => {
                    KillTimer(hwnd, T_THEME);
                    with_shell(|s| s.reload_theme());
                }
                T_REBUILD => {
                    KillTimer(hwnd, T_REBUILD);
                    with_shell(|s| s.rebuild());
                }
                _ => {}
            }
            0
        }
        WM_SETTINGCHANGE => {
            with_shell(|s| {
                let dark = system_dark();
                if dark != s.dark {
                    log(&format!("Windows is now in {} mode", if dark { "dark" } else { "light" }));
                    s.dark = dark;
                    s.paint_all();
                }
            });
            0
        }
        WM_DISPLAYCHANGE => {
            SetTimer(hwnd, T_REBUILD, 300, None);
            0
        }
        WM_CLOSE => {
            with_shell(|s| s.remove_bars());
            PostQuitMessage(0);
            0
        }
        WM_ENDSESSION if wp != 0 => {
            with_shell(|s| s.remove_bars());
            0
        }
        _ if msg != 0 && msg == TASKBAR_CREATED.load(Ordering::Relaxed) => {
            // Explorer restarted and forgot every AppBar.
            SetTimer(hwnd, T_REBUILD, 300, None);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe extern "system" fn bar_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_APPBAR => {
            match wp as u32 {
                ABN_POSCHANGED => post(WM_REPLACE, 0),
                // A full-screen app on this display: step back under it, and come back when it leaves.
                ABN_FULLSCREENAPP => {
                    let after = if lp != 0 { HWND_BOTTOM } else { HWND_TOPMOST };
                    SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
                _ => {}
            }
            0
        }
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_LBUTTONUP => {
            let x = (lp & 0xffff) as u16 as i16 as i32;
            let y = ((lp >> 16) & 0xffff) as u16 as i16 as i32;
            with_shell(|s| s.click(hwnd, x, y));
            0
        }
        WM_DPICHANGED => {
            let main = MAIN.load(Ordering::Relaxed) as HWND;
            SetTimer(main, T_REBUILD, 300, None);
            0
        }
        WM_ERASEBKGND => 1,
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe extern "system" fn on_ctrl(_kind: u32) -> i32 {
    post(WM_CLOSE, 0);
    1
}

// ---- the threads that feed the window -----------------------------------------------------------------------

/// Holds the `subscribe` pipe open and hands each state line to the window; reconnects a second after the daemon
/// goes away.
fn feed(paths: Paths) {
    loop {
        if let Ok(mut f) = crate::ipc::open(&paths) {
            if writeln!(f, r#"{{"op":"subscribe"}}"#).is_ok() && f.flush().is_ok() {
                let mut r = BufReader::new(f);
                let mut line = String::new();
                let ok = r.read_line(&mut line).is_ok() && serde_json::from_str::<serde_json::Value>(&line).is_ok_and(|v| v["ok"] == true);
                if ok {
                    log("feed connected");
                    loop {
                        line.clear();
                        match r.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                if let Some(st) = ShellState::parse_line(line.trim()) {
                                    if let Ok(mut l) = LATEST.lock() {
                                        *l = Some((st, Instant::now()));
                                    }
                                    post(WM_FEED, 0);
                                }
                            }
                        }
                    }
                    log("feed lost: the daemon went away");
                    post(WM_FEED_DOWN, 0);
                } else {
                    log(&format!("feed refused: {}", line.trim()));
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Wakes the window whenever anything under the config folder changes (`polycarp theme set` rewrites
/// `current/theme.json`; `theme off` removes it). Until the folder exists, looks for it every two seconds.
fn watch(dir: PathBuf) {
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    let w = wide(&dir.to_string_lossy());
    loop {
        if !dir.is_dir() {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        let h = unsafe {
            FindFirstChangeNotificationW(
                w.as_ptr(),
                1,
                FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE,
            )
        };
        if h == INVALID_HANDLE_VALUE || h.is_null() {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        log(&format!("watching {}", dir.display()));
        post(WM_THEME, 0);
        loop {
            if unsafe { WaitForSingleObject(h, INFINITE) } != WAIT_OBJECT_0 {
                break;
            }
            post(WM_THEME, 0);
            if unsafe { FindNextChangeNotification(h) } == 0 || !dir.is_dir() {
                break;
            }
        }
        unsafe { FindCloseChangeNotification(h) };
    }
}

// ---- start and stop -----------------------------------------------------------------------------------------

fn stop() -> i32 {
    let class = wide(MAIN_CLASS);
    let h = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    if h.is_null() {
        println!(r#"{{"ok":true,"data":{{"running":false}}}}"#);
        return 0;
    }
    unsafe { PostMessageW(h, WM_CLOSE, 0, 0) };
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(100));
        if unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) }.is_null() {
            println!(r#"{{"ok":true,"data":{{"running":false,"stopped":true}}}}"#);
            return 0;
        }
    }
    eprintln!("baneyspaces shell stop: the shell did not quit within 4 s");
    1
}

/// Asks the running shell to open its launcher, and lets it take the front.
fn open_launcher() -> i32 {
    let class = wide(MAIN_CLASS);
    let h = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    if h.is_null() {
        println!(r#"{{"ok":false,"error":{{"code":"shell_down","message":"the shell is not running","retry":"safe","suggestion":"Start it: baneyspaces shell"}}}}"#);
        return 1;
    }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        AllowSetForegroundWindow(pid);
        PostMessageW(h, WM_LAUNCHER, 0, 0);
    }
    println!(r#"{{"ok":true,"data":{{"launcher":"shown"}}}}"#);
    0
}

pub fn run(args: &[String]) -> i32 {
    match args.get(1).map(String::as_str) {
        Some("stop") => return stop(),
        Some("launcher") => return open_launcher(),
        _ => {}
    }
    let _ = STARTED.set(Instant::now());
    let log_path = args.iter().position(|a| a == "--log").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let _ = LOG.set(Mutex::new(log_path.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok())));
    let paths = Paths::from_env();

    // One shell per user and session.
    let mutex = wide(&format!("{}-shell", paths.mutex_name()));
    unsafe {
        let h = windows_sys::Win32::System::Threading::CreateMutexW(std::ptr::null(), 0, mutex.as_ptr());
        if h.is_null() || GetLastError() == ERROR_ALREADY_EXISTS {
            log("another shell is already running");
            return 3;
        }
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let dev = match unsafe { gfx::Device::new() } {
        Ok(d) => d,
        Err(e) => {
            log(&format!("error: no Direct3D or Direct2D device: {e}"));
            return 1;
        }
    };
    let inst = unsafe { GetModuleHandleW(std::ptr::null()) };
    let main_class = wide(MAIN_CLASS);
    let bar_class = wide(BAR_CLASS);
    let panel_class = wide(panel::CLASS);
    let main = unsafe {
        let cursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
        let classes: [(&Vec<u16>, WNDPROC); 3] =
            [(&main_class, Some(main_proc)), (&bar_class, Some(bar_proc)), (&panel_class, Some(panel::panel_proc))];
        for (class, proc_) in classes {
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: proc_,
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: inst,
                hIcon: std::ptr::null_mut(),
                hCursor: cursor,
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
        }
        TASKBAR_CREATED.store(RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()), Ordering::Relaxed);
        // Never shown, but top-level, so it hears the display, setting and session broadcasts.
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            main_class.as_ptr(),
            wide("Polycarp shell").as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            std::ptr::null(),
        )
    };
    if main.is_null() {
        log("error: the shell's window could not be created");
        return 1;
    }
    MAIN.store(main as isize, Ordering::Relaxed);
    let launcher = panel::create(inst);
    if launcher.is_null() {
        log("error: the launcher's window could not be created");
        return 1;
    }
    panel::register_key(main);

    let config = theme::config_dir();
    let (t, err) = theme::load(config.as_deref());
    if let Some(e) = err {
        log(&format!("theme: built-in ({e})"));
    }
    log(&format!("theme {} (indicator {:?})", t.name, t.indicator));
    let mut shell = Shell {
        main,
        paths: paths.clone(),
        dev,
        fonts: None,
        theme: t,
        config: config.clone(),
        dark: system_dark(),
        state: ShellState::default(),
        feed_up: false,
        bars: vec![],
        panel: panel::Panel::new(launcher),
    };
    shell.load_fonts();
    shell.rebuild();
    SHELL.with(|c| *c.borrow_mut() = Some(shell));
    with_shell(panel::warm);

    std::thread::Builder::new().name("shell-feed".into()).spawn(move || feed(paths)).ok();
    if let Some(dir) = config {
        std::thread::Builder::new().name("shell-theme".into()).spawn(move || watch(dir)).ok();
    }
    arm_clock(main);
    panel::scan();
    unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(on_ctrl), 1) };
    log(&format!("ready pid={}", std::process::id()));

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    SHELL.with(|c| {
        if let Some(mut s) = c.borrow_mut().take() {
            s.remove_bars();
        }
    });
    log("stopped: the top of each display is free again");
    0
}
