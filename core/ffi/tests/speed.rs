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

/// The voice keys, set inside whatever else the file holds (the browser helper keeps its numbers there too).
fn merge_voice(mut doc: Value, start: f64, rtf: Option<f64>, with_model: bool) -> Value {
    let obj = doc.as_object_mut().expect("speed.json is an object");
    obj.insert("regressionLimit".into(), json!(LIMIT));
    obj.insert("startToReadyMs".into(), json!({ "baseline": (start * 100.0).round() / 100.0, "model": with_model }));
    let kept = obj.get("transcribeRtf").and_then(|v| v["baseline"].as_f64());
    obj.insert("transcribeRtf".into(), json!({ "baseline": rtf.map(|r| (r * 1000.0).round() / 1000.0).or(kept) }));
    doc
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
        let merged = merge_voice(baseline(), start, rtf, models_source().is_some());
        std::fs::write(speed_json(), serde_json::to_string_pretty(&merged).unwrap() + "\n").unwrap();
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

#[test]
fn writing_baselines_leaves_every_other_key_alone() {
    let before = json!({
        "about": "mine", "browser": { "versionMs": 41 }, "appLaunchToFirstFrame": { "baseline": null },
        "regressionLimit": 1.25, "startToReadyMs": { "baseline": 9, "model": false },
        "transcribeRtf": { "baseline": 0.5 }
    });
    let after = merge_voice(before.clone(), 12.345, None, false);
    assert_eq!(after["browser"], before["browser"]);
    assert_eq!(after["about"], before["about"]);
    assert_eq!(after["appLaunchToFirstFrame"], before["appLaunchToFirstFrame"]);
    assert_eq!(after["startToReadyMs"]["baseline"], json!(12.35));
    assert_eq!(after["transcribeRtf"]["baseline"], json!(0.5), "an unmeasured RTF keeps the old baseline");
    let measured = merge_voice(before, 12.0, Some(0.1234), true);
    assert_eq!(measured["transcribeRtf"]["baseline"], json!(0.123));
    assert_eq!(measured["startToReadyMs"]["model"], json!(true));
}

/// A long dictation in one voice, transcribed in pieces at its pauses, against all at once: each of the speech set's
/// speakers says their clip over and over with a pause between. Needs POLYCARP_BENCH_MODELS.
#[test]
fn long_dictation_in_pieces_is_as_accurate_and_waits_less_at_release() {
    let _serial = SERIAL.lock();
    let Some(source) = models_source() else {
        eprintln!("long dictation: no POLYCARP_BENCH_MODELS, not measured");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(source, dir.path().join("models")).unwrap();
    store::set_data_dir(Some(dir.path().to_path_buf()));
    let mut engine = models::Engine::load("parakeet-v3").unwrap();
    let _ = engine.transcribe(&vec![0.0; 16_000], "en").unwrap();
    let (mut whole_ms, mut release_ms, mut whole_wer, mut pieces_wer) = (vec![], vec![], vec![], vec![]);
    for clip in benchmark::load_clips().unwrap().iter() {
        let mut audio: Vec<f32> = vec![];
        let mut reference = String::new();
        while (audio.len() as f32) < 45.0 * 16_000.0 {
            audio.extend_from_slice(&clip.samples);
            audio.extend(std::iter::repeat_n(0.0002, 8_000)); // 500 ms
            reference.push_str(&clip.text);
            reference.push(' ');
        }
        let t = Instant::now();
        let whole = engine.transcribe(&audio, "en").unwrap();
        whole_ms.push(t.elapsed().as_secs_f64() * 1000.0);

        // What the worker does, in order: look at the audio not yet done every tenth of a second.
        let mut text = String::new();
        let mut done = 0;
        let mut heard = 16_000;
        while heard < audio.len() {
            heard = (heard + 1_600).min(audio.len());
            if let Some(cut) = polycarp_voice::pieces::find_cut(&audio[done..heard], 16_000) {
                let piece = engine.transcribe(&audio[done..done + cut], "en").unwrap();
                polycarp_voice::pieces::join(&mut text, &piece);
                done += cut;
            }
        }
        let t = Instant::now();
        let last = engine.transcribe(&audio[done..], "en").unwrap();
        release_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        polycarp_voice::pieces::join(&mut text, &last);
        whole_wer.push(benchmark::wer(&reference, &whole) as f64);
        pieces_wer.push(benchmark::wer(&reference, &text) as f64);
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    eprintln!(
        "long dictation, one voice, 45 s+: all at once {:.0} ms, wer {:.4}; in pieces {:.0} ms at release, wer {:.4}",
        mean(&whole_ms), mean(&whole_wer), mean(&release_ms), mean(&pieces_wer)
    );
    eprintln!("per voice, whole {whole_wer:.3?} pieces {pieces_wer:.3?}");
    assert!(mean(&pieces_wer) <= mean(&whole_wer) + 0.01, "pieces {pieces_wer:?} against whole {whole_wer:?}");
    assert!(mean(&release_ms) < mean(&whole_ms) * 0.5, "{release_ms:?} ms at release against {whole_ms:?} ms");
}
