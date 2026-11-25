//! A headless Chromium with a throwaway profile and a virtual passkey, driven over a pipe. No debugging port is
//! opened, and no browser a person uses is started.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub struct Chrome {
    _child: Child,
    to: ChildStdin,
    from: BufReader<ChildStdout>,
    next: u64,
    profile: PathBuf,
    /// Everything the browser said, to look for things it should not have.
    pub session: String,
}

/// A browser made for tests: one named by the environment, Playwright's headless shell, or, on a CI machine only, the
/// installed Chrome.
fn find() -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("POLYCARP_SYNC_CHROMIUM") {
        return Some(named.into());
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let mut found = Vec::new();
    for cache in ["Library/Caches/ms-playwright", ".cache/ms-playwright"] {
        for dir in std::fs::read_dir(home.join(cache))
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = dir.file_name().to_string_lossy().into_owned();
            let Some(number) = name
                .strip_prefix("chromium_headless_shell-")
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            for inside in std::fs::read_dir(dir.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                for file in ["chrome-headless-shell", "headless_shell"] {
                    let file = inside.path().join(file);
                    if file.is_file() {
                        found.push((number, file));
                    }
                }
            }
        }
    }
    if let Some((_, newest)) = found.into_iter().max() {
        return Some(newest);
    }
    std::env::var_os("GITHUB_ACTIONS")?;
    let installed = [
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    installed.iter().map(PathBuf::from).find(|p| p.is_file())
}

impl Chrome {
    /// None where there is no browser for tests; on CI that is a failure.
    pub async fn start() -> Option<Chrome> {
        let Some(program) = find() else {
            assert!(
                std::env::var_os("GITHUB_ACTIONS").is_none(),
                "CI has no Chromium for this test"
            );
            eprintln!("skipped: no Chromium for tests (set POLYCARP_SYNC_CHROMIUM)");
            return None;
        };
        let name = polycarp_sync::seal::random::<8>()
            .map(|b| format!("{b:02x}"))
            .concat();
        let profile = std::env::temp_dir().join(format!("polycarp-sync-chromium-{name}"));
        std::fs::create_dir(&profile).unwrap();
        // Chromium reads commands on descriptor 3 and answers on 4.
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                r#"exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null 2>&1"#,
            ])
            .arg(program)
            .args([
                "--headless=new",
                "--remote-debugging-pipe",
                "--no-first-run",
                "--no-default-browser-check",
            ])
            .args([
                "--use-mock-keychain",
                "--password-store=basic",
                "--disable-gpu",
                "--no-sandbox",
            ])
            .args([
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
            ])
            .args(["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (to, from) = (
            child.stdin.take().unwrap(),
            BufReader::new(child.stdout.take().unwrap()),
        );
        let mut chrome = Chrome {
            _child: child,
            to,
            from,
            next: 0,
            profile,
            session: String::new(),
        };
        let target = chrome
            .call("Target.createTarget", json!({ "url": "about:blank" }))
            .await;
        let attach = json!({ "targetId": target["targetId"], "flatten": true });
        let session = chrome.call("Target.attachToTarget", attach).await;
        chrome.session = session["sessionId"].as_str().unwrap().to_string();
        chrome
            .call("WebAuthn.enable", json!({ "enableUI": false }))
            .await;
        Some(chrome)
    }

    /// A passkey that answers by itself, with or without PRF.
    pub async fn passkey(&mut self, prf: bool) -> String {
        let options = json!({
            "protocol": "ctap2", "ctap2Version": "ctap2_1", "transport": "usb", "hasResidentKey": true,
            "hasUserVerification": true, "isUserVerified": true, "automaticPresenceSimulation": true, "hasPrf": prf,
        });
        let made = self
            .call(
                "WebAuthn.addVirtualAuthenticator",
                json!({ "options": options }),
            )
            .await;
        made["authenticatorId"].as_str().unwrap().to_string()
    }

    pub async fn verified(&mut self, authenticator: &str, is: bool) {
        let set = json!({ "authenticatorId": authenticator, "isUserVerified": is });
        self.call("WebAuthn.setUserVerified", set).await;
    }

    pub async fn forget(&mut self, authenticator: &str) {
        self.call(
            "WebAuthn.removeVirtualAuthenticator",
            json!({ "authenticatorId": authenticator }),
        )
        .await;
    }

    pub async fn visit(&mut self, url: &str) {
        self.call("Page.navigate", json!({ "url": url })).await;
        self.until("document.readyState === 'complete' && !!document.getElementById('go')")
            .await;
    }

    pub async fn click(&mut self, id: &str) {
        self.run(&format!("document.getElementById('{id}').click()"))
            .await;
    }

    /// What the page ends up saying.
    pub async fn said(&mut self) -> String {
        self.until("document.getElementById('said').textContent !== ''")
            .await;
        self.run("document.getElementById('said').textContent")
            .await
            .as_str()
            .unwrap()
            .to_string()
    }

    pub async fn run(&mut self, script: &str) -> Value {
        let ask = json!({ "expression": script, "userGesture": true, "returnByValue": true, "awaitPromise": true });
        self.call("Runtime.evaluate", ask).await["result"]["value"].clone()
    }

    async fn until(&mut self, script: &str) {
        for _ in 0..200 {
            if self.run(script).await == json!(true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let text = self.run("document.body.innerText").await;
        panic!("never: {script}; the page says {text}");
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let mut ask = json!({ "id": id, "method": method, "params": params });
        if !self.session.is_empty() {
            ask["sessionId"] = json!(self.session);
        }
        self.to
            .write_all(format!("{ask}\0").as_bytes())
            .await
            .unwrap();
        loop {
            let mut line = Vec::new();
            let read = self.from.read_until(0, &mut line);
            let n = tokio::time::timeout(Duration::from_secs(60), read)
                .await
                .expect("Chromium hung")
                .unwrap();
            assert!(n > 0, "Chromium ended");
            let said: Value = serde_json::from_slice(&line[..n - 1]).unwrap();
            if said["id"] == json!(id) {
                assert!(said.get("error").is_none(), "{method}: {said}");
                return said["result"].clone();
            }
        }
    }
}

impl Drop for Chrome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}
