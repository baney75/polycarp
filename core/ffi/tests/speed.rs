//! Speed of the voice fast path, in a test with the fixture audio that ships in core/voice/bench.
//!
//! Measures, with a throwaway data folder (never the real one, never a microphone or the keyboard):
//!   * `start_to_ready_ms`: from `pc_open` + `pc_start` until the engine is settled (a model loaded, or, with none
//!     installed, the status moved past `loading`). Median of 7 runs.
//!   * `rtf`: transcription real-time factor (seconds to transcribe / seconds of audio) over the fixture clips,
//!     after one warm-up clip. Needs a speech model: set `POLYCARP_BENCH_MODELS` to a models folder to measure
//!     (read through a symlink, never written). Without it `rtf` is not measured, and says so.
//!
//! `spaces/spec/speed.json` holds the baselines. `fast_path_has_not_regressed` fails if a measurement is more than
//! 25% over its baseline (with a 10 ms floor on the startup number, which is a few milliseconds). Writing baselines is
//! `spaces/scripts/bench-voice --write`, which sets `POLYCARP_BENCH_WRITE=1`.

use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use polycarp_core::*;
use polycarp_voice::{benchmark, models, store};
use serde_json::{json, Value};

const LIMIT: f64 = 1.25;

/// The data folder is process-wide: the measuring tests take turns.
static SERIAL: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn speed_json() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spaces/spec/speed.json")
}

fn status(core: *mut PcCore) -> Value {
    unsafe {
        let p = pc_status(core);
        assert!(!p.is_null());
        let v = serde_json::from_str(&CStr::from_ptr(p).to_string_lossy()).unwrap();
        pc_string_free(p);
        v
    }
}

/// Where the speech models are read from, if the person gave one.
fn models_source() -> Option<PathBuf> {
    std::env::var_os("POLYCARP_BENCH_MODELS").map(PathBuf::from).filter(|p| p.is_dir())
}

fn link_models(dir: &std::path::Path) -> bool {
    match models_source() {
        Some(src) => std::os::unix::fs::symlink(src, dir.join("models")).is_ok(),
        None => false,
    }
}

/// One start: open + start until settled. Headless: no key listener, no network.
fn start_to_ready(with_models: bool) -> Duration {
    let dir = tempfile::tempdir().unwrap();
    let have = with_models && link_models(dir.path());
    let d = CString::new(dir.path().to_str().unwrap()).unwrap();
    let t = Instant::now();
    let core = unsafe { pc_open(d.as_ptr(), PC_HEADLESS, None, None, std::ptr::null_mut()) };
    assert!(!core.is_null());
    assert_eq!(unsafe { pc_start(core) }, PC_OK);
    loop {
        let s = status(core);
        let settled = if have { !s["model"].is_null() } else { s["status"] != "loading" };
        if settled {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "the engine never settled: {s}");
        std::thread::sleep(Duration::from_micros(500));
    }
    let took = t.elapsed();
    unsafe { pc_close(core) };
    store::set_data_dir(None);
    took
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn measure_start() -> f64 {
    let have = models_source().is_some();
    median((0..7).map(|_| start_to_ready(have).as_secs_f64() * 1000.0).collect())
}

/// Real-time factor over the fixture clips, or None without a model.
fn measure_rtf() -> Option<f64> {
    let src = models_source()?;
    let id = "parakeet-v3";
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(&src, dir.path().join("models")).ok()?;
    store::set_data_dir(Some(dir.path().to_path_buf()));
    let result = (|| {
        if !models::installed(id) {
            return None;
        }
        let mut engine = models::Engine::load(id).ok()?;
        let clips = benchmark::load_clips().ok()?;
        engine.transcribe(&clips.first()?.samples, "en").ok()?; // warm-up
        let (mut spent, mut audio) = (0.0, 0.0);
        for c in &clips {
            let t = Instant::now();
            engine.transcribe(&c.samples, "en").ok()?;
            spent += t.elapsed().as_secs_f64();
            audio += c.seconds as f64;
        }
        Some(spent / audio)
    })();
    store::set_data_dir(None);
    result
}

fn baseline() -> Value {
    serde_json::from_str(&std::fs::read_to_string(speed_json()).expect("spaces/spec/speed.json is missing")).unwrap()
}

#[test]
fn the_fixture_audio_is_there_and_decodes() {
    let clips = benchmark::load_clips().unwrap();
    assert!(clips.len() >= 5);
    assert!(clips.iter().all(|c| c.seconds > 1.0 && !c.samples.is_empty()));
}

#[test]
fn measures_and_optionally_writes_baselines() {
    let _turn = SERIAL.lock();
    let start = measure_start();
    let rtf = measure_rtf();
    eprintln!("bench-voice: start_to_ready_ms={start:.2} rtf={rtf:?}");
    assert!(start > 0.0);
    if std::env::var_os("POLYCARP_BENCH_WRITE").is_some() {
        let old = baseline();
        let out = json!({
            "about": "Voice fast-path baselines from spaces/scripts/bench-voice --write. A measurement more than 25% over its baseline fails core/ffi/tests/speed.rs (the startup number has a 10 ms floor). rtf is null until measured on a Mac with a speech model (POLYCARP_BENCH_MODELS).",
            "regressionLimit": LIMIT,
            "startToReadyMs": { "baseline": (start * 100.0).round() / 100.0, "model": models_source().is_some() },
            "transcribeRtf": { "baseline": rtf.map(|r| (r * 1000.0).round() / 1000.0).or_else(|| old["transcribeRtf"]["baseline"].as_f64()) },
            "appLaunchToFirstFrame": old["appLaunchToFirstFrame"].clone(),
        });
        std::fs::write(speed_json(), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    }
}

#[test]
fn fast_path_has_not_regressed() {
    let _turn = SERIAL.lock();
    // Baselines are release timings. A debug build is several times slower, so it is checked by `scripts/bench-voice`
    // (which builds --release), not by a plain `cargo test`.
    if cfg!(debug_assertions) {
        eprintln!("debug build: the speed ratchet runs under scripts/bench-voice");
        return;
    }
    let b = baseline();
    assert_eq!(b["regressionLimit"].as_f64(), Some(LIMIT), "the limit is 25%");
    let base = b["startToReadyMs"]["baseline"].as_f64().expect("start baseline");
    // Same conditions as the baseline: with a model only if the baseline had one.
    if b["startToReadyMs"]["model"].as_bool() == Some(models_source().is_some()) {
        let now = measure_start();
        let allowed = (base * LIMIT).max(base + 10.0);
        assert!(now <= allowed, "start to ready took {now:.2} ms; baseline {base} ms allows {allowed:.2} ms");
    } else {
        eprintln!("start-to-ready baseline was taken {} a model; not compared here", if b["startToReadyMs"]["model"] == true { "with" } else { "without" });
    }
    if let (Some(base), Some(now)) = (b["transcribeRtf"]["baseline"].as_f64(), measure_rtf()) {
        assert!(now <= base * LIMIT, "transcription RTF {now:.3}; baseline {base} allows {:.3}", base * LIMIT);
    } else {
        eprintln!("transcription RTF not compared (no model folder in POLYCARP_BENCH_MODELS, or no baseline yet)");
    }
}
