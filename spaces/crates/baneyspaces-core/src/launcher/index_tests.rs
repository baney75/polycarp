//! The macOS app's `RankingTableTests` (index part) and `LatencyTests` (`spec/launcher.md`), as Rust tests: the same index,
//! the same queries and the same expected top hits.

use super::*;

#[rustfmt::skip]
const APPS: &[&str] = &[
    "1Password", "Activity Monitor", "App Store", "Calculator", "Calendar", "ChatGPT", "Chess", "Claude", "Cursor",
    "Discord", "Docker", "FaceTime", "Figma", "Finder", "Firefox", "Font Book", "Ghostty", "GitHub Desktop",
    "Google Chrome", "Helium", "Keynote", "Mail", "Maps", "Messages", "Music", "Notes", "Notion", "Numbers", "Obsidian",
    "Pages", "Photo Booth", "Photos", "Preview", "Proton Drive", "Proton Mail", "Proton Pass", "Reminders", "Safari",
    "Signal", "Slack", "Spotify", "System Settings", "T3 Code", "Tailscale", "Terminal", "TextEdit",
    "Visual Studio Code", "Xcode", "Zoom",
];
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "Lock Screen", "Sleep", "Restart…", "Shut Down…", "Log Out…", "Toggle Dark Mode", "Take a Screenshot",
    "New Claude Session", "New Terminal", "Show All Workspaces", "Bring Every Window Back", "Turn Off Workspace Dock",
    "Polycarp Settings",
];
const MENUS: &[&str] = &["Search the Web", "Apps", "Files", "Install", "Remove", "Update", "System", "Workspaces"];
const WORKSPACES: &[(u32, &[&str])] = &[
    (1, &["Ghostty", "Helium"]),
    (2, &["Slack", "Mail"]),
    (3, &["T3 Code"]),
    (4, &[]),
    (5, &["Spotify"]),
    (6, &[]),
    (7, &[]),
    (8, &[]),
    (9, &["Proton Pass"]),
];
const WINDOWS: &[(&str, &str, &str, &str)] = &[
    ("w:inbox", "Inbox - Proton Mail", "Helium", ""),
    ("w:polycarp", "polycarp", "Ghostty", "~/Projects/polycarp"),
    ("w:invoice", "Invoice 2026-11.pdf", "Preview", ""),
];

fn index() -> LauncherIndex {
    let mut e: Vec<Entry> = APPS.iter().map(|a| Entry::app(format!("app:{a}"), a)).collect();
    e.extend(COMMANDS.iter().map(|c| Entry::command(format!("cmd:{c}"), c)));
    e.extend(MENUS.iter().map(|m| Entry::menu(format!("menu:{m}"), m)));
    e.extend(WORKSPACES.iter().map(|&(n, apps)| Entry::workspace(format!("ws:{n}"), n, apps)));
    e.extend(WINDOWS.iter().map(|&(id, title, app, detail)| Entry::window(id, title, app, detail)));
    LauncherIndex::new(e)
}

fn none(_: &str) -> i32 {
    0
}

