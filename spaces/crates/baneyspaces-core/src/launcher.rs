//! The launcher's matcher, ported from the macOS app's `LauncherMatch` module to the rules in `spec/launcher.md`
//! (R-L1 to R-L6). Every typed letter must appear in a name in order, and the score says
//! how well: a letter at the start of a word, after a lowercase letter in camelCase or right after the last
//! matched letter counts more, and a gap between letters costs. Words typed apart each match on their own. A
//! word of four letters or more with one letter wrong, missing, extra or swapped still finds a word of the
//! name, scored below a clean match of the same length.
//!
//! Names are prepared once ([`Name`]): folded, with each letter's bonus worked out, so a keystroke only walks
//! small integer slices. Preparing is the costly part; do it when the list changes, never per keystroke.

mod fold;
mod index;

pub use index::{Entry, EntryKind, Hit, LauncherIndex};

use std::cmp::{max, min};

const LETTER: i32 = 16;
const GAP_START: i32 = 3;
const GAP_EXTEND: i32 = 1;
const AFTER_SPACE: i8 = 10;
const AFTER_DELIMITER: i8 = 9;
const AFTER_OTHER: i8 = 8;
const CAMEL: i8 = 7;
const CONSECUTIVE: i8 = 4;
/// The letter a match starts on counts its bonus twice: where it starts matters most.
const FIRST_MULTIPLIER: i32 = 2;
/// A typed word must be this long before a typo in it is forgiven (R-L3).
pub const TYPO_MINIMUM: usize = 4;
const NONE: i32 = i32::MIN / 4;

/// A name ready to be matched (R-L12).
#[derive(Clone, Debug)]
pub struct Name {
    chars: Vec<u32>,
    bonus: Vec<i8>,
    /// Where each word starts, for typos.
    starts: Vec<u32>,
    mask: u64,
}

impl Name {
    pub fn new(text: &str) -> Name {
        let mut n = Name { chars: Vec::with_capacity(text.len()), bonus: Vec::with_capacity(text.len()), starts: vec![], mask: 0 };
        let mut prev = Kind::Space;
        for ch in text.chars() {
            // A combining mark belongs to the letter before it, as in a Swift Character.
            if combining(ch as u32) {
                continue;
            }
            let kind = Kind::of(ch);
            let b = bonus(kind, prev);
            if kind.is_word() && b >= CAMEL {
                n.starts.push(n.chars.len() as u32);
            }
            let mut first = true;
            fold(ch, |v| {
                n.chars.push(v);
                n.bonus.push(if first || !kind.is_word() { b } else { 0 });
                n.mask |= bit(v);
                first = false;
            });
            prev = kind;
        }
        n
    }
}

/// What was typed, split into words and folded the same way.
#[derive(Clone, Debug)]
pub struct Query {
    words: Vec<Vec<u32>>,
    masks: Vec<u64>,
    letters: usize,
}

impl Query {
    pub fn new(text: &str) -> Query {
        let words: Vec<Vec<u32>> = text
            .split(char::is_whitespace)
            .map(|part| {
                let mut w = vec![];
                for ch in part.chars() {
                    fold(ch, |v| w.push(v));
                }
                w
            })
            .filter(|w| !w.is_empty())
            .collect();
        let masks = words.iter().map(|w| w.iter().fold(0, |m, &c| m | bit(c))).collect();
        let letters = words.iter().map(Vec::len).sum();
        Query { words, masks, letters }
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }
}

/// Working rows for one keystroke, reused across names so scoring allocates nothing per name.
#[derive(Default)]
struct Scratch {
    h: Vec<i32>,
    run: Vec<i8>,
    rows: Vec<i32>,
}

/// Higher is better; `None` is no match. An empty query matches everything with 0.
pub fn score(query: &str, name: &str) -> Option<i32> {
    let s = score_name(&Query::new(query), &Name::new(name), &mut Scratch::default());
    (s > NONE).then_some(s)
}

