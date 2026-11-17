//! UI stack spike, candidate A: a native window drawn with Direct2D and DirectWrite into a DXGI swap chain that
//! DirectComposition puts on screen. It stays hidden and warm; the hotkey draws a launcher-sized frame, shows it and
//! logs the performance counter once DWM has composed it (`DwmFlush`), so `measure.ps1` can time key to paint.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() {
    eprintln!("windows only");
}

#[cfg(windows)]
fn main() {
    win::run();
}

#[cfg(windows)]
mod win {
    use std::io::Write;
    use windows::core::{w, Interface, Result, PCWSTR};
    use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Direct2D::Common::*;
    use windows::Win32::Graphics::Direct2D::*;
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::DirectComposition::*;
    use windows::Win32::Graphics::DirectWrite::*;
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Performance::QueryPerformanceCounter;
    use windows::Win32::UI::HiDpi::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    const W: u32 = 680;
    const H: u32 = 440;

    struct Gfx {
        swap: IDXGISwapChain1,
        ctx: ID2D1DeviceContext,
        _dcomp: IDCompositionDevice,
        _target: IDCompositionTarget,
        _visual: IDCompositionVisual,
        text: IDWriteTextFormat,
        big: IDWriteTextFormat,
    }

    static mut GFX: Option<Gfx> = None;
    static mut SHOWN: bool = false;
    static mut OPENS: u32 = 0;

    fn qpc() -> i64 {
        let mut t = 0i64;
        unsafe {
            let _ = QueryPerformanceCounter(&mut t);
        }
        t
    }

    pub fn log(line: &str) {
        println!("{line}");
        if let Ok(p) = std::env::var("SPIKE_LOG") {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
            {
                let _ = writeln!(f, "{line}");
            }
        }
    }

    fn color(hex: u32, a: f32) -> D2D1_COLOR_F {
        D2D1_COLOR_F {
            r: ((hex >> 16) & 255) as f32 / 255.0,
            g: ((hex >> 8) & 255) as f32 / 255.0,
            b: (hex & 255) as f32 / 255.0,
            a,
        }
    }