/// Query, then the id that must come first.
const CASES: &[(&str, &str)] = &[
    ("saf", "app:Safari"),
    ("safari", "app:Safari"),
    ("vsc", "app:Visual Studio Code"),
    ("xc", "app:Xcode"),
    ("sys set", "app:System Settings"),
    ("ss", "app:System Settings"),
    ("lock", "cmd:Lock Screen"),
    ("lck", "cmd:Lock Screen"),
    ("dark", "cmd:Toggle Dark Mode"),
    ("tdm", "cmd:Toggle Dark Mode"),
    ("shut", "cmd:Shut Down…"),
    ("new term", "cmd:New Terminal"),
    ("new cl", "cmd:New Claude Session"),
    ("dock", "app:Docker"),
    ("turn off dock", "cmd:Turn Off Workspace Dock"),
    ("bring back", "cmd:Bring Every Window Back"),
    ("3", "ws:3"),
    ("ws 3", "ws:3"),
    ("workspace 5", "ws:5"),
    ("gh", "app:Ghostty"),
    ("ghosty", "app:Ghostty"),
    ("calc", "app:Calculator"),
    ("cal", "app:Calendar"),
    ("am", "app:Activity Monitor"),
    ("mon", "app:Activity Monitor"),
    ("tc", "app:T3 Code"),
    ("t3", "app:T3 Code"),
    ("1p", "app:1Password"),
    ("pp", "app:Proton Pass"),
    ("pm", "app:Proton Mail"),
    ("claude", "app:Claude"),
    ("fontbook", "app:Font Book"),
    ("msg", "app:Messages"),
    ("ft", "app:FaceTime"),
    ("spot", "app:Spotify"),
    ("ter", "app:Terminal"),
    ("files", "menu:Files"),
    ("inst", "menu:Install"),
    ("inbox", "w:inbox"),
    ("ghostty polycarp", "w:polycarp"),
    ("invoice", "w:invoice"),
    // One letter wrong, swapped, extra or missing.
    ("safaru", "app:Safari"),
    ("chorme", "app:Google Chrome"),
    ("slakc", "app:Slack"),
    ("termimal", "app:Terminal"),
    ("obsidain", "app:Obsidian"),
    ("discrod", "app:Discord"),
    ("spotiffy", "app:Spotify"),
    ("calendr", "app:Calendar"),
];

#[test]
fn every_query_puts_its_entry_first() {
    let index = index();
    let mut wrong = vec![];
    for &(query, expected) in CASES {
        let top = index.search(query, None, 3, none);
        if top.first().map(|h| h.id.as_str()) != Some(expected) {
            wrong.push(format!(
                "{query:?}: wanted {expected}, got {:?}",
                top.iter().map(|h| format!("{} {}", h.id, h.score)).collect::<Vec<_>>()
            ));
        }
    }
    assert_eq!(CASES.len(), 49);
    assert!(wrong.is_empty(), "{} of {} wrong:\n{}", wrong.len(), CASES.len(), wrong.join("\n"));
}

#[test]
fn boost_lifts_an_entry_only_when_something_was_typed() {
    let index = index();
    assert_eq!(index.search("cal", None, 1, none)[0].id, "app:Calendar");
    let calc = |id: &str| if id == "app:Calculator" { 30 } else { 0 };
    assert_eq!(index.search("cal", None, 1, calc)[0].id, "app:Calculator");
    let zoom = |id: &str| if id == "app:Zoom" { 30 } else { 0 };
    assert_eq!(index.search("", None, 1, zoom)[0].id, "app:1Password");
}

#[test]
fn kinds_narrow_the_search() {
    let index = index();
    let ids: Vec<String> = index.search("slack", Some(&[EntryKind::Workspace]), usize::MAX, none).into_iter().map(|h| h.id).collect();
    assert_eq!(ids, ["ws:2"]);
    assert_eq!(index.search("slack", None, usize::MAX, none)[0].id, "app:Slack");
}

#[test]
fn ties_go_by_kind_then_by_place() {
    let index = LauncherIndex::new(vec![
        Entry::menu("m", "Notes"),
        Entry::command("c", "Notes"),
        Entry::app("a2", "Notes"),
        Entry::app("a1", "Notes"),
    ]);
    let ids: Vec<String> = index.search("notes", None, usize::MAX, none).into_iter().map(|h| h.id).collect();
    assert_eq!(ids, ["a2", "a1", "c", "m"]);
}

