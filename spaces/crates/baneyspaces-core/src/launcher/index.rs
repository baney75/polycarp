//! The launcher's index (`spec/launcher.md` R-L7 to R-L10): every entry with its names prepared once, searched
//! per keystroke and ranked by score, then kind, then the order entries were added.

use super::{score_name, Name, Query, Scratch, NONE, TYPO_MINIMUM};
use std::cmp::{max, Reverse};

/// What an entry is (R-L8), in the order the launcher shows its sections, which is also how ties go (R-L9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntryKind {
    App,
    Window,
    Workspace,
    Command,
    Menu,
}

/// One thing to find, under any of its names. A name with a cost answers less well than the entry's own
/// name: a workspace found by an app on it ranks below the app.
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub kind: EntryKind,
    names: Vec<(Name, i32)>,
}

impl Entry {
    /// What a workspace found by an app on it gives up against the app itself.
    pub const BY_APP_ON_IT: i32 = 25;
    /// What a window found by its detail line (a path, a command) gives up against its title.
    pub const BY_DETAIL: i32 = 20;

    pub fn new(id: impl Into<String>, kind: EntryKind, names: &[(&str, i32)]) -> Entry {
        Entry { id: id.into(), kind, names: names.iter().map(|&(n, cost)| (Name::new(n), cost)).collect() }
    }
    pub fn app(id: impl Into<String>, name: &str) -> Entry {
        Entry::new(id, EntryKind::App, &[(name, 0)])
    }
    pub fn command(id: impl Into<String>, title: &str) -> Entry {
        Entry::new(id, EntryKind::Command, &[(title, 0)])
    }
    pub fn menu(id: impl Into<String>, title: &str) -> Entry {
        Entry::new(id, EntryKind::Menu, &[(title, 0)])
    }
    /// "Workspace 3", found by "3", "ws 3" or the name of an app on it.
    pub fn workspace(id: impl Into<String>, number: u32, apps: &[&str]) -> Entry {
        let (long, short) = (format!("Workspace {number}"), number.to_string());
        let mut names = vec![(long.as_str(), 0), (short.as_str(), 0)];
        names.extend(apps.iter().map(|&a| (a, Entry::BY_APP_ON_IT)));
        Entry::new(id, EntryKind::Workspace, &names)
    }
    /// A window, tab or terminal: by its title, its app and title together, or its detail.
    pub fn window(id: impl Into<String>, title: &str, app: &str, detail: &str) -> Entry {
        let both = format!("{app} {title}");
        let mut names = vec![(title, 0), (both.as_str(), 0)];
        if !detail.is_empty() {
            names.push((detail, Entry::BY_DETAIL));
        }
        Entry::new(id, EntryKind::Window, &names)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub id: String,
    pub kind: EntryKind,
    pub score: i32,
}

/// Everything the launcher can find without asking the disk, each entry with its names prepared once. A
/// keystroke scores every entry against what was typed and keeps the best.
#[derive(Clone, Debug, Default)]
pub struct LauncherIndex {
    entries: Vec<Entry>,
}

impl LauncherIndex {
    pub fn new(entries: Vec<Entry>) -> LauncherIndex {
        LauncherIndex { entries }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn extend(&mut self, more: impl IntoIterator<Item = Entry>) {
        self.entries.extend(more);
    }

    /// The best `limit` entries for what was typed, best first (R-L7, R-L9). `kinds` narrows the search;
    /// `boost` adds to an entry's score (R-L10), only once something is typed.
    pub fn search(&self, text: &str, kinds: Option<&[EntryKind]>, limit: usize, boost: impl Fn(&str) -> i32) -> Vec<Hit> {
        let q = Query::new(text);
        // A name missing more typed letters than there are words long enough for a typo can't match.
        let all = q.masks.iter().fold(0, |a, m| a | m);
        let forgiven = q.words.iter().filter(|w| w.len() >= TYPO_MINIMUM).count() as u32;
        let mut sc = Scratch::default();
        let mut hits: Vec<(i32, EntryKind, usize)> = vec![];
        for (i, e) in self.entries.iter().enumerate() {
            if kinds.is_some_and(|k| !k.contains(&e.kind)) {
                continue;
            }
            let mut best = NONE;
            for (name, cost) in &e.names {
                if (all & !name.mask).count_ones() > forgiven {
                    continue;
                }
                let s = score_name(&q, name, &mut sc);
                if s > NONE {
                    best = max(best, s - cost);
                }
            }
            if best > NONE {
                hits.push((best + if q.is_empty() { 0 } else { boost(&e.id) }, e.kind, i));
            }
        }
        // Score, then kind (apps first), then place in the index.
        hits.sort_unstable_by_key(|&(s, kind, i)| (Reverse(s), kind, i));
        hits.truncate(limit);
        hits.into_iter().map(|(score, kind, i)| Hit { id: self.entries[i].id.clone(), kind, score }).collect()
    }
}

#[cfg(test)]
#[path = "index_tests.rs"]
mod tests;