    unsafe fn gfx(hwnd: HWND) -> Result<Gfx> {
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
        let d3d = d3d.unwrap();
        let dxgi: IDXGIDevice = d3d.cast()?;
        let factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: W,
            Height: H,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            ..Default::default()
        };
        let swap = factory.CreateSwapChainForComposition(&dxgi, &desc, None)?;
        let d2f: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
        let dev = d2f.CreateDevice(&dxgi)?;
        let ctx = dev.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        let surface: IDXGISurface = swap.GetBuffer(0)?;
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            ..Default::default()
        };
        let bmp = ctx.CreateBitmapFromDxgiSurface(&surface, Some(&props))?;
        ctx.SetTarget(&bmp);
        let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
        let target = dcomp.CreateTargetForHwnd(hwnd, true)?;
        let visual = dcomp.CreateVisual()?;
        visual.SetContent(&swap)?;
        target.SetRoot(&visual)?;
        dcomp.Commit()?;
        let dw: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let text = dw.CreateTextFormat(
            w!("Segoe UI Variable Text"),
            None,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            15.0,
            w!("en-us"),
        )?;
        let big = dw.CreateTextFormat(
            w!("Segoe UI Variable Display"),
            None,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            22.0,
            w!("en-us"),
        )?;
        Ok(Gfx {
            swap,
            ctx,
            _dcomp: dcomp,
            _target: target,
            _visual: visual,
            text,
            big,
        })
    }

    unsafe fn draw(g: &Gfx, n: u32) -> Result<()> {
        let c = &g.ctx;
        c.BeginDraw();
        c.Clear(Some(&color(0, 0.0)));
        let panel = D2D1_ROUNDED_RECT {
            rect: D2D_RECT_F {
                left: 0.5,
                top: 0.5,
                right: W as f32 - 0.5,
                bottom: H as f32 - 0.5,
            },
            radiusX: 16.0,
            radiusY: 16.0,
        };
        let surface = c.CreateSolidColorBrush(&color(0x34382e, 1.0), None)?;
        let border = c.CreateSolidColorBrush(&color(0x4a4e41, 1.0), None)?;
        let fg = c.CreateSolidColorBrush(&color(0xf6f3e8, 1.0), None)?;
        let muted = c.CreateSolidColorBrush(&color(0xbdbfaf, 1.0), None)?;
        let sel = c.CreateSolidColorBrush(&color(0x3d4634, 1.0), None)?;
        c.FillRoundedRectangle(&panel, &surface);
        c.DrawRoundedRectangle(&panel, &border, 1.0, None);
        let q: Vec<u16> = format!("open {n}").encode_utf16().collect();
        c.DrawText(
            &q,
            &g.big,
            &D2D_RECT_F {
                left: 24.0,
                top: 18.0,
                right: W as f32 - 24.0,
                bottom: 60.0,
            },
            &fg,
            D2D1_DRAW_TEXT_OPTIONS_NONE,
            DWRITE_MEASURING_MODE_NATURAL,
        );
        for i in 0..8 {
            let top = 76.0 + i as f32 * 44.0;
            if i == 0 {
                let r = D2D1_ROUNDED_RECT {
                    rect: D2D_RECT_F {
                        left: 8.0,
                        top,
                        right: W as f32 - 8.0,
                        bottom: top + 40.0,
                    },
                    radiusX: 10.0,
                    radiusY: 10.0,
                };
                c.FillRoundedRectangle(&r, &sel);
            }
            let t: Vec<u16> = format!("Result row {} with an app name", i + 1)
                .encode_utf16()
                .collect();
            c.DrawText(
                &t,
                &g.text,
                &D2D_RECT_F {
                    left: 24.0,
                    top: top + 10.0,
                    right: W as f32 - 24.0,
                    bottom: top + 36.0,
                },
                if i == 0 { &fg } else { &muted },
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                DWRITE_MEASURING_MODE_NATURAL,
            );
        }
        c.EndDraw(None, None)?;
        g.swap.Present(1, DXGI_PRESENT(0)).ok()
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_HOTKEY => {
                let t0 = qpc();
                if SHOWN {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    SHOWN = false;
                    log(&format!("hidden qpc={}", qpc()));
                } else {
                    OPENS += 1;
                    #[allow(static_mut_refs)]
                    if let Some(g) = GFX.as_ref() {
                        let _ = draw(g, OPENS);
                    }
                    let _ = ShowWindow(hwnd, SW_SHOW);
                    let _ = SetForegroundWindow(hwnd);
                    let _ = DwmFlush();
                    SHOWN = true;
                    log(&format!("painted qpc={} hotkey_qpc={t0}", qpc()));
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    pub fn run() {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let inst = GetModuleHandleW(None).unwrap();
            let class = w!("PolycarpSpikeNative");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: inst.into(),
                lpszClassName: class,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let sw = GetSystemMetrics(SM_CXSCREEN);
            let sh = GetSystemMetrics(SM_CYSCREEN);
            let hwnd = CreateWindowExW(
                WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class,
                w!("Polycarp spike (native)"),
                WS_POPUP,
                (sw - W as i32) / 2,
                sh / 5,
                W as i32,
                H as i32,
                None,
                None,
                Some(inst.into()),
                None,
            )
            .unwrap();
            match gfx(hwnd) {
                Ok(g) => GFX = Some(g),
                Err(e) => {
                    log(&format!("error gfx {e}"));
                    std::process::exit(1);
                }
            }
            let key = if RegisterHotKey(
                Some(hwnd),
                1,
                MOD_CONTROL | MOD_WIN | MOD_NOREPEAT,
                'K' as u32,
            )
            .is_ok()
            {
                "ctrl+win+k"
            } else if RegisterHotKey(Some(hwnd), 1, MOD_ALT | MOD_NOREPEAT, VK_SPACE.0 as u32)
                .is_ok()
            {
                "alt+space"
            } else {
                "none"
            };
            log(&format!("ready pid={} hotkey={key}", std::process::id()));
            let mut m = MSG::default();
            while GetMessageW(&mut m, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&m);
                DispatchMessageW(&m);
            }
            let _ = PCWSTR::null();
        }
    }
}