/// A name's score (R-L6), or `NONE` when it doesn't match.
fn score_name(q: &Query, n: &Name, sc: &mut Scratch) -> i32 {
    if q.words.is_empty() {
        return 0;
    }
    let mut total = 0;
    for (w, &m) in q.words.iter().zip(&q.masks) {
        let missing = m & !n.mask;
        let mut s = NONE;
        if missing == 0 {
            s = word(w, n, sc);
        }
        if s == NONE {
            if w.len() < TYPO_MINIMUM || missing.count_ones() > 1 || !typo(w, n, sc) {
                return NONE;
            }
            s = (w.len() as i32 - 1) * LETTER - 8;
        }
        total += s;
    }
    // The whole name typed: above anything that only starts it.
    if n.chars.len() == q.letters + q.words.len() - 1 {
        let mut want = q.words.iter().enumerate().flat_map(|(i, w)| (i > 0).then_some(&32).into_iter().chain(w));
        if n.chars.iter().all(|c| want.next() == Some(c)) {
            total += 40;
        }
    }
    // Of two names matched as well, the shorter one is the likelier.
    total - min(n.chars.len(), 40) as i32 / 2
}

/// The best placement of one typed word in the name (R-L5), or `NONE` if its letters aren't there in order.
fn word(q: &[u32], n: &Name, sc: &mut Scratch) -> i32 {
    let (m, len) = (q.len(), n.chars.len());
    if m > len {
        return NONE;
    }
    let (name, bonus) = (&n.chars[..], &n.bonus[..]);
    // Letters in order at all? Also finds the first column the match can start in.
    let (mut at, mut first) = (0, usize::MAX);
    for &c in q {
        while at < len && name[at] != c {
            at += 1;
        }
        if at == len {
            return NONE;
        }
        first = min(first, at);
        at += 1;
    }
    sc.h.clear();
    sc.h.resize(len * 2, NONE);
    sc.run.clear();
    sc.run.resize(len * 2, 0);
    let (h, run) = (&mut sc.h, &mut sc.run);
    let (mut prev, mut cur) = (0, len);
    // First letter: anywhere it appears, its bonus doubled, a little less the later it starts.
    for j in first..len {
        if name[j] == q[0] {
            h[j] = LETTER + bonus[j] as i32 * FIRST_MULTIPLIER - (min(j, 16) / 4) as i32;
            run[j] = bonus[j];
        }
    }
    for (i, &c) in q.iter().enumerate().skip(1) {
        // The best match of the last letter that leaves a gap before column j.
        let mut open = NONE;
        for j in 0..len {
            if j >= 2 {
                open = max(open - GAP_EXTEND, h[prev + j - 2] - GAP_START);
            }
            if name[j] != c || j < i {
                h[cur + j] = NONE;
                continue;
            }
            let (mut best, mut carried) = (NONE, 0);
            let b = bonus[j];
            let diag = h[prev + j - 1];
            if diag > NONE {
                // Right after the last letter: the run keeps the bonus it started with.
                carried = max(run[prev + j - 1], b);
                best = diag + LETTER + max(carried, CONSECUTIVE) as i32;
            }
            if open > NONE / 2 {
                let g = open + LETTER + b as i32;
                if g > best {
                    best = g;
                    carried = b;
                }
            }
            h[cur + j] = best;
            run[cur + j] = carried;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let best = h[prev..prev + len].iter().copied().max().unwrap_or(NONE);
    if best > NONE / 2 {
        best
    } else {
        NONE
    }
}

/// One letter wrong, missing, extra or two swapped, against the start of some word of the name (R-L3):
/// optimal string alignment distance of at most 1 to a prefix of that word.
fn typo(q: &[u32], n: &Name, sc: &mut Scratch) -> bool {
    let m = q.len();
    let wide = m + 2;
    let chars = &n.chars[..];
    sc.rows.clear();
    sc.rows.resize(wide * 3, 0);
    let rows = &mut sc.rows;
    for &start in &n.starts {
        let s = start as usize;
        // One edit leaves one of the first two typed letters at the word's first or second letter.
        let w0 = chars[s];
        let w1 = if s + 1 < chars.len() { chars[s + 1] } else { 0 };
        if !(q[0] == w0 || q[1] == w1 || q[1] == w0 || q[0] == w1) {
            continue;
        }
        // The word's letters from `start`, up to one more than was typed.
        let k = min(chars.len() - s, m + 1);
        if k + 1 < m {
            continue;
        }
        // rows: two back, one back, this one; each m + 1 wide over the typed letters.
        let (mut r2, mut r1, mut r0) = (0, wide, wide * 2);
        for i in 0..=m {
            rows[r1 + i] = i as i32;
        }
        let mut best = i32::MAX;
        for j in 1..=k {
            let c = chars[s + j - 1];
            rows[r0] = j as i32;
            for i in 1..=m {
                let cost = (q[i - 1] != c) as i32;
                let mut d = min(min(rows[r1 + i] + 1, rows[r0 + i - 1] + 1), rows[r1 + i - 1] + cost);
                if i > 1 && j > 1 && q[i - 1] == chars[s + j - 2] && q[i - 2] == c {
                    d = min(d, rows[r2 + i - 2] + 1);
                }
                rows[r0 + i] = d;
            }
            if j + 1 >= m {
                best = min(best, rows[r0 + m]);
            }
            (r2, r1, r0) = (r1, r0, r2);
        }
        if best <= 1 {
            return true;
        }
    }
    false
}

// Letters

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Space,
    Delimiter,
    Other,
    Lower,
    Upper,
    Digit,
}

impl Kind {
    fn of(ch: char) -> Kind {
        if ch.is_whitespace() {
            Kind::Space
        } else if ch.is_numeric() {
            Kind::Digit
        } else if ch.is_alphabetic() {
            if ch.is_uppercase() {
                Kind::Upper
            } else {
                Kind::Lower
            }
        } else if "/-_.:,;|\\+&".contains(ch) {
            Kind::Delimiter
        } else {
            Kind::Other
        }
    }

    fn is_word(self) -> bool {
        matches!(self, Kind::Lower | Kind::Upper | Kind::Digit)
    }
}

/// A letter's bonus from the character before it (R-L4).
fn bonus(kind: Kind, prev: Kind) -> i8 {
    if !kind.is_word() {
        return AFTER_OTHER;
    }
    match prev {
        Kind::Space => AFTER_SPACE,
        Kind::Delimiter => AFTER_DELIMITER,
        Kind::Other => AFTER_OTHER,
        Kind::Lower if matches!(kind, Kind::Upper | Kind::Digit) => CAMEL,
        Kind::Upper if kind == Kind::Digit => CAMEL,
        Kind::Digit if kind != Kind::Digit => CAMEL,
        _ => 0,
    }
}

fn combining(v: u32) -> bool {
    matches!(v, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Lowercase with accents dropped (R-L2); ASCII without a table lookup.
fn fold(ch: char, mut emit: impl FnMut(u32)) {
    let v = ch as u32;
    if ch.is_ascii() {
        emit(ch.to_ascii_lowercase() as u32);
    } else if combining(v) {
    } else if v == 0xDF || v == 0x1E9E {
        // Sharp s folds to "ss", as case folding does.
        emit(115);
        emit(115);
    } else if let Ok(i) = fold::TABLE.binary_search_by_key(&v, |&(from, _)| from) {
        emit(fold::TABLE[i].1);
    } else {
        for l in ch.to_lowercase() {
            if !combining(l as u32) {
                emit(l as u32);
            }
        }
    }
}

/// One bit per letter or digit, the rest sharing the top bits: a name lacking a typed letter is passed over
/// without a look at its letters.
fn bit(v: u32) -> u64 {
    match v {
        97..=122 => 1 << (v - 97),
        48..=57 => 1 << (v - 48 + 26),
        _ => 1 << (36 + v % 28),
    }
}

#[cfg(test)]
mod tests;
