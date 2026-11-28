//! The `polycarp sync` command. Each run reads the relay first and changes nothing here until the relay answered and
//! every bundle checked out, so an unreachable relay or a changed bundle leaves this device as it was.

use super::auto::{self, Backoff, Paused};
use super::crypto::{self, Device, DeviceList, Me, Sealed};
use super::model::{self, Bundle};
use super::prefs;
use super::relay::{self, Relay};
use super::settings::{self, Paths};
use super::store::{Ask, KeyError, Store};
use crate::files::config::Os;
use age::secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
polycarp sync: Polycarp's settings, the same on each of your own devices. Docs: docs/sync.md.

  polycarp sync init [--relay ADDR] [--name NAME] [--auto]
                                                    set up this device (the first, or one to approve)
  polycarp sync approve CODE [--fingerprint FP]     on a device already set up: let the new one in
  polycarp sync now [--approver FP]                 sync now (FP: the approving device's, the first time)
  polycarp sync now --background                    what the 5-minute run does: quiet, waits after failures
  polycarp sync auto on|off|status                  sync on its own every 5 minutes (--auto at init)
  polycarp sync devices                             the devices that take part
  polycarp sync remove DEVICE                       drop a device; later bundles are sealed without it

ADDR is ssh:HOST, ssh:HOST:DIR or dir:/PATH (default ssh:parish1). The relay holds only ciphertext.";

const DEVICES: &str = "devices.json";
const SETTINGS: &str = "settings.age.json";
const PREFS: &str = "prefs.age.json";
const AUTO: &str = "auto.json";
const NEEDS_KEYCHAIN: &str = "needs-keychain";

#[derive(Serialize, Deserialize)]
struct State {
    relay: String,
    name: String,
}

struct Ctx {
    dir: PathBuf,
    paths: Paths,
    prefs: prefs::Store,
    /// A background run: notes go to the sync log, never the screen.
    quiet: bool,
    /// Whether reading this device's key may put a system prompt on screen; never in a background run.
    ask: Ask,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn support_dir() -> Result<PathBuf, String> {
    let var = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if let Some(d) = var("POLYCARP_SUPPORT_DIR") {
        return d
            .is_absolute()
            .then_some(d)
            .ok_or("POLYCARP_SUPPORT_DIR must be an absolute path".into());
    }
    if cfg!(windows) {
        return var("APPDATA")
            .map(|a| a.join("Polycarp"))
            .ok_or("APPDATA is not set".into());
    }
    let home = var("HOME").ok_or("HOME is not set")?;
    Ok(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Polycarp")
    } else {
        home.join(".local/share/polycarp")
    })
}

fn ctx() -> Result<Ctx, String> {
    let config = crate::theme::config_dir()?;
    let dir = config.join("sync");
    Ok(Ctx {
        prefs: prefs::store(&dir)?,
        dir,
        paths: Paths {
            config,
            support: support_dir()?,
        },
        quiet: false,
        ask: Ask::Prompt,
    })
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<Option<T>, String> {
    match fs::read(p) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| format!("{} is damaged: {e}", p.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", p.display())),
    }
}

fn write_json<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    let tmp = p.with_extension("tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?,
    )
    .and_then(|_| fs::rename(&tmp, p))
    .map_err(|e| format!("could not write {}: {e}", p.display()))
}

fn private_dir(d: &Path) -> Result<(), String> {
    fs::create_dir_all(d).map_err(|e| format!("could not make {}: {e}", d.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// This device's key, made on first use. The note says when it had to go in a file. A read that works ends a pause
/// for the Keychain.
fn identity(c: &Ctx, make: bool) -> Result<(Me, Option<String>), KeyError> {
    let (store, note) = Store::open(&c.dir)?;
    if let Some(s) = store.load_with(c.ask)? {
        let _ = fs::remove_file(c.dir.join(NEEDS_KEYCHAIN));
        return Ok((Me::from_secret(s.expose_secret())?, None));
    }
    if !make {
        return Err("this device has no sync key yet; run `polycarp sync init`"
            .to_string()
            .into());
    }
    let me = Me::generate();
    store.save(&me.secret())?;
    Ok((me, note))
}

fn load(c: &Ctx) -> Result<(State, Me, Device, Relay), KeyError> {
    let st: State = read_json(&c.dir.join("state.json"))?
        .ok_or_else(|| "sync is not set up here; run `polycarp sync init`".to_string())?;
    let (me, _) = identity(c, false)?;
    let dev = me.device(&st.name);
    let relay = Relay::parse(&st.relay)?;
    Ok((st, me, dev, relay))
}

fn relay_list(r: &Relay) -> Result<Option<DeviceList>, String> {
    match r.get(DEVICES)? {
        None => Ok(None),
        Some(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|_| "the device list on the relay is not readable, so it was refused".into()),
    }
}

fn trusted(c: &Ctx) -> Result<Option<DeviceList>, String> {
    read_json(&c.dir.join(DEVICES))
}

fn pairing_code() -> String {
    const ABC: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut raw = [0u8; 8];
    getrandom::getrandom(&mut raw).expect("the system's random numbers");
    let s: String = raw
        .iter()
        .map(|b| ABC[*b as usize % ABC.len()] as char)
        .collect();
    format!("{}-{}", &s[..4], &s[4..])
}

fn pending_name(code: &str) -> Option<String> {
    let c = code.trim().to_ascii_lowercase().replace('-', "");
    (c.len() == 8 && c.bytes().all(|b| b.is_ascii_alphanumeric()))
        .then(|| format!("pending-{c}.json"))
}

fn init(relay_addr: Option<&str>, name: Option<&str>) -> Result<(), String> {
    let c = ctx()?;
    private_dir(&c.dir)?;
    let old: Option<State> = read_json(&c.dir.join("state.json"))?;
    let relay_addr = relay_addr
        .map(str::to_string)
        .or(old.as_ref().map(|s| s.relay.clone()))
        .unwrap_or(relay::DEFAULT.into());
    let relay = Relay::parse(&relay_addr)?;
    let (me, note) = identity(&c, true)?;
    let name = name
        .map(str::to_string)
        .or(old.map(|s| s.name))
        .unwrap_or_else(|| format!("device-{}", &me.device("").id[..6]));
    if name.is_empty() || name.len() > 40 || name.chars().any(char::is_control) {
        return Err("a device name is 1 to 40 characters".into());
    }
    let dev = me.device(&name);
    if let Some(n) = note {
        println!("{n}");
    }
    write_json(
        &c.dir.join("state.json"),
        &State {
            relay: relay_addr.clone(),
            name: name.clone(),
        },
    )?;
    println!("This device: {name}, fingerprint {}", dev.fingerprint());
    match relay_list(&relay)? {
        None => {
            let list = DeviceList::signed(&me, &name, 1, vec![dev]);
            relay.put(
                DEVICES,
                &serde_json::to_vec(&list).map_err(|e| e.to_string())?,
            )?;
            write_json(&c.dir.join(DEVICES), &list)?;
            println!("It is the first device on {relay_addr}. Run `polycarp sync now` to send its settings.");
        }
        Some(list) if list.get(&dev.id).is_some() && trusted(&c)?.is_some() => {
            println!("It is already set up on {relay_addr}.");
        }
        Some(_) => {
            let code = pairing_code();
            let file = pending_name(&code).expect("a made code is valid");
            relay.put(&file, &serde_json::to_vec(&dev).map_err(|e| e.to_string())?)?;
            println!("Pairing code: {code}");
            println!(
                "On a device already set up, run `polycarp sync approve {code}` and check it shows the fingerprint \
                 above. It then prints the command to run here."
            );
        }
    }
    Ok(())
}

fn confirm(question: &str) -> bool {
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).is_ok() && line.trim().eq_ignore_ascii_case("y")
}

fn same_fp(a: &str, b: &str) -> bool {
    let n = |s: &str| s.to_ascii_uppercase().replace(['-', ' '], "");
    n(a) == n(b)
}

/// A new list, signed here: every bundle is sealed again to it first, then the list is put on the relay and kept. The
/// bundles there now were made under `old`, so they are checked against it: one last written by a device being
/// removed still counts. A failure on the way leaves the old list on the relay, which every device can still use
/// with the bundle there: the resealed one is signed by this device, which is on both lists.
fn publish(
    c: &Ctx,
    me: &Me,
    dev: &Device,
    relay: &Relay,
    old: &DeviceList,
    list: DeviceList,
) -> Result<(), String> {
    sync_settings(c, me, dev, relay, old, &list)?;
    relay.put(
        DEVICES,
        &serde_json::to_vec(&list).map_err(|e| e.to_string())?,
    )?;
    write_json(&c.dir.join(DEVICES), &list)
}

fn approve(code: &str, fingerprint: Option<&str>) -> Result<(), String> {
    let c = ctx()?;
    let (st, me, dev, relay) = load(&c)?;
    let list = current_list(&c, &dev, &relay, None)?;
    let file = pending_name(code).ok_or_else(|| format!("{code} is not a pairing code"))?;
    let b = relay
        .get(&file)?
        .ok_or_else(|| format!("no device is waiting with code {code} on {}", st.relay))?;
    let new: Device =
        serde_json::from_slice(&b).map_err(|_| "the waiting device's record is not readable")?;
    new.check()?;
    // The record came from the relay: a name that could move the cursor or forge a line is refused before it is shown.
    if new.name.is_empty() || new.name.len() > 40 || new.name.chars().any(char::is_control) {
        return Err(
            "the waiting device's name is not 1 to 40 plain characters, so it was refused".into(),
        );
    }
    println!(
        "{} wants to join, with fingerprint {}",
        new.name,
        new.fingerprint()
    );
    let ok = match fingerprint {
        Some(fp) => same_fp(fp, &new.fingerprint()),
        None => confirm(&format!("Does {} show exactly this fingerprint?", new.name)),
    };
    if !ok {
        return Err("the fingerprints don't match, so it was not let in".into());
    }
    let mut devices: Vec<Device> = list
        .devices
        .iter()
        .filter(|d| d.id != new.id)
        .cloned()
        .collect();
    devices.push(new.clone());
    let next = DeviceList::signed(&me, &st.name, list.version + 1, devices);
    publish(&c, &me, &dev, &relay, &list, next)?;
    relay.remove(&file)?;
    println!(
        "{} is in. On {}, run: polycarp sync now --approver {}",
        new.name,
        new.name,
        dev.fingerprint()
    );
    Ok(())
}

/// The device list to use now: the relay's when it is newer and checks out, else this device's own.
fn current_list(
    c: &Ctx,
    dev: &Device,
    relay: &Relay,
    approver: Option<&str>,
) -> Result<DeviceList, String> {
    let theirs =
        relay_list(relay)?.ok_or("the relay has no device list; run `polycarp sync init`")?;
    let list = match trusted(c)? {
        Some(mine) if theirs == mine => mine,
        Some(mine) => {
            theirs.accept(&mine, &dev.id)?;
            theirs
        }
        None => {
            let fp = approver.ok_or(
                "this device has not taken a device list yet; run the `polycarp sync now --approver ...` line the \
                 approving device printed",
            )?;
            theirs.accept_first(&dev.id, fp)?;
            theirs
        }
    };
    if list.get(&dev.id).is_none() {
        return Err("this device was removed from sync, so nothing was changed here".into());
    }
    write_json(&c.dir.join(DEVICES), &list)?;
    Ok(list)
}

/// A bundle of `kind` from the relay, checked against `opened`.
fn fetch(
    me: &Me,
    relay: &Relay,
    opened: &DeviceList,
    file: &str,
    kind: &str,
) -> Result<Option<(Sealed, Bundle)>, String> {
    let Some(b) = relay.get(file)? else {
        return Ok(None);
    };
    let refused = |why: &str| {
        format!("the {kind} bundle on the relay was refused: {why}; nothing of it was applied")
    };
    let sealed: Sealed = serde_json::from_slice(&b).map_err(|_| refused("it is not readable"))?;
    let plain = crypto::open(me, opened, kind, &sealed)?;
    let bundle: Bundle = serde_json::from_slice(&plain)
        .ok()
        .filter(|b: &Bundle| b.kind == kind)
        .ok_or_else(|| refused("it is damaged"))?;
    Ok(Some((sealed, bundle)))
}

/// This device's `snap` joined with `last` and the relay's bundle: the bundle to keep and send.
fn join(
    dev: &Device,
    kind: &str,
    last: Option<&Bundle>,
    mut snap: BTreeMap<String, Json>,
    theirs: Option<&Bundle>,
) -> Bundle {
    // A device's first sync joins what the others already have. Its own values are not edits made after theirs
    // (a new install's defaults would win over months of settings), so where the relay has an item, the relay's
    // stands, and this device adds only what the relay has never had.
    if let (None, Some(b)) = (last, theirs) {
        snap.retain(|id, _| !b.items.contains_key(id));
    }
    let empty = Bundle {
        kind: kind.into(),
        ..Default::default()
    };
    let local = model::observe(last.unwrap_or(&empty), &snap, now_ms(), &dev.id);
    let mut merged = match theirs {
        Some(b) => model::merge(&local, b),
        None => local,
    };
    model::prune(&mut merged, now_ms());
    merged
}

/// Seals `merged` to `list` and puts it on the relay, unless the relay already holds it sealed to this list.
#[allow(clippy::too_many_arguments)]
fn send(
    me: &Me,
    dev: &Device,
    relay: &Relay,
    list: &DeviceList,
    file: &str,
    kind: &str,
    merged: &Bundle,
    theirs: Option<&(Sealed, Bundle)>,
) -> Result<(), String> {
    if theirs.is_some_and(|(s, b)| b == merged && s.list_version == list.version) {
        return Ok(());
    }
    let plain = serde_json::to_vec(merged).map_err(|e| e.to_string())?;
    let sealed = crypto::seal(me, &dev.id, list, kind, &plain)?;
    relay.put(
        file,
        &serde_json::to_vec(&sealed).map_err(|e| e.to_string())?,
    )
}

/// The `prefs:` values of a settings bundle from before preferences had their own, as a `prefs` bundle. Its deletes
/// are left out: a build from before preferences synced at all wrote a delete for every one it saw, so a delete
/// there is no one's choice.
fn prefs_part(b: &Bundle) -> Option<Bundle> {
    let items: BTreeMap<_, _> = b
        .items
        .iter()
        .filter(|(id, i)| id.starts_with("prefs:") && i.value.is_some())
        .map(|(id, i)| (id.clone(), i.clone()))
        .collect();
    (!items.is_empty()).then(|| Bundle {
        kind: "prefs".into(),
        items,
    })
}

/// One preferences sync, in its own bundle. A build from before it never opens that bundle, so it can't take a
/// preference it doesn't read for a delete. Until some device has written that bundle, the relay's side is the
/// `prefs:` values the settings bundle held, with their times. A device that has never synced this bundle is at its
/// first sync whatever its settings state holds: a build from before #895 never read its own preferences, so what
/// its Mac holds now was never synced, and the relay's values stand. Returns the domain or file written here.
#[allow(clippy::too_many_arguments)]
fn sync_prefs(
    c: &Ctx,
    me: &Me,
    dev: &Device,
    relay: &Relay,
    opened: &DeviceList,
    list: &DeviceList,
    old_theirs: Option<&Bundle>,
) -> Result<Vec<PathBuf>, String> {
    let fetched = fetch(me, relay, opened, PREFS, "prefs")?;
    let theirs = match &fetched {
        Some((_, b)) => Some(b.clone()),
        None => old_theirs.and_then(prefs_part),
    };
    let last_path = c.dir.join("prefs.last.json");
    let last: Option<Bundle> = read_json(&last_path)?;
    let last_values = last.as_ref().map(model::values).unwrap_or_default();
    let snap = prefs::local_items(prefs::snapshot(&c.prefs)?, &last_values);
    let merged = join(dev, "prefs", last.as_ref(), snap, theirs.as_ref());
    let wrote = prefs::apply(&c.prefs, &model::values(&merged))?;
    write_json(&last_path, &merged)?;
    send(
        me,
        dev,
        relay,
        list,
        PREFS,
        "prefs",
        &merged,
        fetched.as_ref(),
    )?;
    Ok(wrote)
}

/// One settings sync, preferences first. Returns the files written here.
/// The bundles on the relay are checked against `opened`, and the merged ones sealed to `list`.
fn sync_settings(
    c: &Ctx,
    me: &Me,
    dev: &Device,
    relay: &Relay,
    opened: &DeviceList,
    list: &DeviceList,
) -> Result<Vec<PathBuf>, String> {
    let theirs = fetch(me, relay, opened, SETTINGS, "settings")?;
    let last_path = c.dir.join("settings.last.json");
    let last: Option<Bundle> = read_json(&last_path)?;
    let mut wrote = sync_prefs(
        c,
        me,
        dev,
        relay,
        opened,
        list,
        theirs.as_ref().map(|(_, b)| b),
    )?;
    let ((merged, files), notes) = crate::theme::locked_then_refresh(|| {
        let mut snap = settings::snapshot(&c.paths)?;
        // `prefs:` items from before preferences had their own bundle are passed back as they were, so a build from
        // then still finds them and nothing here deletes them.
        if let Some(b) = &last {
            snap.extend(
                model::values(b)
                    .into_iter()
                    .filter(|(id, _)| id.starts_with("prefs:")),
            );
        }
        let merged = join(
            dev,
            "settings",
            last.as_ref(),
            snap,
            theirs.as_ref().map(|(_, b)| b),
        );
        let files = settings::apply(&c.paths, &model::values(&merged))?;
        let theme = files.iter().any(|p| p.starts_with(&c.paths.config));
        Ok(((merged, files), theme))
    })?;
    wrote.extend(files);
    for n in notes {
        match (c.quiet, log_path()) {
            (true, Ok(log)) => auto::log_line(&log, &format!("theme: {n}")),
            (true, Err(_)) => {}
            (false, _) => eprintln!("theme: {n}"),
        }
    }
    write_json(&last_path, &merged)?;
    send(
        me,
        dev,
        relay,
        list,
        SETTINGS,
        "settings",
        &merged,
        theirs.as_ref(),
    )
    .map(|_| wrote)
}

/// One sync. Any that works ends a background run's wait.
fn sync_once(c: &Ctx, approver: Option<&str>) -> Result<Vec<PathBuf>, KeyError> {
    let (_, me, dev, relay) = load(c)?;
    let list = current_list(c, &dev, &relay, approver)?;
    let wrote = sync_settings(c, &me, &dev, &relay, &list, &list)?;
    let _ = fs::remove_file(c.dir.join(AUTO));
    Ok(wrote)
}

fn now(approver: Option<&str>) -> Result<(), String> {
    let c = ctx()?;
    let wrote = sync_once(&c, approver)?;
    match wrote.len() {
        0 => println!("Settings are in sync; nothing changed here."),
        n => println!("Settings are in sync; {n} file(s) changed here."),
    }
    Ok(())
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn log_path() -> Result<PathBuf, String> {
    let home = crate::home().ok_or("no home folder")?;
    Ok(auto::log_path(
        Os::current(),
        &home,
        local_app_data().as_deref(),
    ))
}

/// The 5-minute run: nothing on screen, one log line when it fails, and no try before its wait is over. It never
/// lets the Keychain ask.
fn background() -> i32 {
    let log = log_path().ok();
    let c = match ctx() {
        Ok(c) => Ctx {
            quiet: true,
            ask: Ask::Never,
            ..c
        },
        Err(e) => {
            if let Some(log) = &log {
                auto::log_line(log, &e);
            }
            return 1;
        }
    };
    background_run(&c, log.as_deref(), now_ms(), |c| sync_once(c, None))
}

/// One background turn at `t`. When the key can't be read without the Keychain asking, the turn is skipped: exit 0,
/// no failure counted, the `needs-keychain` marker kept and a note in the log at most once an hour.
fn background_run(
    c: &Ctx,
    log: Option<&Path>,
    t: u64,
    sync: impl FnOnce(&Ctx) -> Result<Vec<PathBuf>, KeyError>,
) -> i32 {
    let note = |line: &str| {
        if let Some(log) = log {
            auto::log_line(log, line);
        }
    };
    let path = c.dir.join(AUTO);
    let b: Backoff = match read_json(&path) {
        Ok(b) => b.unwrap_or_default(),
        Err(e) => {
            note(&e);
            return 1;
        }
    };
    if !b.due(t) {
        return 0;
    }
    match sync(c) {
        Ok(_) => 0,
        Err(KeyError::NeedsPrompt) => {
            let marker = c.dir.join(NEEDS_KEYCHAIN);
            // A damaged marker reads as none, so the note is logged again.
            let prev: Option<Paused> = read_json(&marker).ok().flatten();
            let (next, say) = Paused::skipped(prev, t);
            if prev != Some(next) {
                let _ = write_json(&marker, &next);
            }
            if say {
                note(auto::PAUSED_LOG);
            }
            0
        }
        Err(KeyError::Failed(e)) => {
            let next = b.failed(t);
            let _ = write_json(&path, &next);
            note(&format!("{e}; next try in {} minutes", next.wait_min(t)));
            1
        }
    }
}

fn write_only() -> bool {
    std::env::var_os("POLYCARP_SYNC_SERVICE").is_some_and(|v| v == "write")
}

fn run_all(cmds: Vec<(PathBuf, Vec<String>)>) -> Result<(), String> {
    for (prog, args) in cmds {
        let out = std::process::Command::new(&prog)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("could not run {}: {e}", prog.display()))?;
        if !out.status.success() {
            return Err(format!(
                "{} {} failed: {}",
                prog.display(),
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(())
}

fn auto_units() -> Result<(Os, Vec<PathBuf>), String> {
    let os = Os::current();
    let home = crate::home().ok_or("no home folder")?;
    Ok((os, auto::unit_paths(os, &home, local_app_data().as_deref())))
}

fn auto_on() -> Result<(), String> {
    let c = ctx()?;
    load(&c)?;
    let (os, paths) = auto_units()?;
    let exe = crate::files::service::service_exe().ok_or("can't tell where polycarp is")?;
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let log = log_path()?;
    let (_, iso) = crate::theme::stamps();
    let start = format!("{}Z", &iso[..19]);
    for (p, text) in paths
        .iter()
        .zip(auto::render(os, &exe, &log, &user, &start))
    {
        crate::files::service::write_unit(os, p, &text)?;
    }
    let shown: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
    if write_only() {
        println!(
            "Wrote {}; loaded nothing (POLYCARP_SYNC_SERVICE=write).",
            shown.join(", ")
        );
        return Ok(());
    }
    let uid = crate::files::service::uid();
    if os == Os::Mac {
        // A unit loaded before is taken out first, so this one replaces it.
        let _ = run_all(auto::unload_argv(os, uid));
    }
    // launchd can still be tearing the old job down, so a Mac tries a few times.
    let tries = if os == Os::Mac { 5 } else { 1 };
    let mut loaded = Err(String::new());
    for n in 0..tries {
        if n > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        loaded = run_all(auto::load_argv(os, uid, &paths));
        if loaded.is_ok() {
            break;
        }
    }
    if let Err(e) = loaded {
        // A unit left behind would load at the next login while `auto on` said it failed.
        for p in &paths {
            let _ = fs::remove_file(p);
        }
        return Err(format!("{e}; sync on its own is still off"));
    }
    println!(
        "This device syncs on its own every 5 minutes. Failures go to {}. Turn it off with `polycarp sync auto off`.",
        log.display()
    );
    Ok(())
}

fn auto_off() -> Result<(), String> {
    let (os, paths) = auto_units()?;
    if !paths.iter().any(|p| p.exists()) {
        println!("Sync on its own is already off here.");
        return Ok(());
    }
    // A unit that is written but not loaded fails to unload; its files go all the same.
    let unloaded = if write_only() {
        Ok(())
    } else {
        run_all(auto::unload_argv(os, crate::files::service::uid()))
    };
    for p in &paths {
        match fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not remove {}: {e}", p.display())),
        }
    }
    if let (Err(e), true) = (unloaded, is_loaded(os)) {
        return Err(format!(
            "removed the unit, but it is still loaded until you log out: {e}"
        ));
    }
    println!("Sync on its own is off; `polycarp sync now` still works by hand.");
    Ok(())
}

/// Whether the unit is loaded now. Under the test hook, written counts as loaded.
fn is_loaded(os: Os) -> bool {
    if write_only() {
        return true;
    }
    let (prog, args) = auto::loaded_argv(os, crate::files::service::uid());
    std::process::Command::new(prog)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn auto_status() -> Result<(), String> {
    let (os, paths) = auto_units()?;
    if !paths.iter().all(|p| p.exists()) {
        println!("off: turn it on with `polycarp sync auto on`");
        return Ok(());
    }
    if !is_loaded(os) {
        println!("off: the unit is written but not loaded; `polycarp sync auto on` loads it");
        return Ok(());
    }
    let c = ctx()?;
    if c.dir.join(NEEDS_KEYCHAIN).exists() {
        println!("{}", auto::PAUSED_STATUS);
        return Ok(());
    }
    let b: Backoff = read_json(&c.dir.join(AUTO))?.unwrap_or_default();
    let t = now_ms();
    match b.failures {
        0 => println!("on: every 5 minutes"),
        n => println!(
            "on, but the last {n} run(s) failed; the next try is in {} minutes. See {}",
            b.wait_min(t),
            log_path()?.display()
        ),
    }
    Ok(())
}

fn devices() -> Result<(), String> {
    let c = ctx()?;
    let (_, _, dev, _) = load(&c)?;
    let list = trusted(&c)?.ok_or("this device has no device list yet")?;
    for d in &list.devices {
        let me = if d.id == dev.id {
            "  (this device)"
        } else {
            ""
        };
        println!("{}  {}  {}{me}", d.id, d.fingerprint(), d.name);
    }
    Ok(())
}

fn remove(which: &str) -> Result<(), String> {
    let c = ctx()?;
    let (st, me, dev, relay) = load(&c)?;
    let list = current_list(&c, &dev, &relay, None)?;
    let gone: Vec<&Device> = list
        .devices
        .iter()
        .filter(|d| d.id == which || d.name == which)
        .collect();
    let [gone] = gone[..] else {
        return Err(format!(
            "{which} names {} devices; use its id from `polycarp sync devices`",
            gone.len()
        ));
    };
    if gone.id == dev.id {
        return Err("a device can't remove itself; run this on another device".into());
    }
    let name = gone.name.clone();
    let devices = list
        .devices
        .iter()
        .filter(|d| d.id != gone.id)
        .cloned()
        .collect();
    let next = DeviceList::signed(&me, &st.name, list.version + 1, devices);
    publish(&c, &me, &dev, &relay, &list, next)?;
    println!("{name} is removed. Bundles from now on are sealed without it. Also take away its SSH access to the relay.");
    Ok(())
}

/// `init`'s options: `--relay ADDR` and `--name NAME` once each at most, and `--auto`.
fn init_args<'a>(rest: &[&'a str]) -> Option<Vec<(&'a str, &'a str)>> {
    let mut pairs = Vec::new();
    let mut it = rest.iter().filter(|a| **a != "--auto");
    while let Some(k) = it.next() {
        let v = it.next()?;
        if !["--relay", "--name"].contains(k) || pairs.iter().any(|(p, _)| p == k) {
            return None;
        }
        pairs.push((*k, *v));
    }
    (rest.iter().filter(|a| **a == "--auto").count() <= 1).then_some(pairs)
}

pub fn run(args: &[OsString]) -> i32 {
    let args: Vec<String> = match args.iter().map(|a| a.clone().into_string()).collect() {
        Ok(a) => a,
        Err(_) => {
            eprintln!("polycarp sync: arguments must be text");
            return 2;
        }
    };
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match a.as_slice() {
        [] | ["help" | "--help" | "-h"] => {
            println!("{USAGE}");
            return 0;
        }
        ["init", rest @ ..] if init_args(rest).is_some() => {
            let pairs = init_args(rest).unwrap_or_default();
            let get = |k: &str| pairs.iter().find(|(p, _)| *p == k).map(|(_, v)| *v);
            init(get("--relay"), get("--name"))
        }
        .and_then(|()| {
            if rest.contains(&"--auto") {
                auto_on()
            } else {
                Ok(())
            }
        }),
        ["approve", code] => approve(code, None),
        ["approve", code, "--fingerprint", fp] => approve(code, Some(fp)),
        ["now"] => now(None),
        ["now", "--approver", fp] => now(Some(fp)),
        ["now", "--background"] => return background(),
        ["auto", "on"] => auto_on(),
        ["auto", "off"] => auto_off(),
        ["auto", "status"] => auto_status(),
        ["devices"] => devices(),
        ["remove", which] => remove(which),
        _ => {
            eprintln!("{USAGE}");
            return 2;
        }
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("polycarp sync: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("polycarp-sync-bg-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("sync")).unwrap();
        d
    }

    fn test_ctx(root: &Path) -> Ctx {
        let dir = root.join("sync");
        Ctx {
            prefs: prefs::Store::File(dir.join("prefs.json")),
            dir,
            paths: Paths {
                config: root.join("config"),
                support: root.join("support"),
            },
            quiet: true,
            ask: Ask::Never,
        }
    }

    fn log_lines(log: &Path) -> usize {
        fs::read_to_string(log).map_or(0, |s| s.lines().count())
    }

    fn marker(c: &Ctx) -> Option<Paused> {
        read_json(&c.dir.join(NEEDS_KEYCHAIN)).unwrap()
    }

    fn backoff(c: &Ctx) -> Option<Backoff> {
        read_json(&c.dir.join(AUTO)).unwrap()
    }

    fn needs_prompt(_: &Ctx) -> Result<Vec<PathBuf>, KeyError> {
        Err(KeyError::NeedsPrompt)
    }

    #[test]
    fn a_keychain_that_would_ask_skips_the_round_quietly() {
        let root = tmp("skip");
        let c = test_ctx(&root);
        let log = root.join("sync.log");
        let t = 10_000 * MIN;

        // First skip: exit 0, one fixed note, a marker, no failure counted.
        assert_eq!(background_run(&c, Some(&log), t, needs_prompt), 0);
        assert_eq!(log_lines(&log), 1);
        let text = fs::read_to_string(&log).unwrap();
        assert!(text.trim_end().ends_with(auto::PAUSED_LOG));
        assert_eq!(
            marker(&c),
            Some(Paused {
                since_ms: t,
                logged_ms: t
            })
        );
        assert_eq!(backoff(&c), None);

        // Every 5 minutes for the next hour: still exit 0, no more lines.
        for k in 1..12 {
            assert_eq!(
                background_run(&c, Some(&log), t + k * 5 * MIN, needs_prompt),
                0
            );
        }
        assert_eq!(log_lines(&log), 1);
        assert_eq!(backoff(&c), None);

        // An hour on: one more line, the pause keeps its start.
        assert_eq!(
            background_run(&c, Some(&log), t + 60 * MIN, needs_prompt),
            0
        );
        assert_eq!(log_lines(&log), 2);
        assert_eq!(
            marker(&c),
            Some(Paused {
                since_ms: t,
                logged_ms: t + 60 * MIN
            })
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_damaged_marker_reads_as_none() {
        let root = tmp("damaged");
        let c = test_ctx(&root);
        let log = root.join("sync.log");
        fs::write(c.dir.join(NEEDS_KEYCHAIN), "not json").unwrap();
        assert_eq!(background_run(&c, Some(&log), 5 * MIN, needs_prompt), 0);
        assert_eq!(log_lines(&log), 1);
        assert_eq!(
            marker(&c),
            Some(Paused {
                since_ms: 5 * MIN,
                logged_ms: 5 * MIN
            })
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn other_failures_still_wait_and_leave_no_marker() {
        let root = tmp("fail");
        let c = test_ctx(&root);
        let log = root.join("sync.log");
        let t = 100 * MIN;
        let code = background_run(&c, Some(&log), t, |_| {
            Err(KeyError::Failed("the relay did not answer".into()))
        });
        assert_eq!(code, 1);
        assert_eq!(log_lines(&log), 1);
        assert_eq!(marker(&c), None);
        assert_eq!(backoff(&c), Some(Backoff::default().failed(t)));
        // Inside that wait nothing runs, a Keychain read included.
        let code = background_run(&c, Some(&log), t + MIN, |_| -> Result<_, KeyError> {
            panic!("ran inside the wait")
        });
        assert_eq!(code, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_key_read_that_works_ends_the_pause() {
        let root = tmp("ok");
        let mut c = test_ctx(&root);
        // The key in the file store, so no test reaches a real Keychain.
        let me = Me::generate();
        fs::write(c.dir.join("identity"), me.secret().expose_secret()).unwrap();
        write_json(
            &c.dir.join(NEEDS_KEYCHAIN),
            &Paused {
                since_ms: 1,
                logged_ms: 1,
            },
        )
        .unwrap();
        for ask in [Ask::Never, Ask::Prompt] {
            c.ask = ask;
            let (got, _) = identity(&c, false).map_err(String::from).unwrap();
            assert_eq!(got.secret().expose_secret(), me.secret().expose_secret());
            assert!(!c.dir.join(NEEDS_KEYCHAIN).exists());
        }
        let _ = fs::remove_dir_all(&root);
    }
}
