//! The `polycarp sync` command. Each run reads the relay first and changes nothing here until the relay answered and
//! every bundle checked out, so an unreachable relay or a changed bundle leaves this device as it was.

use super::auto::{self, Backoff};
use super::crypto::{self, Device, DeviceList, Me, Sealed};
use super::model::{self, Bundle};
use super::prefs;
use super::relay::{self, Relay};
use super::settings::{self, Paths};
use super::store::Store;
use crate::files::config::Os;
use age::secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
polycarp sync: Polycarp's settings, the same on each of your own devices. Docs: docs/sync.md.

  polycarp sync init [--relay ADDR] [--name NAME]   set up this device (the first, or one to approve)
  polycarp sync approve CODE [--fingerprint FP]     on a device already set up: let the new one in
  polycarp sync now [--approver FP]                 sync now (FP: the approving device's, the first time)
  polycarp sync now --background                    what the 5-minute run does: quiet, waits after failures
  polycarp sync devices                             the devices that take part
  polycarp sync remove DEVICE                       drop a device; later bundles are sealed without it

ADDR is ssh:HOST, ssh:HOST:DIR or dir:/PATH (default ssh:parish1). The relay holds only ciphertext.";

const DEVICES: &str = "devices.json";
const SETTINGS: &str = "settings.age.json";
const AUTO: &str = "auto.json";

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

/// This device's key, made on first use. The note says when it had to go in a file.
fn identity(c: &Ctx, make: bool) -> Result<(Me, Option<String>), String> {
    let (store, note) = Store::open(&c.dir)?;
    if let Some(s) = store.load()? {
        return Ok((Me::from_secret(s.expose_secret())?, None));
    }
    if !make {
        return Err("this device has no sync key yet; run `polycarp sync init`".into());
    }
    let me = Me::generate();
    store.save(&me.secret())?;
    Ok((me, note))
}

fn load(c: &Ctx) -> Result<(State, Me, Device, Relay), String> {
    let st: State = read_json(&c.dir.join("state.json"))?
        .ok_or("sync is not set up here; run `polycarp sync init`")?;
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

/// One settings sync. Returns the files written here.
/// The bundle on the relay is checked against `opened`, and the merged one sealed to `list`.
fn sync_settings(
    c: &Ctx,
    me: &Me,
    dev: &Device,
    relay: &Relay,
    opened: &DeviceList,
    list: &DeviceList,
) -> Result<Vec<PathBuf>, String> {
    let theirs = match relay.get(SETTINGS)? {
        None => None,
        Some(b) => {
            let sealed: Sealed = serde_json::from_slice(&b)
                .map_err(|_| "the settings bundle on the relay was refused: it is not readable; nothing of it was applied")?;
            let plain = crypto::open(me, opened, "settings", &sealed)?;
            let bundle: Bundle = serde_json::from_slice(&plain)
                .ok()
                .filter(|b: &Bundle| b.kind == "settings")
                .ok_or("the settings bundle on the relay was refused: it is damaged; nothing of it was applied")?;
            Some((sealed, bundle))
        }
    };
    let last_path = c.dir.join("settings.last.json");
    let last: Option<Bundle> = read_json(&last_path)?;
    let ((merged, wrote), notes) = crate::theme::locked_then_refresh(|| {
        let mut snap = settings::snapshot(&c.paths)?;
        let last_values = last.as_ref().map(model::values).unwrap_or_default();
        snap.extend(prefs::or_last(prefs::snapshot(&c.prefs)?, &last_values));
        // A device's first sync joins what the others already have. Its own values are not edits made after theirs
        // (a new install's defaults would win over months of settings), so where the relay has an item, the
        // relay's stands, and this device adds only what the relay has never had.
        if let (None, Some((_, b))) = (&last, &theirs) {
            snap.retain(|id, _| !b.items.contains_key(id));
        }
        let empty = Bundle {
            kind: "settings".into(),
            ..Default::default()
        };
        let local = model::observe(last.as_ref().unwrap_or(&empty), &snap, now_ms(), &dev.id);
        let mut merged = match &theirs {
            Some((_, b)) => model::merge(&local, b),
            None => local,
        };
        model::prune(&mut merged, now_ms());
        let values = model::values(&merged);
        let mut wrote = settings::apply(&c.paths, &values)?;
        let theme = wrote.iter().any(|p| p.starts_with(&c.paths.config));
        wrote.extend(prefs::apply(&c.prefs, &values)?);
        Ok(((merged, wrote), theme))
    })?;
    for n in notes {
        match (c.quiet, log_path()) {
            (true, Ok(log)) => auto::log_line(&log, &format!("theme: {n}")),
            (true, Err(_)) => {}
            (false, _) => eprintln!("theme: {n}"),
        }
    }
    write_json(&last_path, &merged)?;
    let same = theirs
        .as_ref()
        .is_some_and(|(s, b)| *b == merged && s.list_version == list.version);
    if !same {
        let plain = serde_json::to_vec(&merged).map_err(|e| e.to_string())?;
        let sealed = crypto::seal(me, &dev.id, list, "settings", &plain)?;
        relay.put(
            SETTINGS,
            &serde_json::to_vec(&sealed).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(wrote)
}

/// One sync. Any that works ends a background run's wait.
fn sync_once(c: &Ctx, approver: Option<&str>) -> Result<Vec<PathBuf>, String> {
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

/// The 5-minute run: nothing on screen, one log line when it fails, and no try before its wait is over.
fn background() -> i32 {
    let fail = |e: String| {
        if let Ok(log) = log_path() {
            auto::log_line(&log, &e);
        }
        1
    };
    let c = match ctx() {
        Ok(c) => Ctx { quiet: true, ..c },
        Err(e) => return fail(e),
    };
    let path = c.dir.join(AUTO);
    let b: Backoff = match read_json(&path) {
        Ok(b) => b.unwrap_or_default(),
        Err(e) => return fail(e),
    };
    let t = now_ms();
    if !b.due(t) {
        return 0;
    }
    match sync_once(&c, None) {
        Ok(_) => 0,
        Err(e) => {
            let next = b.failed(t);
            let _ = write_json(&path, &next);
            fail(format!("{e}; next try in {} minutes", next.wait_min(t)))
        }
    }
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

pub fn run(args: &[OsString]) -> i32 {
    let args: Vec<String> = match args.iter().map(|a| a.clone().into_string()).collect() {
        Ok(a) => a,
        Err(_) => {
            eprintln!("polycarp sync: arguments must be text");
            return 2;
        }
    };
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let opt = |name: &str| a.windows(2).find(|w| w[0] == name).map(|w| w[1]);
    let result = match a.as_slice() {
        [] | ["help" | "--help" | "-h"] => {
            println!("{USAGE}");
            return 0;
        }
        ["init", rest @ ..]
            if rest.len() % 2 == 0
                && rest
                    .iter()
                    .step_by(2)
                    .all(|k| ["--relay", "--name"].contains(k)) =>
        {
            init(opt("--relay"), opt("--name"))
        }
        ["approve", code] => approve(code, None),
        ["approve", code, "--fingerprint", fp] => approve(code, Some(fp)),
        ["now"] => now(None),
        ["now", "--approver", fp] => now(Some(fp)),
        ["now", "--background"] => return background(),
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
