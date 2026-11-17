//! UI stack spike, candidate B: a WebView2 window (wry on tao) showing the same launcher-sized frame in HTML and CSS.
//! It stays hidden and warm; the hotkey updates the page, shows the window and logs the performance counter once the
//! page has drawn two animation frames after the change, so `measure.ps1` can time key to paint.

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
    use tao::dpi::{LogicalPosition, LogicalSize};
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::WindowBuilder;
    use windows::Win32::System::Performance::QueryPerformanceCounter;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use wry::WebViewBuilder;

    enum Ev {
        Hotkey(i64),
        Painted(i64),
    }

    fn qpc() -> i64 {
        let mut t = 0i64;
        unsafe {
            let _ = QueryPerformanceCounter(&mut t);
        }
        t
    }

    fn log(line: &str) {
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

    const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:15px "Segoe UI Variable Text","Segoe UI",sans-serif;color:#f6f3e8;overflow:hidden}
.panel{box-sizing:border-box;height:440px;background:#34382e;border:1px solid #4a4e41;border-radius:16px;padding:18px 8px}
.q{font:22px "Segoe UI Variable Display","Segoe UI",sans-serif;padding:0 16px 14px}
.row{height:40px;line-height:40px;padding:0 16px;margin-bottom:4px;border-radius:10px;color:#bdbfaf}
.row.sel{background:#3d4634;color:#f6f3e8}
</style></head><body><div class="panel"><div class="q" id="q">open 0</div><div id="rows"></div></div>
<script>
let n=0;
function show(){n++;document.getElementById('q').textContent='open '+n;
let h='';for(let i=0;i<8;i++)h+='<div class="row'+(i?'':' sel')+'">Result row '+(i+1)+' with an app name</div>';
document.getElementById('rows').innerHTML=h;
requestAnimationFrame(()=>requestAnimationFrame(()=>window.ipc.postMessage('painted')));}
</script></body></html>"#;

    pub fn run() {
        let el = EventLoopBuilder::<Ev>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title("Polycarp spike (webview)")
            .with_decorations(false)
            .with_always_on_top(true)
            .with_visible(false)
            .with_transparent(true)
            .with_inner_size(LogicalSize::new(680.0, 440.0))
            .with_position(LogicalPosition::new(300.0, 150.0))
            .build(&el)
            .unwrap();
        let proxy = el.create_proxy();
        let p2 = proxy.clone();
        let webview = WebViewBuilder::new()
            .with_transparent(true)
            .with_html(PAGE)
            .with_ipc_handler(move |_req| {
                let _ = p2.send_event(Ev::Painted(qpc()));
            })
            .build(&window)
            .unwrap();
        // The hotkey on its own thread: WM_HOTKEY goes to that thread's queue.
        let hp = proxy.clone();
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
            log(&format!("ready pid={} hotkey={key}", std::process::id()));
            let mut m = MSG::default();
            while GetMessageW(&mut m, None, 0, 0).as_bool() {
                if m.message == WM_HOTKEY {
                    let _ = hp.send_event(Ev::Hotkey(qpc()));
                }
            }
        });
        let mut shown = false;
        let mut t0 = 0i64;
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
                        let _ = webview.evaluate_script("show()");
                        window.set_visible(true);
                        window.set_focus();
                        shown = true;
                    }
                }
                Event::UserEvent(Ev::Painted(t)) => {
                    log(&format!("painted qpc={t} hotkey_qpc={t0}"))
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
