//! Polycarp Browser on Windows, step one: `polycarp browser install --dry-run` downloads Helium's newest Windows
//! release, checks its sha256 and the signature on every program in it, builds Polycarp Browser from it in a work
//! folder, starts that once with no window and a throwaway profile, and throws it all away. Nothing is installed.
//! The rules are in `../browser/AGENTS.md`.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

// One copy of the listing code serves the Mac and Windows, so a test build loads it twice on purpose. Windows does
// not read every field.
#[allow(clippy::duplicate_mod)]
#[allow(dead_code)]
#[path = "browser/listing.rs"]
mod listing;

// The download and refusal code, shared with Linux.
#[allow(clippy::duplicate_mod)]
#[path = "browser/download.rs"]
mod download;

// The text packs and their renaming, shared with the Mac, and the folder build, shared with Linux later.
#[allow(clippy::duplicate_mod)]
#[path = "browser/pak.rs"]
mod pak;
#[path = "browser/portable.rs"]
mod portable;
#[allow(clippy::duplicate_mod)]
#[path = "browser/rename.rs"]
mod rename;

use download::{fetch, is_link, print, refuse, Refused};
use listing::Release;

#[cfg(windows)]
const FEED: &str = "https://api.github.com/repos/imputnet/helium-windows/releases/latest";
const DOWNLOADS: &str = "https://github.com/imputnet/helium-windows/releases/download";
/// Helium's signer, as `X509Certificate2.Subject` spells it. The leaf certificate rotates, so the subject is
/// pinned, never a thumbprint, and it must match whole.
const SIGNER: &str = "CN=imput LLC, O=imput LLC, L=Sheridan, S=Wyoming, C=US";
/// The browser's first words, the same as the Mac's.
const VERBS: [&str; 7] = [
    "install",
    "update",
    "status",
    "open",
    "import",
    "uninstall",
    "finish",
];
const ONLY: &str = "polycarp browser: only `install --dry-run` works on Windows so far.";

/// None when these arguments are not a browser command.
pub fn run(args: &[OsString], home: Option<PathBuf>, cache: Option<PathBuf>) -> Option<i32> {
    let verb = args.first().map_or(Some("--help"), |a| a.to_str())?;
    if ["--help", "-h", "help"].contains(&verb) {
        println!("{ONLY}");
        return Some(0);
    }
    if !VERBS.contains(&verb) {
        return None;
    }
    if verb != "install" || args.len() != 2 || args[1] != "--dry-run" {
        eprintln!("{ONLY}");
        return Some(2);
    }
    let (Some(_), Some(cache)) = (home, cache) else {
        eprintln!("polycarp browser: no home folder");
        return Some(1);
    };
    let resources = std::env::var_os(portable::RESOURCES);
    #[cfg(windows)]
    let done = with_parts(resources, |parts| dry_run(&cache.join("browser"), &parts));
    #[cfg(not(windows))]
    let done = with_parts(resources, |_| {
        let why = format!("{} is not Windows", cache.display());
        Err(Refused::new("system", why))
    });
    Some(print(done))
}

/// Runs `go` only once the parts are all there, so a refusal for them comes before any download.
fn with_parts(
    resources: Option<OsString>,
    go: impl FnOnce(portable::Parts) -> Result<String, Refused>,
) -> Result<String, Refused> {
    go(portable::parts(resources)?)
}

/// Helium's name for this processor.
fn arch_name(arch: &str) -> Result<&'static str, Refused> {
    match arch {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        _ => Err(Refused::new("processor", "no Helium for this processor")),
    }
}

fn parse(json: &str, arch: &str) -> Result<Release, Refused> {
    let name = |version: &str| format!("helium_{version}_{arch}-windows.zip");
    listing::parse(json, DOWNLOADS, name).map_err(|why| Refused::new("release", why))
}