/// The launcher answers a keystroke from memory (R-L12): 200 queries typed against an index of 2,000 entries,
/// each timed from the query string to the ranked list, under 8 ms at p90. It runs in the default (debug) test
/// build on purpose: on Parish1 (2026-11-17) that took p90 1.24 ms, and names prepared per keystroke took 9.44 ms
/// and fail it. Built optimized, as it ships, the index takes 0.16 ms and per-keystroke preparation 0.62 ms, both
/// far under the budget, so an optimized run would not catch that regression.
#[test]
fn two_hundred_queries_against_two_thousand_entries_stay_under_budget_at_p90() {
    const BUDGET_MS: f64 = 8.0;
    let names = latency_names(2_000);
    let index = LauncherIndex::new(
        names
            .iter()
            .enumerate()
            .map(|(i, n)| if i % 10 == 0 { Entry::command(format!("cmd:{i}"), n) } else { Entry::app(format!("app:{i}"), n) })
            .collect(),
    );
    let queries = latency_queries(&names, 200);
    assert_eq!(index.entries().len(), 2_000);
    assert_eq!(queries.len(), 200);
    for q in &queries[..20] {
        index.search(q, None, 50, none);
    }
    let mut ms = vec![];
    let mut found = 0;
    for q in &queries {
        let start = std::time::Instant::now();
        let hits = index.search(q, None, 50, none);
        ms.push(start.elapsed().as_secs_f64() * 1000.0);
        found += usize::from(!hits.is_empty());
    }
    ms.sort_by(f64::total_cmp);
    let (p50, p90, worst) = (ms[ms.len() / 2], ms[ms.len() * 9 / 10 - 1], ms[ms.len() - 1]);
    println!("launcher latency: p50 {p50:.2} ms, p90 {p90:.2} ms, max {worst:.2} ms over {} queries, {} entries", ms.len(), 2_000);
    // The queries come from the names, so nearly all of them find something.
    assert!(found > 180, "{found} of 200 queries found something");
    assert!(p90 < BUDGET_MS, "p90 {p90} ms over {BUDGET_MS} ms");
}

/// Names like a big desktop's: real app names, then made-up ones of two to four words.
fn latency_names(count: usize) -> Vec<String> {
    #[rustfmt::skip]
    let words = [
        "Adobe", "Photo", "Studio", "Code", "Pro", "Mail", "Proton", "Drive", "Music", "Video", "Player", "Notes",
        "Google", "Chrome", "Microsoft", "Word", "Excel", "Power", "Point", "Team", "Viewer", "Editor", "Manager",
        "Monitor", "Activity", "System", "Settings", "Font", "Book", "Book", "Image", "Capture", "Screen", "Shot",
        "Terminal", "Ghost", "Visual", "Remote", "Desktop", "Cloud", "Sync", "Backup", "Calendar", "Contacts", "Maps",
        "Weather", "Stocks", "Voice", "Memo", "Calc", "Disk", "Utility", "Archive", "Unarchiver", "Transmit", "Paw",
        "Proxy", "Kit", "Lab", "Café", "Über", "Résumé", "naïve", "XML", "JSON", "2025", "v3", "macOS", "iOS", "HD",
    ];
    let mut rng = Lcg(42);
    let mut out: Vec<String> = APPS.iter().chain(COMMANDS).map(|s| s.to_string()).collect();
    while out.len() < count {
        let n = 2 + rng.next(3);
        let picked: Vec<&str> = (0..n).map(|_| words[rng.next(words.len())]).collect();
        out.push(picked.join(if rng.next(5) == 0 { "-" } else { " " }));
    }
    out.truncate(count);
    out
}

/// What people type: the start of a name one letter at a time, initials, words typed apart, and a word with a
/// letter swapped.
fn latency_queries(names: &[String], count: usize) -> Vec<String> {
    let mut rng = Lcg(7);
    let mut out = vec![];
    while out.len() < count {
        let name = &names[rng.next(names.len())];
        let words: Vec<&str> = name.split([' ', '-']).filter(|w| !w.is_empty()).collect();
        match rng.next(4) {
            0 => {
                for n in 1..=name.chars().count().min(6) {
                    if out.len() < count {
                        out.push(name.chars().take(n).collect());
                    }
                }
            }
            1 => out.push(words.iter().filter_map(|w| w.chars().next()).collect()),
            2 => out.push(words.iter().map(|w| w.chars().take(3).collect::<String>()).collect::<Vec<_>>().join(" ")),
            _ => {
                // The first longest word, as Swift's max(by:) keeps.
                let longest = words.iter().fold(None, |a: Option<&str>, w| match a {
                    Some(b) if b.chars().count() >= w.chars().count() => Some(b),
                    _ => Some(w),
                });
                let mut w: Vec<char> = longest.unwrap_or(name).chars().collect();
                if w.len() >= 5 {
                    w.swap(2, 3);
                }
                out.push(w.into_iter().collect());
            }
        }
    }
    out
}

/// A tiny fixed generator, so every run times the same queries.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: usize) -> usize {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % bound as u64) as usize
    }
}
