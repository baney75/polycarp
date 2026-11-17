//! The daemon's requests against real windows on the runner's desktop. Each test builds its own `Core` over a fresh
//! state directory and tracks only the windows it opens (`open_window(.., true)`), never `resync_windows`, which
//! would track and hide the runner's own windows. The tests share the daemon's statics (`STOPPING`), so they run
//! one at a time.

use super::*;
use crate::testwin::{eventually, TestWin};
use std::sync::atomic::AtomicUsize;

static SERIAL: Mutex<()> = Mutex::new(());

struct Rig {
    shared: Shared,
    rx: Receiver<Msg>,
    dir: PathBuf,
    _turn: MutexGuard<'static, ()>,
}

fn rig() -> Rig {
    let turn = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    STOPPING.store(false, Ordering::SeqCst);
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "baneyspaces-daemon-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temporary state directory");
    let (tx, rx) = channel();
    let core = Core {
        model: Model::new(),
        paths: Paths { state: dir.clone() },
        hidden: HiddenSet::default(),
        info: HashMap::new(),
        job: None,
        snaps: HashMap::new(),
        overview_shown: false,
        events_seen: 0,
        closed_at: None,
        started: now(),
        trace: false,
        our_pid: 0,
        problems: vec![],
        settings: settings::parse(""),
        tx,
        last_prune: std::cell::Cell::new(0),
    };
    let shared: Shared = Arc::new(Mutex::new(core));
    lock(&shared).sync_monitors();
    Rig {
        shared,
        rx,
        dir,
        _turn: turn,
    }
}

impl Rig {
    fn req(&self, op: &str, args: Value) -> Envelope {
        handle(&self.shared, &json!({ "op": op, "args": args }))
    }

    /// Tracks a test window where it is: on the workspace its display shows.
    fn track(&self, w: &TestWin) -> String {
        lock(&self.shared).open_window(w.id(), true);
        let id = window_name(w.id());
        assert!(lock(&self.shared).model.is_tracked(&id), "{id} is tracked");
        id
    }

    fn home(&self, id: &str) -> Option<String> {
        lock(&self.shared).model.home(id).map(Home::label)
    }

    fn current(&self) -> Option<u8> {
        let c = lock(&self.shared);
        let m = c.model.focused_monitor()?.to_string();
        c.model.current(&m)
    }

    fn state_json(&self) -> Value {
        serde_json::from_str(
            &lock(&self.shared)
                .paths
                .read("state.json")
                .unwrap_or_default(),
        )
        .unwrap_or(Value::Null)
    }

    fn hidden_how(&self, w: &TestWin) -> Option<How> {
        lock(&self.shared).hidden.get(w.id()).map(|e| e.how)
    }
}