/// The unpacked folder, when the work folder holds exactly Helium's one folder with its program and manifest.
fn laid_out(work: &Path, version: &str, arch: &str) -> Result<PathBuf, Refused> {
    let bad = || Refused::new("layout", "the zip is not laid out as Helium's");
    let entries: Vec<_> = fs::read_dir(work).map_err(|_| bad())?.collect();
    let top = format!("helium_{version}_{arch}-windows");
    let [Ok(entry)] = entries.as_slice() else {
        return Err(bad());
    };
    let plain = |p: &Path, dir: bool| {
        fs::symlink_metadata(p)
            .is_ok_and(|m| !is_link(&m) && if dir { m.is_dir() } else { m.is_file() })
    };
    let folder = entry.path();
    let ok = entry.file_name() == top.as_str()
        && plain(&folder, true)
        && plain(&folder.join("chrome.exe"), false)
        && plain(&folder.join(format!("{version}.manifest")), false);
    if !ok {
        return Err(bad());
    }
    Ok(folder)
}

/// Every `.exe` and `.dll` under `root`, walked without following anything; a link anywhere is a refusal.
fn programs(root: &Path) -> Result<Vec<PathBuf>, Refused> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let entries = fs::read_dir(&folder).map_err(refuse("signature", "reading the release"))?;
        for entry in entries {
            let path = entry
                .map_err(refuse("signature", "reading the release"))?
                .path();
            let meta =
                fs::symlink_metadata(&path).map_err(refuse("signature", "reading the release"))?;
            if is_link(&meta) {
                let why = format!("{} is a link", relative(root, &path));
                return Err(Refused::new("signature", why));
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase);
            if meta.is_dir() {
                folders.push(path);
            } else if matches!(ext.as_deref(), Some("exe" | "dll")) {
                found.push(path);
            }
        }
    }
    Ok(found)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// A path inside the release as both sides spell it: Windows ignores case, and either slash may separate.
fn key(rel: &str) -> String {
    rel.replace('\\', "/").to_lowercase()
}

/// PowerShell's answer, one `<Status>\t<Subject>\t<path inside the release>` line per program, judged against the
/// programs Rust found. Paths are compared inside the release, because the two sides can spell the folder itself
/// differently (a short 8.3 name against the long one). The number of programs when every one is there, `Valid` and
/// signed by imput LLC.
fn judge(said: &str, root: &Path, walked: &[PathBuf]) -> Result<usize, Refused> {
    let walked_keys: Vec<String> = walked.iter().map(|p| key(&relative(root, p))).collect();
    let chrome = key("chrome.exe");
    if !walked_keys.contains(&chrome) {
        return Err(Refused::new(
            "signature",
            "chrome.exe was not among the programs",
        ));
    }
    let mut seen = Vec::new();
    for line in said.lines().filter(|l| !l.trim().is_empty()) {
        let fields: Vec<&str> = line.trim_end_matches('\r').splitn(3, '\t').collect();
        let [status, subject, path] = fields[..] else {
            return Err(Refused::new(
                "signature",
                "PowerShell's answer was not understood",
            ));
        };
        let name = path.replace('\\', "/");
        if !walked_keys.contains(&key(path)) || seen.contains(&key(path)) {
            let why = format!("{name} was checked but is not one of the programs found");
            return Err(Refused::new("signature", why));
        }
        if status != "Valid" {
            return Err(Refused::new(
                "signature",
                format!("{name}: its signature is {status}"),
            ));
        }
        if subject != SIGNER {
            let why = format!("{name}: it is signed by someone else");
            return Err(Refused::new("signature", why));
        }
        seen.push(key(path));
    }
    if let Some(missed) = walked
        .iter()
        .find(|p| !seen.contains(&key(&relative(root, p))))
    {
        let why = format!("{}: a program was not checked", relative(root, missed));
        return Err(Refused::new("signature", why));
    }
    Ok(seen.len())
}

/// Zips of other Windows releases, and halves of them.
fn others(name: &str) -> bool {
    name.starts_with("helium_") && name.contains(".zip")
}

