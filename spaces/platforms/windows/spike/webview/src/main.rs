//! UI stack spike, candidate B: a WebView2 window (wry on tao) showing the same launcher-sized frame in HTML and CSS,
//! in the same place and size as the native candidate's. It reports `ready` only once its page has loaded and the
//! hotkey is held. The hotkey updates the page and shows the window; `painted` is logged after the page's second
//! animation frame and DWM's next composition (`DwmFlush`). The panel's color alternates by open, with the native
//! candidate's two colors, so `measure.ps1` times both the same way: until that open's color is on screen.

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
    use tao::dpi::{LogicalSize, PhysicalPosition};
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use windows::Win32::System::Performance::QueryPerformanceCounter;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use wry::WebViewBuilder;

    enum Ev {
        Hotkey(i64),
        Loaded,
        Painted,
    }

    fn qpc() -> i64 {
        let mut t = 0i64;
        unsafe {
            let _ = QueryPerformanceCounter(&mut t);
        }
        t
    }

    /// Writes the line and its newline in one `write_all`, so a reader polling the file never sees half a line.
    fn log(line: &str) {
        println!("{line}");
        if let Ok(p) = std::env::var("SPIKE_LOG") {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
            {
                let _ = f.write_all(format!("{line}\n").as_bytes());
            }
        }
    }

    /// The first display adapter's name. WebView2 draws in its own GPU process, so this is the machine's adapter,
    /// not a device this process made (software on GitHub's runners).
    fn adapter() -> String {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
        unsafe {
            CreateDXGIFactory1::<IDXGIFactory1>()
                .and_then(|f| f.EnumAdapters1(0))
                .and_then(|a| a.GetDesc1())
                .map(|d| {
                    let end = d.Description.iter().position(|c| *c == 0).unwrap_or(d.Description.len());
                    String::from_utf16_lossy(&d.Description[..end])
                })
                .unwrap_or_else(|e| format!("unknown ({e})"))
        }
    }

    const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:15px "Segoe UI Variable Text","Segoe UI",sans-serif;color:#f6f3e8;overflow:hidden}
.panel{box-sizing:border-box;height:440px;background:#34382e;border:1px solid #4a4e41;border-radius:16px;padding:18px 8px}
.q{font:22px "Segoe UI Variable Display","Segoe UI",sans-serif;padding:0 16px 14px}
.row{height:40px;line-height:40px;padding:0 16px;margin-bottom:4px;border-radius:10px;color:#bdbfaf}
.row.sel{background:#3d4634;color:#f6f3e8}
</style></head><body><div class="panel"><div class="q" id="q">open 0</div><div id="rows"></div></div>
<script>
addEventListener('load',()=>window.ipc.postMessage('loaded'));
function show(n){document.querySelector('.panel').style.background=n%2?'#34382e':'#2e3a46';
document.getElementById('q').textContent='open '+n;
let h='';for(let i=0;i<8;i++)h+='<div class="row'+(i?'':' sel')+'">Result row '+(i+1)+' with an app name</div>';
document.getElementById('rows').innerHTML=h;
requestAnimationFrame(()=>requestAnimationFrame(()=>window.ipc.postMessage('painted')));}
</script></body></html>"#;

    pub fn run() {
        let el = EventLoopBuilder::<Ev>::with_user_event().build();
        // 680 x 440 device-independent pixels, centered on the primary display a fifth of the way down: where the
        // native candidate puts its frame.
        let (x, y) = el
            .primary_monitor()
            .map(|m| {
                let (size, scale) = (m.size(), m.scale_factor());
                ((size.width as i32 - (680.0 * scale) as i32) / 2, size.height as i32 / 5)
            })
            .unwrap_or((172, 153));
        let window = WindowBuilder::new()
            .with_title("Polycarp spike (webview)")
            .with_decorations(false)
            .with_always_on_top(true)
            .with_visible(false)
            .with_transparent(true)
            .with_inner_size(LogicalSize::new(680.0, 440.0))
            .with_position(PhysicalPosition::new(x, y))
            .build(&el)
            .unwrap();
        let proxy = el.create_proxy();
        let p2 = proxy.clone();
        let webview = WebViewBuilder::new()
            .with_transparent(true)
            .with_html(PAGE)
            .with_ipc_handler(move |req| {
                let _ = p2.send_event(if req.body() == "loaded" { Ev::Loaded } else { Ev::Painted });
            })
            .build(&window)
            .unwrap();
        let mut shown = false;
        let mut t0 = 0i64;
        let mut opens = 0u32;
        let mut loaded = false;
        el.run(move |event, _, flow| {
            *flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(Ev::Hotkey(t)) => {
                    if shown {
                        window.set_visible(false);
                        shown = false;
                        log(&format!("hidden qpc={}", qpc()));
                    } else {
                        t0 = t;
                        opens += 1;
                        let _ = webview.evaluate_script(&format!("show({opens})"));
                        window.set_visible(true);
                        window.set_focus();
                        shown = true;
                    }
                }
                // The page has loaded: only now take the hotkey and say ready, so cold start covers the page too.
                Event::UserEvent(Ev::Loaded) if !loaded => {
                    loaded = true;
                    let rect = match window.outer_position() {
                        Ok(p) => {
                            let s = window.outer_size();
                            format!("{},{},{},{}", p.x, p.y, s.width, s.height)
                        }
                        Err(_) => "unknown".into(),
                    };
                    let dpi = (window.scale_factor() * 96.0).round() as u32;
                    let hp = proxy.clone();
                    // The hotkey on its own thread: WM_HOTKEY goes to that thread's queue.
                    std::thread::spawn(move || unsafe {
                        let key = if RegisterHotKey(None, 1, MOD_CONTROL | MOD_WIN | MOD_NOREPEAT, 'K' as u32)
                            .is_ok()
                        {
                            "ctrl+win+k"
                        } else if RegisterHotKey(None, 1, MOD_ALT | MOD_NOREPEAT, VK_SPACE.0 as u32).is_ok() {
                            "alt+space"
                        } else {
                            "none"
                        };
                        log(&format!(
                            "ready pid={} hotkey={key} rect={rect} dpi={dpi} driver=webview2 adapter={}",
                            std::process::id(),
                            adapter()
                        ));
                        let mut m = MSG::default();
                        while GetMessageW(&mut m, None, 0, 0).as_bool() {
                            if m.message == WM_HOTKEY {
                                let _ = hp.send_event(Ev::Hotkey(qpc()));
                            }
                        }
                    });
                }
                // The page drew its second animation frame after the change; wait for DWM to compose, as native does.
                Event::UserEvent(Ev::Painted) => {
                    let flushed = unsafe { windows::Win32::Graphics::Dwm::DwmFlush() };
                    match flushed {
                        Ok(()) => log(&format!("painted qpc={} hotkey_qpc={t0}", qpc())),
                        Err(e) => log(&format!("error open {opens}: DwmFlush {e}")),
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => *flow = ControlFlow::Exit,
                _ => {}
            }
        });
    }
}