impl Drop for Rig {
    /// Whatever a test left hidden is shown, so a failed test never leaves a window cloaked for the next one.
    fn drop(&mut self) {
        let c = lock(&self.shared);
        let cl = Cloaker::new().ok();
        for e in c.hidden.entries() {
            cloak::show(e, cl.as_ref());
        }
        drop(c);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Out of sight the way the daemon hides your windows: cloaked by the shell, or parked when that was refused.
fn out_of_sight(w: &TestWin) -> bool {
    winapi::cloaked(w.hwnd) != 0 || winapi::is_parked(w.hwnd)
}

fn code(e: &Envelope) -> String {
    e.error.as_ref().map(|b| b.code.clone()).unwrap_or_default()
}

fn message(e: &Envelope) -> String {
    e.error
        .as_ref()
        .map(|b| b.message.clone())
        .unwrap_or_default()
}

#[test]
fn move_stay_hides_the_window_and_records_it_first() {
    let r = rig();
    let w = TestWin::open("daemon move", 0);
    let id = r.track(&w);
    assert_eq!(r.home(&id).as_deref(), Some("1"));
    let e = r.req("move", json!({ "n": 2, "stay": true, "window": id }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(r.home(&id).as_deref(), Some("2"));
    assert_eq!(r.current(), Some(1), "--stay keeps you on workspace 1");
    assert!(
        eventually(|| out_of_sight(&w)),
        "the window left workspace 1"
    );
    assert!(r.hidden_how(&w).is_some());
    let st = r.state_json();
    assert_eq!(st["platform"], "windows");
    assert_eq!(st["windows"][&id]["home"], "2");
    let rows = st["hidden"].as_array().cloned().unwrap_or_default();
    assert!(
        rows.iter().any(|h| h["hwnd"] == json!(w.id())),
        "state.json records the hidden window: {st}"
    );
}

#[test]
fn a_switch_there_and_back_shows_and_hides_each_workspace() {
    let r = rig();
    let a = TestWin::open("daemon on one", 0);
    let b = TestWin::open("daemon on two", 0);
    let ia = r.track(&a);
    let ib = r.track(&b);
    assert!(
        r.req("move", json!({ "n": 2, "stay": true, "window": ib }))
            .ok
    );
    assert!(eventually(|| out_of_sight(&b)));

    let e = r.req("switch", json!({ "n": 2 }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(r.current(), Some(2));
    assert!(
        eventually(|| out_of_sight(&a)),
        "workspace 1 is hidden on 2"
    );
    assert!(eventually(|| !out_of_sight(&b)), "workspace 2 shows");
    assert_eq!(r.hidden_how(&b), None);

    assert!(
        r.req("switch", json!({ "n": "1" })).ok,
        "a number as text is a number"
    );
    assert_eq!(r.current(), Some(1));
    assert!(eventually(|| !out_of_sight(&a)));
    assert!(eventually(|| out_of_sight(&b)));
    assert_eq!(r.state_json()["current"], 1);
    assert_eq!(r.home(&ia).as_deref(), Some("1"));
}

#[test]
fn move_without_stay_follows_the_window() {
    let r = rig();
    let w = TestWin::open("daemon follow", 0);
    let id = r.track(&w);
    let e = r.req("move", json!({ "n": 3, "window": id }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(e.data.as_ref().unwrap()["follow"], true);
    assert_eq!(r.current(), Some(3));
    assert_eq!(r.home(&id).as_deref(), Some("3"));
    assert!(
        eventually(|| !out_of_sight(&w)),
        "the window shows where you followed it"
    );
}

#[test]
fn a_record_that_cannot_be_saved_hides_nothing() {
    let r = rig();
    let w = TestWin::open("daemon unwritable", 0);
    let id = r.track(&w);
    // A file where the state directory should be: every write fails.
    let blocked = r.dir.join("not-a-directory");
    std::fs::write(&blocked, "x").unwrap();
    lock(&r.shared).paths.state = blocked;
    let before = lock(&r.shared).model.view();

    let e = r.req("switch", json!({ "n": 2 }));
    assert!(!e.ok);
    assert_eq!(code(&e), "internal");
    assert!(
        message(&e).contains("nothing was hidden"),
        "{}",
        e.to_json()
    );
    assert_eq!(e.error.as_ref().unwrap().retry, Retry::Safe);
    assert_eq!(
        lock(&r.shared).model.view(),
        before,
        "the model is put back"
    );
    assert!(!out_of_sight(&w), "your window still shows");
    assert_eq!(r.hidden_how(&w), None);

    let e = r.req("agent_move", json!({ "window": id }));
    assert!(
        message(&e).contains("nothing was hidden"),
        "{}",
        e.to_json()
    );
    assert_eq!(r.home(&id).as_deref(), Some("1"));
    assert!(!out_of_sight(&w));

    lock(&r.shared).paths.state = r.dir.clone();
    assert!(
        r.req("switch", json!({ "n": 2 })).ok,
        "once it can be saved the same switch works"
    );
    assert!(eventually(|| out_of_sight(&w)));
}

#[test]
fn settings_get_and_set() {
    let r = rig();
    let all = r.req("get", json!({}));
    assert!(all.ok);
    assert_eq!(all.data.as_ref().unwrap()["dock.enabled"], true);
    assert_eq!(
        r.req("get", json!({ "key": "dock.enabled" })).data.unwrap()["dock.enabled"],
        true
    );
    assert_eq!(
        code(&r.req("get", json!({ "key": "dock.size" }))),
        "invalid_args",
        "an unknown key"
    );

    let e = r.req("set", json!({ "key": "dock.enabled", "value": "false" }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(
        r.req("get", json!({ "key": "dock.enabled" })).data.unwrap()["dock.enabled"],
        false
    );
    let saved = lock(&r.shared)
        .paths
        .read("settings.json")
        .unwrap_or_default();
    assert_eq!(
        settings::parse(&saved)["dock.enabled"],
        false,
        "settings.json holds it"
    );
    assert_eq!(r.state_json()["settings"]["dock.enabled"], false);
    let log = lock(&r.shared)
        .paths
        .read("actions.jsonl")
        .unwrap_or_default();
    assert!(
        log.contains("\"set\""),
        "the set is in the action log: {log}"
    );
    assert!(
        log.lines().all(|l| serde_json::from_str::<Value>(l)
            .is_ok_and(|v| baneyspaces_core::agent::is_content_free(&v))),
        "the log never holds the value: {log}"
    );

    assert_eq!(
        code(&r.req("set", json!({ "key": "appearance.theme", "value": "neon" }))),
        "invalid_args"
    );
    assert_eq!(
        code(&r.req("set", json!({ "key": "dock.size", "value": "3" }))),
        "invalid_args"
    );
    assert_eq!(
        code(&r.req("set", json!({ "key": "dock.enabled" }))),
        "invalid_args",
        "a missing value"
    );
    assert_eq!(
        r.req("get", json!({ "key": "dock.enabled" })).data.unwrap()["dock.enabled"],
        false,
        "a refused set changes nothing"
    );

    let log = r.req("agent_log", json!({ "since": 300 }));
    assert!(log.data.unwrap()["records"]
        .as_array()
        .is_some_and(|a| a.len() == 1));
}

#[test]
fn the_agent_workspace_takes_your_window_and_gives_it_back() {
    let r = rig();
    let w = TestWin::open("daemon agent", 0);
    let id = r.track(&w);
    let e = r.req("agent_move", json!({ "window": id }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(r.home(&id).as_deref(), Some("agent"));
    assert!(eventually(|| out_of_sight(&w)));
    let rec = lock(&r.shared)
        .hidden
        .get(w.id())
        .cloned()
        .expect("recorded before it was hidden");
    assert!(
        !rec.agent,
        "your window on the agent workspace is still yours"
    );
    let st = r.req("agent_status", json!({})).data.unwrap();
    assert_eq!(st["shown"], false);
    assert_eq!(st["windows"][0]["window"], json!(id));

    let e = r.req("agent_show", json!({}));
    assert_eq!(e.data.unwrap()["shown"], true);
    assert!(
        eventually(|| !out_of_sight(&w)),
        "the shown agent workspace shows it"
    );
    assert_eq!(r.req("agent_hide", json!({})).data.unwrap()["shown"], false);
    assert!(eventually(|| out_of_sight(&w)));
    assert_eq!(
        r.req("agent_toggle", json!({})).data.unwrap()["shown"],
        true
    );
    assert_eq!(
        r.req("agent_toggle", json!({})).data.unwrap()["shown"],
        false
    );
    assert!(eventually(|| out_of_sight(&w)));

    let e = r.req("agent_bring", json!({ "window": id }));
    assert!(e.ok, "{}", e.to_json());
    assert_eq!(r.home(&id).as_deref(), Some("1"));
    assert!(
        eventually(|| !out_of_sight(&w)),
        "brought back to the workspace you are on"
    );
    assert_eq!(r.hidden_how(&w), None);
    let ls = r.req("ls", json!({})).data.unwrap();
    assert_eq!(ls["workspaces"]["1"][0]["window"], json!(id));
}

#[test]
fn bad_requests_are_refused_and_change_nothing() {
    let r = rig();
    let w = TestWin::open("daemon bad", 0);
    let id = r.track(&w);
    let cases = [
        ("dance", json!({}), "invalid_args"),
        ("switch", json!({}), "invalid_args"),
        ("switch", json!({ "n": 300 }), "invalid_args"),
        ("move", json!({ "n": 2, "window": "bogus" }), "invalid_args"),
        (
            "move",
            json!({ "n": 2, "app": "no-such-app.exe" }),
            "not_found",
        ),
        ("agent_move", json!({}), "invalid_args"),
        ("agent_bring", json!({}), "invalid_args"),
    ];
    for (op, args, want) in cases {
        let e = r.req(op, args.clone());
        assert!(!e.ok, "{op} {args} was accepted");
        assert_eq!(code(&e), want, "{op} {args}: {}", e.to_json());
    }
    assert_eq!(r.home(&id).as_deref(), Some("1"));
    assert_eq!(r.current(), Some(1));
    assert!(!out_of_sight(&w));
}

#[test]
fn ping_state_overview_and_quit() {
    let r = rig();
    let p = r.req("ping", json!({}));
    assert_eq!(p.data.unwrap()["pong"], true);
    let st = r.req("state", json!({})).data.unwrap();
    assert_eq!(st["platform"], "windows");
    assert!(st["hidden"].is_array());
    assert_eq!(r.req("overview", json!({})).data.unwrap()["shown"], true);
    assert_eq!(r.state_json()["overview"]["shown"], true);
    assert_eq!(r.req("overview", json!({})).data.unwrap()["shown"], false);
    let q = r.req("quit", json!({}));
    assert_eq!(q.data.unwrap()["stopping"], true);
    assert!(
        matches!(r.rx.recv_timeout(Duration::from_secs(1)), Ok(Msg::Quit)),
        "quit asks the main loop to stop"
    );
}

#[test]
fn an_agents_process_may_not_change_your_workspaces() {
    let r = rig();
    let me = std::process::id();
    let start = winapi::process_start(me);
    assert_ne!(start, 0, "the test's own start time reads");
    lock(&r.shared)
        .apply(Event::AgentRegister { pid: me, start })
        .unwrap();
    for op in USER_OPS {
        if *op == "quit" {
            continue; // refused like the rest, but checked last so a mistake can't stop anything
        }
        let e = handle(
            &r.shared,
            &json!({ "op": op, "args": { "n": 2, "window": "w-1" }, "_peer_pid": me }),
        );
        assert_eq!(code(&e), "not_in_scope", "{op}: {}", e.to_json());
    }
    let e = handle(&r.shared, &json!({ "op": "quit", "_peer_pid": me }));
    assert_eq!(code(&e), "not_in_scope");
    assert!(r.rx.try_recv().is_err(), "a refused quit sends nothing");
    assert_eq!(r.current(), Some(1));
    let e = handle(
        &r.shared,
        &json!({ "op": "set", "args": { "key": "dock.enabled", "value": "false" }, "_peer_pid": me }),
    );
    assert!(
        e.ok,
        "an agent may change the appearance settings: {}",
        e.to_json()
    );
    let log = lock(&r.shared)
        .paths
        .read("actions.jsonl")
        .unwrap_or_default();
    assert!(
        log.contains(&me.to_string()),
        "the set is logged with who asked: {log}"
    );
    let other = handle(
        &r.shared,
        &json!({ "op": "switch", "args": { "n": 1 }, "_peer_pid": me + 1 }),
    );
    assert_ne!(code(&other), "not_in_scope", "another process is you");
}

#[test]
fn closing_a_hidden_window_shows_it_before_its_record_goes() {
    let r = rig();
    let w = TestWin::open("daemon close", 0);
    let id = r.track(&w);
    assert!(
        r.req("move", json!({ "n": 2, "stay": true, "window": id }))
            .ok
    );
    assert!(eventually(|| out_of_sight(&w)));
    lock(&r.shared).close_window(&id);
    assert!(
        eventually(|| !out_of_sight(&w)),
        "a window still there is shown first"
    );
    assert_eq!(r.hidden_how(&w), None);
    assert!(!lock(&r.shared).model.is_tracked(&id));
}

#[test]
fn a_restart_puts_back_what_the_last_run_hid() {
    let r = rig();
    let w = TestWin::open("daemon restore", 0);
    let id = r.track(&w);
    assert!(
        r.req("move", json!({ "n": 2, "stay": true, "window": id }))
            .ok
    );
    assert!(eventually(|| out_of_sight(&w)));
    // The run ends without showing anything (a crash): only state.json knows.
    let paths = lock(&r.shared).paths.clone();
    let (shown, kept, failed) = restore_from_file(&paths, true);
    assert_eq!((shown, kept, failed), (1, 0, 0));
    assert!(eventually(|| !out_of_sight(&w)));
    let left = hidden::parse_state(&paths.read("state.json").unwrap_or_default());
    assert!(
        left.hidden.is_empty(),
        "state.json keeps only what is still hidden"
    );
    lock(&r.shared).reload_hidden_from_file();
    assert_eq!(r.hidden_how(&w), None);
}
