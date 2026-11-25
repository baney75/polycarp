//! The paper a look holds: a color, a scene, or a picture carried in the file itself.

use super::format::shown;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_PICTURE: usize = 25 * 1024 * 1024;
const SCENES: [&str; 5] = ["field", "olive", "water", "parchment", "solid"];

#[derive(Clone, Debug, PartialEq)]
pub enum Wall {
    /// `#RRGGBB` or a scene.
    Value(String),
    /// The sha256 of one of the look's pictures.
    Picture(String),
}

/// `all` is behind every place; a place's own is over it. As surfaces.json keeps it.
pub type Paper = BTreeMap<String, Wall>;
pub const PLACES: [&str; 3] = ["desktop", "newtab", "idle"];

#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub kind: &'static str,
    pub bytes: Vec<u8>,
}

impl Picture {
    /// The type the bytes themselves say, or why they are no paper.
    pub fn of(bytes: Vec<u8>) -> Result<Picture, String> {
        if bytes.len() > MAX_PICTURE {
            return Err("the picture is over 25 MB, the most a paper may be".into());
        }
        let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "image/jpeg"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else if bytes.get(4..8) == Some(b"ftyp")
            && bytes.get(8..12).is_some_and(|b| {
                [
                    b"heic", b"heix", b"heim", b"heis", b"hevc", b"mif1", b"msf1",
                ]
                .iter()
                .any(|k| b == *k)
            })
        {
            "image/heic"
        } else {
            return Err("not a PNG, JPEG, HEIC or WebP picture".into());
        };
        Ok(Picture { kind, bytes })
    }
    pub fn sha256(&self) -> String {
        sha256(&self.bytes)
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn pictures(v: Option<&Json>, bad: &mut Vec<String>) -> BTreeMap<String, Picture> {
    let mut out = BTreeMap::new();
    let Some(v) = v else { return out };
    let Some(o) = v.as_object() else {
        bad.push("pictures: must be an object".into());
        return out;
    };
    for (hash, p) in o {
        let at = format!("pictures.{}", shown(hash));
        let keys: Vec<&str> = p
            .as_object()
            .map(|m| m.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let (Some(kind), Some(data)) = (p["type"].as_str(), p["base64"].as_str()) else {
            bad.push(format!("{at}: must have type and base64"));
            continue;
        };
        if let Some(k) = keys.iter().find(|k| !["type", "base64"].contains(k)) {
            bad.push(format!("{at}.{}: unknown key", shown(k)));
            continue;
        }
        let pic = match unbase64(data)
            .ok_or("not base64".to_string())
            .and_then(Picture::of)
        {
            Ok(p) => p,
            Err(why) => {
                bad.push(format!("{at}: {why}"));
                continue;
            }
        };
        if pic.kind != kind {
            bad.push(format!(
                "{at}.type: says {:?}, but the picture is {}",
                shown(kind),
                pic.kind
            ));
        } else if pic.sha256() != *hash {
            bad.push(format!("{at}: the name is not the picture's sha256"));
        } else {
            out.insert(hash.clone(), pic);
        }
    }
    out
}

pub fn read(v: &Json, pictures: &BTreeMap<String, Picture>, bad: &mut Vec<String>) -> Paper {
    let mut out = Paper::new();
    let Some(o) = v.as_object() else {
        bad.push("paper: must be an object".into());
        return out;
    };
    for (place, w) in o {
        let at = format!("paper.{}", shown(place));
        if place != "all" && !PLACES.contains(&place.as_str()) {
            bad.push(format!(
                "{at}: unknown key (use all, desktop, newtab or idle)"
            ));
            continue;
        }
        let wall = match w {
            Json::String(s) if is_paper(s) => Wall::Value(s.clone()),
            Json::Object(m) if m.len() == 1 => match m.get("picture").and_then(Json::as_str) {
                Some(h) if pictures.contains_key(h) => Wall::Picture(h.to_string()),
                _ => {
                    bad.push(format!("{at}.picture: not one of this look's pictures"));
                    continue;
                }
            },
            _ => {
                bad.push(format!(
                    "{at}: must be a #RRGGBB color, a scene or one of this look's pictures"
                ));
                continue;
            }
        };
        out.insert(place.clone(), wall);
    }
    out
}

pub fn to_json(p: &Paper) -> Json {
    let of = |w: &Wall| match w {
        Wall::Value(v) => json!(v),
        Wall::Picture(h) => json!({ "picture": h }),
    };
    Json::Object(p.iter().map(|(k, w)| (k.clone(), of(w))).collect())
}

pub fn pictures_json(p: &BTreeMap<String, Picture>) -> Json {
    let of = |p: &Picture| json!({"type": p.kind, "base64": base64(&p.bytes)});
    Json::Object(p.iter().map(|(h, p)| (h.clone(), of(p))).collect())
}

/// A color or a scene `polycarp-spaces paper set` takes.
pub fn is_paper(s: &str) -> bool {
    SCENES.contains(&s)
        || (s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = c
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            let ch = ALPHABET[(n >> (18 - 6 * i)) as usize & 63];
            out.push(if i <= c.len() { ch as char } else { '=' });
        }
    }
    out
}

/// Strict: whole groups of four, padding only at the end, no spaces.
pub fn unbase64(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return None;
    }
    let pad = b.iter().rev().take_while(|c| **c == b'=').count();
    if pad > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for (g, c) in b.chunks(4).enumerate() {
        let last = (g + 1) * 4 == b.len();
        let mut n = 0u32;
        for (i, ch) in c.iter().enumerate() {
            let v = match ch {
                b'A'..=b'Z' => ch - b'A',
                b'a'..=b'z' => ch - b'a' + 26,
                b'0'..=b'9' => ch - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if last && i >= 4 - pad => 0,
                _ => return None,
            };
            n = n << 6 | u32::from(v);
        }
        let take = if last { 3 - pad } else { 3 };
        out.extend_from_slice(&n.to_be_bytes()[1..1 + take]);
    }
    Some(out)
}
