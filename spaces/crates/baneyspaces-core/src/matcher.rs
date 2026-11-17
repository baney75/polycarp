//! How well a name answers what was typed into the launcher, and how results are ranked. The same rules as the
//! Mac launcher (`Fuzzy`, `Recents` in `Sources/BaneySpacesCore/Launcher.swift`); `spec/launcher-match.json` holds the
//! cases both must agree on.
//!
//! A name that is the query beats one that starts with it ("Code" for "co" beats "Visual Studio Code"), which beats
//! a word that starts with it, then initials ("vsc"), then the query found inside, then its letters found in order
//! ("sfr" finds Safari, closer letters scoring higher). Shorter names win ties within a rule.

/// Higher is better; `None` is no match. An empty query matches everything with 0.
pub fn score(query: &str, name: &str) -> Option<i32> {
    let q = fold(query);
    if q.is_empty() {
        return Some(0);
    }
    let n = fold(name);
    let len = n.chars().count().min(99) as i32;
    if n == q {
        return Some(1000);
    }
    if n.starts_with(&q) {
        return Some(900 - len);
    }
    let words: Vec<&str> = n
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    if words.iter().any(|w| w.starts_with(&q)) {
        return Some(700 - len);
    }
    let initials: String = words.iter().filter_map(|w| w.chars().next()).collect();
    if initials.starts_with(&q) {
        return Some(600 - len);
    }
    if n.contains(&q) {
        return Some(500 - len);
    }
    // Every letter in order. Letters close together score higher.
    let hay: Vec<char> = n.chars().collect();
    let mut at = 0usize;
    let mut last: Option<usize> = None;
    let mut gaps = 0i32;
    for ch in q.chars().filter(|c| *c != ' ') {
        let found = hay[at..].iter().position(|c| *c == ch)? + at;
        if let Some(l) = last {
            gaps += (found - l - 1) as i32;
        }
        last = Some(found);
        at = found + 1;
    }
    Some((300 - gaps * 10 - len).max(1))
}

/// Lowercased, with accents dropped and outer spaces trimmed: "Café" matches "cafe".
pub fn fold(s: &str) -> String {
    s.trim()
        .chars()
        .flat_map(char::to_lowercase)
        .map(plain)
        .collect()
}

/// The letter without its accent, for the Latin letters app names use.
fn plain(c: char) -> char {
    match c {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è'..='ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì'..='ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù'..='ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other => other,
    }
}

/// Things opened from the launcher, most recent first, so the ones you use come up first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recents {
    keys: Vec<String>,
}

impl Recents {
    pub const LIMIT: usize = 30;

    pub fn new(keys: Vec<String>) -> Self {
        let mut r = Recents { keys };
        r.keys.truncate(Self::LIMIT);
        r
    }

    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    pub fn used(&mut self, key: &str) {
        self.keys.retain(|k| k != key);
        self.keys.insert(0, key.to_string());
        self.keys.truncate(Self::LIMIT);
    }

    /// A small lift for recent things: enough to break near-ties, never enough to beat a better match.
    pub fn boost(&self, key: &str) -> i32 {
        self.keys
            .iter()
            .position(|k| k == key)
            .map_or(0, |i| 60 - 2 * i as i32)
    }
}

/// The lift for an app that is running now, as on the Mac.
pub const RUNNING_BOOST: i32 = 15;

/// Ranks `items` for `query`: by score plus each item's lift, best first, then by name. Items that don't match are
/// left out. With an empty query every item is kept in the order given.
pub fn rank<'a, T>(
    query: &str,
    items: &'a [T],
    name: impl Fn(&T) -> &str,
    lift: impl Fn(&T) -> i32,
) -> Vec<&'a T> {
    if fold(query).is_empty() {
        return items.iter().collect();
    }
    let mut scored: Vec<(&T, i32)> = items
        .iter()
        .filter_map(|it| score(query, name(it)).map(|s| (it, s + lift(it))))
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| name(a.0).cmp(name(b.0))));
    scored.into_iter().map(|(it, _)| it).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn spec() -> Value {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../spec/launcher-match.json"
        );
        serde_json::from_str(&std::fs::read_to_string(p).expect("spec/launcher-match.json"))
            .expect("valid json")
    }

    #[test]
    fn every_score_in_the_spec() {
        for c in spec()["scores"].as_array().unwrap() {
            let (q, n) = (c["query"].as_str().unwrap(), c["name"].as_str().unwrap());
            let want = c["score"].as_i64().map(|s| s as i32);
            assert_eq!(score(q, n), want, "score({q:?}, {n:?})");
        }
    }

    #[test]
    fn every_top_hit_in_the_spec() {
        for c in spec()["top"].as_array().unwrap() {
            let q = c["query"].as_str().unwrap();
            let names: Vec<&str> = c["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let recents = Recents::new(
                c["recents"]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
                    .unwrap_or_default(),
            );
            let ranked = rank(q, &names, |n| n, |n| recents.boost(n));
            assert_eq!(
                ranked.first().copied().copied(),
                c["top"].as_str(),
                "top hit for {q:?} among {names:?}"
            );
        }
    }

    #[test]
    fn recents_keep_thirty_most_recent_first() {
        let mut r = Recents::default();
        for i in 0..40 {
            r.used(&format!("app{i}"));
        }
        r.used("app35");
        assert_eq!(r.keys().len(), Recents::LIMIT);
        assert_eq!(r.keys()[0], "app35");
        assert_eq!(r.boost("app35"), 60);
        assert_eq!(r.boost("app39"), 58);
        assert_eq!(r.boost("app0"), 0);
    }

    #[test]
    fn an_empty_query_keeps_the_given_order() {
        let names = ["b", "a", "c"];
        let ranked: Vec<&&str> = rank("  ", &names, |n| n, |_| 0);
        assert_eq!(ranked, vec![&"b", &"a", &"c"]);
    }
}
