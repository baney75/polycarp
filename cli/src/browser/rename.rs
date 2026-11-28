//! Helium's name made Polycarp's in the interface's text, the same way on every system. Shared by the Mac and Windows;
//! nothing here runs a program.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::pak::Pak;
use super::{refuse, Refused};

const CHECK: &str = "change";

/// `[from] name`, `[to] name` and `[strings] keep` from `changes.toml`.
pub struct Rename<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub keep: &'a [String],
}

impl Rename<'_> {
    /// Text with Helium's name made Polycarp's, except where it is part of a phrase that stays.
    pub fn renamed(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find(self.from) {
            let (before, here) = rest.split_at(at);
            let stays = self.keep.iter().any(|k| here.starts_with(k));
            out.push_str(before);
            out.push_str(if stays { self.from } else { self.to });
            rest = &here[self.from.len()..];
        }
        out + rest
    }

    fn keeps(&self, text: &[u8]) -> bool {
        let has = |k: &String| text.windows(k.len()).any(|w| w == k.as_bytes());
        self.keep.iter().any(has)
    }
}

/// The interface's text, in every language. What stays is chosen by the English text and kept in each language.
pub fn rename_paks(
    packs: &[&PathBuf],
    english: &dyn Fn(&Path) -> bool,
    rename: &Rename,
) -> Result<(), Refused> {
    let mut read = Vec::new();
    for file in packs {
        let bytes = fs::read(file).map_err(refuse(CHECK, "reading its text"))?;
        let pak = Pak::parse(&bytes)
            .ok_or_else(|| Refused::new(CHECK, "its text is in a form this version can't read"))?;
        read.push((file, pak));
    }
    let Some((_, first)) = read.iter().find(|(f, _)| english(f)) else {
        return Err(Refused::new(CHECK, "it has no English text"));
    };
    let kept = first.entries.iter().filter(|(_, t)| rename.keeps(t));
    let stays: HashSet<u16> = kept.map(|(id, _)| *id).collect();
    for (file, mut pak) in read {
        for (id, text) in &mut pak.entries {
            if let (false, Ok(old)) = (stays.contains(id), std::str::from_utf8(text)) {
                *text = rename.renamed(old).into_bytes();
            }
        }
        let bytes = pak.bytes();
        let bytes = bytes.ok_or_else(|| Refused::new(CHECK, "its text grew too large"))?;
        fs::write(file, bytes).map_err(refuse(CHECK, "writing its text"))?;
    }
    Ok(())
}