#[cfg(windows)]
mod system {
    use super::*;
    use std::process::{Command, Stdio};

    /// Lists each program's own signature. The folder arrives in an environment variable, never in the script's text.
    ///
    /// `Get-AuthenticodeSignature` is not used: it asks Windows' catalogs first, and a Microsoft DLL that Helium
    /// signed again (`d3dcompiler_47.dll`) has its hash in them, so it reported Microsoft's catalog signer instead
    /// of imput's. `WinVerifyTrust` with a file and no catalog checks the signature inside the file, revocation off
    /// and no download, and the signer is that signature's certificate.
    const SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PolycarpTrust {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FileInfo { public uint cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }
  [StructLayout(LayoutKind.Sequential)]
  struct Data {
    public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData; public uint dwUIChoice;
    public uint fdwRevocationChecks; public uint dwUnionChoice; public IntPtr pFile; public uint dwStateAction;
    public IntPtr hWVTStateData; public IntPtr pwszURLReference; public uint dwProvFlags; public uint dwUIContext;
    public IntPtr pSignatureSettings;
  }
  [DllImport("wintrust.dll")]
  static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref Data data);
  public static int Check(string path) {
    FileInfo file = new FileInfo();
    file.cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo));
    file.pcwszFilePath = path;
    IntPtr pfile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
    try {
      Marshal.StructureToPtr(file, pfile, false);
      Data d = new Data();
      d.cbStruct = (uint)Marshal.SizeOf(typeof(Data));
      d.dwUIChoice = 2; d.fdwRevocationChecks = 0; d.dwUnionChoice = 1; d.pFile = pfile;
      d.dwStateAction = 1; d.dwProvFlags = 0x1000;
      Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
      int r = WinVerifyTrust(IntPtr.Zero, ref action, ref d);
      d.dwStateAction = 2;
      WinVerifyTrust(IntPtr.Zero, ref action, ref d);
      return r;
    } finally {
      Marshal.DestroyStructure(pfile, typeof(FileInfo));
      Marshal.FreeHGlobal(pfile);
    }
  }
}
'@
$root = (Get-Item -LiteralPath $env:POLYCARP_HELIUM_DIR).FullName.TrimEnd('\')
Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object {
  $full = $_.FullName
  if (-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw "outside the release: $full" }
  $r = [PolycarpTrust]::Check($full)
  $status = switch ($r) { 0 { 'Valid' } -2146869232 { 'HashMismatch' } -2146762496 { 'NotSigned' } default { '0x{0:X8}' -f $r } }
  $who = ''
  try {
    $c = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($full)
    $who = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $c).Subject
  } catch { }
  "{0}`t{1}`t{2}" -f $status, $who, $full.Substring($root.Length + 1)
}"#;

    fn system32(program: &str) -> PathBuf {
        let root = std::env::var_os("SystemRoot").filter(|v| !v.is_empty());
        let root = root.map_or(PathBuf::from(r"C:\Windows"), PathBuf::from);
        root.join("System32").join(program)
    }

    /// Runs a program by its absolute path, which must succeed; its output.
    fn must(check: &'static str, command: Command) -> Result<String, Refused> {
        must_fed(check, command, None)
    }

    /// Runs a program, which must succeed, with `input` as all it reads, or nothing; its output.
    fn must_fed(
        check: &'static str,
        mut command: Command,
        input: Option<String>,
    ) -> Result<String, Refused> {
        let program = PathBuf::from(command.get_program());
        if !program.is_file() {
            let why = format!("{} is missing", program.display());
            return Err(Refused::new(check, why));
        }
        let cannot = |e: std::io::Error| {
            Refused::new(check, format!("{} could not run: {e}", program.display()))
        };
        // The token reaches only curl, and only on its input: no program run here has it in its environment.
        command.env_remove(download::TOKEN);
        let ran = download::run_fed(&mut command, input).map_err(cannot)?;
        if !ran.status.success() {
            let said = String::from_utf8_lossy(&ran.stderr);
            let last = said.lines().map(str::trim).rfind(|l| !l.is_empty());
            let why = last.map_or(format!("exit {:?}", ran.status.code()), str::to_string);
            return Err(Refused::new(check, why));
        }
        Ok(String::from_utf8_lossy(&ran.stdout).into_owned())
    }

    /// `curl`, https only, without the person's own curl settings, as on the Mac.
    fn curl(check: &'static str, limit: u64, more: &[&std::ffi::OsStr]) -> Result<String, Refused> {
        curl_fed(check, limit, more, None)
    }

    fn curl_fed(
        check: &'static str,
        limit: u64,
        more: &[&std::ffi::OsStr],
        input: Option<String>,
    ) -> Result<String, Refused> {
        let mut command = Command::new(system32("curl.exe"));
        // The token reaches curl only on its input, never in its environment.
        command.env_remove(download::TOKEN);
        let options =
            "-q --fail --silent --show-error --location --proto =https --proto-redir =https \
                       --tlsv1.2 --retry 2 --connect-timeout 20 --user-agent polycarp-browser \
                       --max-filesize 734003200 --max-time";
        command
            .args(options.split_whitespace())
            .arg(limit.to_string())
            .args(more);
        must_fed(check, command, input)
    }

    fn newest(arch: &str) -> Result<Release, Refused> {
        let header = download::feed_token();
        let args = download::feed_args(FEED, header.is_some());
        let more: Vec<&std::ffi::OsStr> = args.iter().map(std::ffi::OsStr::new).collect();
        let said = curl_fed("release", 60, &more, header)?;
        parse(&said, arch)
    }

    /// Unpacks the zip into `work` with the system's bsdtar, which refuses absolute and `..` paths.
    pub fn unpack(
        zip: &Path,
        work: &Path,
        release: &Release,
        arch: &str,
    ) -> Result<PathBuf, Refused> {
        let mut tar = Command::new(system32("tar.exe"));
        tar.arg("-xf").arg(zip).arg("-C").arg(work);
        must("unpack", tar)?;
        laid_out(work, &release.version, arch)
    }

    /// The number of programs in `folder`, when every one carries a valid signature from imput LLC.
    pub fn signatures(folder: &Path) -> Result<usize, Refused> {
        let walked = programs(folder)?;
        let mut ps = Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe"));
        ps.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
        ps.env("POLYCARP_HELIUM_DIR", folder);
        let said = must("signature", ps)?;
        judge(&said, folder, &walked)
    }

    pub fn download(dir: &Path) -> Result<(Release, &'static str, PathBuf), Refused> {
        let arch = arch_name(std::env::consts::ARCH)?;
        fs::create_dir_all(dir).map_err(refuse("download", "making the cache folder"))?;
        let release = newest(arch)?;
        let get = |part: &Path| {
            let more = [
                "--output".as_ref(),
                part.as_os_str(),
                "--".as_ref(),
                release.url.as_ref(),
            ];
            curl("download", 1800, &more).map(drop)
        };
        let zip = fetch(&release, dir, &get, &others)?;
        Ok((release, arch, zip))
    }

    /// Downloads and checks the newest release in `dir`, hands the checked folder and the work folder to `then`, and
    /// throws the work folder away whatever happened. The version and the number of programs checked.
    pub fn checked(
        dir: &Path,
        then: impl FnOnce(&Path, &Path) -> Result<(), Refused>,
    ) -> Result<(String, usize), Refused> {
        let (release, arch, zip) = download(dir)?;
        let work = dir.join("work");
        if fs::symlink_metadata(&work).is_ok() {
            fs::remove_dir_all(&work).map_err(refuse("work folder", "clearing it"))?;
        }
        fs::create_dir(&work).map_err(refuse("work folder", "making it"))?;
        let done = unpack(&zip, &work, &release, arch).and_then(|folder| {
            let n = signatures(&folder)?;
            then(&folder, &work).map(|()| n)
        });
        stop_inside(&work.join("build"));
        // A browser that just quit can hold its files a moment longer.
        for _ in 0..10 {
            if fs::remove_dir_all(&work).is_ok() || !work.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        let n = done?;
        if work.exists() {
            return Err(Refused::new("work folder", "it could not be deleted"));
        }
        Ok((release.version, n))
    }

    /// Builds Polycarp Browser from the checked release and starts it once, all inside the work folder, which then
    /// goes.
    pub fn dry_run(dir: &Path, parts: &portable::Parts) -> Result<String, Refused> {
        let (version, n) = checked(dir, |folder, work| started(folder, work, parts))?;
        Ok(format!(
            "Helium {version} was downloaded and passed its checks: the sha256 GitHub lists, and imput LLC's \
             signature on all {n} programs in it. Polycarp Browser was built from it and started once without a \
             window, showing its own new tab. Nothing was installed."
        ))
    }

    /// Builds in `work\build` and starts that once with its home in `work\home`.
    pub fn started(folder: &Path, work: &Path, parts: &portable::Parts) -> Result<(), Refused> {
        // Local Studio is left out of the build that is started: its extension could reach the person's own helper,
        // which Chromium finds through the registry, not through any folder this start moves.
        let parts = portable::Parts {
            local_studio: work.join("no-local-studio"),
            ..parts.clone()
        };
        let launcher = portable::build(folder, &work.join("build"), &parts)?;
        let home = work.join("home");
        let start = portable::start(&launcher, &home);
        portable::make_home(&start, &home)?;
        let (out, err) = run_for(&start, std::time::Duration::from_secs(180))?;
        portable::judge(&out, &err)
    }

    /// Reads a pipe to its end on a thread of its own.
    fn drain<R: std::io::Read + Send + 'static>(
        pipe: Option<R>,
    ) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut text);
            }
            String::from_utf8_lossy(&text).into_owned()
        })
    }

    /// Runs the start, killed when it takes longer than `limit`; what it wrote to stdout and stderr.
    fn run_for(
        start: &portable::Start,
        limit: std::time::Duration,
    ) -> Result<(String, String), Refused> {
        let mut command = Command::new(&start.program);
        command.args(&start.args).envs(start.env.iter().cloned());
        for name in start.unset {
            command.env_remove(name);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(refuse("start", "running it"))?;
        let out = drain(child.stdout.take());
        let err = drain(child.stderr.take());
        let began = std::time::Instant::now();
        while child
            .try_wait()
            .map_err(refuse("start", "waiting for it"))?
            .is_none()
        {
            if began.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // Its own helpers may hold the pipes open; they are this build's, so they are stopped.
        stop_inside(start.program.parent().unwrap_or(&start.program));
        Ok((
            out.join().unwrap_or_default(),
            err.join().unwrap_or_default(),
        ))
    }

    /// Stops every process whose program is inside `folder`, best effort. The folder arrives in an environment
    /// variable, never in the script's text.
    fn stop_inside(folder: &Path) {
        // Its long name, as a process's path gives it: TEMP on a runner is an 8.3 name such as RUNNER~1.
        let long = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
        let text = long.to_string_lossy();
        let folder = Path::new(text.strip_prefix(r"\\?\").unwrap_or(&text));
        let script = "$b = $env:POLYCARP_BUILD_DIR.TrimEnd('\\') + '\\'; Get-Process | Where-Object { $_.Path -and \
                      $_.Path.StartsWith($b, [System.StringComparison]::OrdinalIgnoreCase) } | \
                      Stop-Process -Force -ErrorAction SilentlyContinue";
        let mut ps = Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe"));
        ps.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        ps.env("POLYCARP_BUILD_DIR", folder);
        let _ = ps
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(windows)]
use system::dry_run;

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const VERSION: &str = "0.22.5.1";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polycarp-bw-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A trimmed copy of the real listing, with made-up digests.
    fn feed(digest: &str) -> String {
        let asset = |end: &str| {
            let name = format!("helium_{VERSION}_{end}");
            let url = format!("{DOWNLOADS}/{VERSION}/{name}");
            format!("{{\"name\":\"{name}\",\"browser_download_url\":\"{url}\",\"digest\":\"sha256:{digest}\"}}")
        };
        let ends = [
            "arm64-installer.exe",
            "arm64-windows.zip",
            "x64-installer.exe",
            "x64-windows.zip",
        ];
        let assets = ends.map(asset).join(",");
        format!("{{\"tag_name\":\"{VERSION}\",\"draft\":false,\"prerelease\":false,\"assets\":[{assets}]}}")
    }

    #[test]
    fn the_newest_windows_zip_for_each_processor() {
        for arch in ["x64", "arm64"] {
            let r = parse(&feed(&"AB".repeat(32)), arch).unwrap();
            assert_eq!(r.name, format!("helium_{VERSION}_{arch}-windows.zip"));
            let at = "https://github.com/imputnet/helium-windows/releases/download/0.22.5.1/";
            assert_eq!(r.url, format!("{at}{}", r.name));
            assert_eq!(r.sha256, "ab".repeat(32));
        }
        assert_eq!(arch_name("x86_64"), Ok("x64"));
        assert_eq!(arch_name("aarch64"), Ok("arm64"));
        let e = arch_name("riscv64").unwrap_err();
        assert!(e.why.contains("no Helium for this processor"));
    }

    #[test]
    fn a_windows_listing_that_is_off_is_refused() {
        let no_zip = "has no helium_0.22.5.1_x64-windows.zip";
        for (from, to, why) in [
            ("{\"tag_name\"", "not json", "not a release"),
            ("\"draft\":false", "\"draft\":true", "full release"),
            (
                "\"prerelease\":false",
                "\"prerelease\":true",
                "full release",
            ),
            ("\"0.22.5.1\"", "\"../../x\"", "version number"),
            ("-windows.zip", "-mini-installer.exe", no_zip),
            (
                "github.com/imputnet",
                "example.com/imputnet",
                "another address",
            ),
            (
                "helium-windows/releases",
                "helium-macos/releases",
                "another address",
            ),
            ("https://", "http://", "another address"),
            ("sha256:ab", "sha256:zz", "no sha256"),
            ("\"sha256:", "\"md5:", "no sha256"),
            ("\"digest\":", "\"was\":", "no sha256"),
        ] {
            let e = parse(&feed(&"ab".repeat(32)).replace(from, to), "x64").unwrap_err();
            assert_eq!(e.check, "release");
            assert!(e.why.contains(why), "{from}: {} should say {why}", e.why);
        }
    }

    #[test]
    fn a_download_is_kept_only_while_its_digest_matches() {
        let dir = temp("fetch");
        fs::write(dir.join("helium_0.1.0.0_x64-windows.zip"), "old").unwrap();
        fs::write(dir.join("helium_0.1.0.0_x64-windows.zip.part"), "half").unwrap();
        let body = "a made-up zip";
        let sha = Sha256::digest(body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut release = parse(&feed(&sha), "x64").unwrap();
        let count = std::cell::Cell::new(0);
        let get = |part: &Path| {
            count.set(count.get() + 1);
            fs::write(part, body).map_err(refuse("download", "writing"))
        };
        let zip = fetch(&release, &dir, &get, &others).unwrap();
        fetch(&release, &dir, &get, &others).unwrap();
        assert_eq!(count.get(), 1, "a good cached zip was downloaded again");
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(left, std::slice::from_ref(&zip), "older zips are not kept");
        fs::write(&zip, "changed after it was downloaded").unwrap();
        fetch(&release, &dir, &get, &others).unwrap();
        assert_eq!(count.get(), 2);
        release.sha256 = "00".repeat(32);
        fs::remove_file(&zip).unwrap();
        assert_eq!(
            fetch(&release, &dir, &get, &others).unwrap_err().check,
            "digest"
        );
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            0,
            "a refused download was kept"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Helium's layout in small.
    fn helium(work: &Path) -> PathBuf {
        let top = work.join(format!("helium_{VERSION}_x64-windows"));
        fs::create_dir_all(top.join("locales")).unwrap();
        for f in [
            "chrome.exe",
            "0.22.5.1.manifest",
            "chrome.DLL",
            "chrome.exe.p7",
            "locales/helper.exe",
        ] {
            fs::write(top.join(f), "x").unwrap();
        }
        top
    }

    #[test]
    fn only_helium_s_own_layout_is_unpacked() {
        let work = temp("layout");
        let top = helium(&work);
        let check = |version: &str, arch: &str| laid_out(&work, version, arch).map_err(|e| e.why);
        let bad = Err("the zip is not laid out as Helium's".to_string());
        assert_eq!(check(VERSION, "x64"), Ok(top.clone()));
        assert_eq!(check("0.22.5.2", "x64"), bad, "another version");
        assert_eq!(check(VERSION, "arm64"), bad, "another processor");
        fs::write(work.join("extra"), "x").unwrap();
        assert_eq!(check(VERSION, "x64"), bad, "two entries");
        fs::remove_file(work.join("extra")).unwrap();
        for f in ["chrome.exe", "0.22.5.1.manifest"] {
            fs::rename(top.join(f), work.join(f)).unwrap();
            let e = check(VERSION, "x64");
            fs::rename(work.join(f), top.join(f)).unwrap();
            assert_eq!(e, bad, "without {f}");
        }
        #[cfg(unix)]
        {
            let real = temp("layout-real");
            fs::rename(&top, real.join("x")).unwrap();
            std::os::unix::fs::symlink(real.join("x"), &top).unwrap();
            assert_eq!(check(VERSION, "x64"), bad, "a link in its place");
            fs::remove_dir_all(&real).unwrap();
        }
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn every_program_is_found_and_a_link_is_refused() {
        let work = temp("walk");
        let top = helium(&work);
        let mut found = programs(&top).unwrap();
        found.sort();
        let want = ["chrome.DLL", "chrome.exe", "locales/helper.exe"].map(|f| top.join(f));
        assert_eq!(found, want);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/usr", top.join("locales").join("usr")).unwrap();
            assert!(programs(&top).unwrap_err().why.contains("is a link"));
        }
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn every_program_must_be_valid_and_signed_by_imput() {
        let root = Path::new("/w/helium_0.22.5.1_x64-windows");
        let files = ["chrome.exe", "chrome.dll", "locales/helper.exe"];
        let walked: Vec<PathBuf> = files.iter().map(|f| root.join(f)).collect();
        let good: Vec<_> = files.iter().map(|f| ("Valid", SIGNER, *f)).collect();
        let judged = |lines: &[(&str, &str, &str)]| {
            let line = |(s, who, f): &(&str, &str, &str)| {
                format!("{s}\t{who}\t{}\r\n", f.replace('/', "\\"))
            };
            judge(&lines.iter().map(line).collect::<String>(), root, &walked).map_err(|e| e.why)
        };
        assert_eq!(judged(&good), Ok(3));
        let mut upper = good.clone();
        upper[0].2 = "CHROME.EXE";
        assert_eq!(judged(&upper), Ok(3), "Windows paths ignore case");
        let one = |status: &str, who: &str| {
            let mut lines = good.clone();
            lines[1] = (status, who, "chrome.dll");
            judged(&lines).unwrap_err()
        };
        assert_eq!(
            one("HashMismatch", SIGNER),
            "chrome.dll: its signature is HashMismatch"
        );
        assert_eq!(
            one("NotSigned", ""),
            "chrome.dll: its signature is NotSigned"
        );
        let other = "chrome.dll: it is signed by someone else";
        assert_eq!(one("Valid", "CN=Someone Else, O=Someone Else"), other);
        assert_eq!(one("Valid", "CN=imput LLC evil, O=imput LLC"), other);
        assert_eq!(
            one("Valid", &SIGNER.replace("O=imput LLC", "O=imput LLC evil")),
            other
        );
        let e = judged(&good[..2]).unwrap_err();
        assert_eq!(e, "locales/helper.exe: a program was not checked");
        let planted = [&good[..], &[("Valid", SIGNER, "planted.exe")]].concat();
        assert!(judged(&planted)
            .unwrap_err()
            .starts_with("planted.exe was checked but"));
        let twice = [&good[..], &good[..1]].concat();
        assert!(judged(&twice).is_err(), "one file twice");
        assert!(judged(&[]).unwrap_err().contains("not checked"));
        let garbled = judge("garbled", root, &walked).unwrap_err();
        assert!(garbled.why.contains("not understood"));
        assert!(judge("", root, &[]).unwrap_err().why.contains("chrome.exe"));
    }

    #[test]
    fn only_install_dry_run_is_answered() {
        #[cfg(target_os = "macos")]
        assert_eq!(VERBS, crate::browser::VERBS);
        let run_ = |a: &[&str], home: Option<PathBuf>| {
            run(
                &a.iter().map(OsString::from).collect::<Vec<_>>(),
                home.clone(),
                home,
            )
        };
        let home = Some(PathBuf::from("/nowhere"));
        assert_eq!(run_(&["serve"], home.clone()), None);
        for asked in [
            &["install"][..],
            &["update"],
            &["install", "--dry-run", "--yes"],
            &["status"],
        ] {
            assert_eq!(run_(asked, home.clone()), Some(2), "{asked:?}");
        }
        assert_eq!(run_(&["install", "--dry-run"], None), Some(1));
    }

    #[test]
    fn parts_are_checked_before_anything_is_downloaded() {
        let dir = temp("seam");
        for resources in [
            None,
            Some("parts".into()),
            Some(dir.clone().into_os_string()),
        ] {
            let e = with_parts(resources, |_| panic!("it went on without its parts")).unwrap_err();
            assert_eq!(e.check, "parts");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The real release, downloaded into a temp cache: it passes, is built from the parts CI made and starts once with
    /// no window showing Polycarp's new tab, and one changed byte in chrome.exe is refused.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_real_release_passes_and_a_changed_program_is_refused() {
        let cache = temp("live");
        let dir = cache.join("browser");
        let parts = portable::parts(std::env::var_os(portable::RESOURCES)).unwrap();
        let (_, n) = system::checked(&dir, |folder, work| {
            system::started(folder, work, &parts)?;
            let build = work.join("build");
            assert!(build.join("Polycarp Browser.exe").is_file());
            assert!(!build.join("helium_update_helper.exe").exists());
            assert_eq!(
                fs::read_to_string(build.join("initial_preferences")).unwrap(),
                portable::PREFS
            );
            let english = fs::read(build.join("locales/en-US.pak")).unwrap();
            assert!(english.windows(16).any(|w| w == b"Polycarp Browser"));
            assert!(build.join("polycarp/extension/builtin.txt").is_file());
            Ok(())
        })
        .unwrap();
        assert!(n >= 16, "{n} programs");
        assert!(!dir.join("work").exists(), "the work folder was kept");
        let (release, arch, zip) = system::download(&dir).unwrap();
        let (work, changed) = (cache.join("work"), cache.join("changed"));
        fs::create_dir(&work).unwrap();
        fs::create_dir(&changed).unwrap();
        let folder = system::unpack(&zip, &work, &release, arch).unwrap();
        let mut bytes = fs::read(folder.join("chrome.exe")).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        fs::write(changed.join("chrome.exe"), bytes).unwrap();
        let why = system::signatures(&changed).unwrap_err().why;
        assert!(
            why.starts_with("chrome.exe: its signature is ") && !why.ends_with(" Valid"),
            "{why}"
        );
        fs::remove_dir_all(&cache).unwrap();
    }
}
