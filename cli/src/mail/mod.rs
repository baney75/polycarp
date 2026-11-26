//! Polycarp Mail's accounts on this computer (`polycarp mail host`): a native messaging host the browser starts. It
//! will reach an account's own IMAP server over TLS and hand back new mail as rows the Hub's store takes; for now it
//! answers where the common accounts are. Nothing is kept here; the Hub keeps the mail.

use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{self, Read, Write};

#[cfg(test)]
mod tests;

/// Where the common accounts are, and what each needs from the person.
pub fn presets() -> Value {
    json!([
        { "id": "fastmail", "label": "Fastmail",
          "imap": { "host": "imap.fastmail.com", "port": 993, "security": "tls" },
          "smtp": { "host": "smtp.fastmail.com", "port": 465, "security": "tls" },
          "secret": "An app password from Fastmail's Settings, Privacy & Security, Manage app passwords." },
        { "id": "icloud", "label": "iCloud Mail",
          "imap": { "host": "imap.mail.me.com", "port": 993, "security": "tls" },
          "smtp": { "host": "smtp.mail.me.com", "port": 587, "security": "starttls" },
          "secret": "An app-specific password from your Apple Account's Sign-In and Security page." },
        { "id": "proton-bridge", "label": "Proton Mail Bridge",
          "imap": { "host": "127.0.0.1", "port": 1143, "security": "starttls" },
          "smtp": { "host": "127.0.0.1", "port": 1025, "security": "starttls" },
          "secret": "The password Bridge shows for this address, and Bridge's certificate (Bridge settings, Export TLS certificates)." },
        { "id": "generic", "label": "Another IMAP account",
          "secret": "The account's password, or an app password if it asks for one." }
    ])
}

// ---------- Native messaging ----------
// Each message is a 32-bit length in this computer's byte order, then that much JSON. The browser sends at most 64 MiB
// and takes at most 1 MB, so replies are cut into pieces under that.
const MOST_IN: u32 = 64 << 20;
pub const MOST_OUT: usize = 1_000_000;

pub fn read_message(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let n = u32::from_ne_bytes(len);
    if n > MOST_IN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a message over 64 MiB",
        ));
    }
    let mut buf = vec![0; n as usize];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn write_message(w: &mut impl Write, v: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(v)?;
    if bytes.len() > MOST_OUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a reply over 1 MB",
        ));
    }
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

/// One request in, its replies out. Every reply carries the request's `id`; a pull's rows come in pieces, and the
/// last says `last: true`.
pub fn answer(req: &Value) -> Vec<Value> {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let fail = |e: String| vec![json!({ "id": id, "ok": false, "error": e, "last": true })];
    match req.get("op").and_then(Value::as_str) {
        Some("mail.presets") => {
            vec![json!({ "id": id, "ok": true, "presets": presets(), "last": true })]
        }
        _ => fail("unknown request".into()),
    }
}

pub fn run(args: &[OsString]) -> i32 {
    if args.first().and_then(|a| a.to_str()) != Some("host") {
        eprintln!("usage: polycarp mail host   (started by the browser for Polycarp Mail)");
        return 2;
    }
    let (mut input, mut output) = (io::stdin().lock(), io::stdout().lock());
    loop {
        match read_message(&mut input) {
            Ok(Some(req)) => {
                for reply in answer(&req) {
                    if write_message(&mut output, &reply).is_err() {
                        return 1;
                    }
                }
            }
            Ok(None) => return 0,
            Err(e) => {
                eprintln!("polycarp mail: {e}");
                return 1;
            }
        }
    }
}
