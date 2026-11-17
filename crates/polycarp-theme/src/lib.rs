//! The Polycarp theme format: the schema, the checks, contrast, resolving `extends` and per-product
//! overrides, and the `theme.json` and CSS text products read. It writes no files and takes no lock;
//! the `polycarp theme` command does that, so every write goes through one place.

mod code;
mod contrast;
mod export;
mod resolve;
pub mod schema;
mod validate;

pub use code::{
    code_keys, code_pairs, code_problems, derive, fit, mix, Code, CODE, DIFF, SYNTAX, TERMINAL,
};
pub use contrast::{combine, contrast, contrast_on, pairs, Colors, MARK_MIN, TEXT_MIN};
pub use export::{color_lines, css, json_of, resolved_json, shared_vars, theme_json, SCHEMA};
pub use resolve::{
    apply_accents, code_of, colors_of, ext_of, is_builtin, load_raw, merge, parse_toml,
    read_theme_file, resolve_doc, resolve_name, without_meta, Full, Motion, Resolved, Shape,
    Themes, Typo,
};
pub use validate::{check_doc, check_easing, check_font, check_value, is_hex, valid_name};

/// The built-in themes, by name, as the TOML text in `themes/`.
pub const BUILTINS: &[(&str, &str)] = &[
    ("polycarp", include_str!("../../../themes/polycarp.toml")),
    (
        "still-water",
        include_str!("../../../themes/still-water.toml"),
    ),
    ("evening", include_str!("../../../themes/evening.toml")),
    ("parchment", include_str!("../../../themes/parchment.toml")),
    ("blocks", include_str!("../../../themes/blocks.toml")),
    ("calm", include_str!("../../../themes/calm.toml")),
    ("gruvbox", include_str!("../../../themes/gruvbox.toml")),
    (
        "catppuccin",
        include_str!("../../../themes/catppuccin.toml"),
    ),
    (
        "everforest",
        include_str!("../../../themes/everforest.toml"),
    ),
];

pub const DEFAULT_THEME: &str = "polycarp";
pub const SURFACES: [&str; 5] = ["spaces", "voice", "browser", "site", "studio"];
pub const SECTIONS: [&str; 5] = ["light", "dark", "shape", "type", "motion"];
pub const MODES: [&str; 2] = ["light", "dark"];
pub const MAX_DEPTH: usize = 8;
pub const ROLES: [&str; 13] = [
    "background",
    "surface",
    "sunken",
    "foreground",
    "strong",
    "muted",
    "border",
    "accent",
    "on_accent",
    "selection",
    "urgent",
    "working",
    "done",
];

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum Kind {
    Hex,
    Int(i64, i64),
    Float(f64, f64),
    Enum(&'static [&'static str]),
    Font,
    Easing,
    Bool,
}

pub const SHAPE: &[(&str, Kind)] = &[
    ("radius_small", Kind::Int(0, 64)),
    ("radius", Kind::Int(0, 64)),
    ("radius_large", Kind::Int(0, 64)),
    ("border_width", Kind::Int(0, 8)),
    ("blur", Kind::Int(0, 80)),
    ("shadow", Kind::Float(0.0, 1.0)),
    ("density", Kind::Enum(&["compact", "regular", "spacious"])),
    ("indicator", Kind::Enum(&["dot", "bar", "number-block"])),
];
pub const TYPE: &[(&str, Kind)] = &[
    ("display", Kind::Font),
    ("ui", Kind::Font),
    ("mono", Kind::Font),
    ("size", Kind::Int(10, 24)),
    ("weight", Kind::Int(300, 800)),
    ("line_height", Kind::Float(1.0, 2.0)),
];
pub const MOTION: &[(&str, Kind)] = &[
    ("fast", Kind::Int(0, 1000)),
    ("normal", Kind::Int(0, 1000)),
    ("slow", Kind::Int(0, 1000)),
    ("easing", Kind::Easing),
    ("scale_from", Kind::Float(0.5, 1.0)),
    ("reduced", Kind::Bool),
];

pub fn fields(section: &str) -> Vec<(&'static str, Kind)> {
    match section {
        "light" | "dark" => ROLES.iter().map(|r| (*r, Kind::Hex)).collect(),
        "shape" => SHAPE.to_vec(),
        "type" => TYPE.to_vec(),
        "motion" => MOTION.to_vec(),
        g => code_keys(g).iter().map(|k| (*k, Kind::Hex)).collect(),
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/// The choice `config.toml` holds: which theme, which mode and any accent overrides.
#[derive(Clone, PartialEq, Debug)]
pub struct State {
    pub theme: String,
    pub mode: String,
    pub accent_light: Option<String>,
    pub accent_dark: Option<String>,
    /// False after `theme off`: the files in `current/` are removed.
    pub enabled: bool,
}

impl State {
    pub fn default_state() -> State {
        State {
            theme: DEFAULT_THEME.into(),
            mode: "auto".into(),
            accent_light: None,
            accent_dark: None,
            enabled: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrast_black_white_is_21() {
        assert!((contrast("#000000", "#ffffff") - 21.0).abs() < 1e-9);
    }

    #[test]
    fn names() {
        assert!(valid_name("still-water"));
        assert!(!valid_name("Still"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("-x"));
        assert!(!valid_name(""));
        for r in ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"] {
            assert!(!valid_name(r), "{r}");
        }
        for ok in ["com", "com0", "com10", "lpt", "console", "my-con", "aux2"] {
            assert!(valid_name(ok), "{ok}");
        }
    }

    #[test]
    fn every_field_in_the_code_has_a_description() {
        for path in schema::described_paths() {
            assert!(
                !schema::describe(&path).trim().is_empty(),
                "{path} has no description in schema::describe"
            );
        }
        for sec in SECTIONS {
            for (k, _) in fields(sec) {
                let path = if MODES.contains(&sec) {
                    format!("color.{k}")
                } else {
                    format!("{sec}.{k}")
                };
                assert!(!schema::describe(&path).is_empty(), "{path}");
            }
        }
    }

    // --- a small matcher for the JSON Schema patterns, so no regex crate is needed ------------

    #[derive(Debug)]
    enum Item {
        Range(char, char),
        Space,
        Digit,
        Letter,
        Number,
        Control,
    }

    #[derive(Debug)]
    enum Node {
        Char(char),
        Any,
        Class(Vec<Item>, bool),
        Alt(Vec<Vec<Node>>),
        NotAhead(Vec<Vec<Node>>),
        Rep(Box<Node>, usize, usize),
        Start,
        End,
        Space,
        Digit,
    }

    fn item_has(items: &[Item], neg: bool, c: char) -> bool {
        let hit = items.iter().any(|i| match i {
            Item::Range(a, b) => (*a..=*b).contains(&c),
            Item::Space => c.is_whitespace(),
            Item::Digit => c.is_ascii_digit(),
            Item::Letter => c.is_alphabetic(),
            Item::Number => c.is_numeric(),
            Item::Control => c.is_control(),
        });
        hit != neg
    }

    fn parse_escape(p: &[char], at: &mut usize) -> Item {
        let c = p[*at];
        *at += 1;
        match c {
            's' => Item::Space,
            'd' => Item::Digit,
            'p' => {
                assert_eq!(p[*at], '{');
                let end = p[*at..].iter().position(|c| *c == '}').unwrap() + *at;
                let name: String = p[*at + 1..end].iter().collect();
                *at = end + 1;
                match name.as_str() {
                    "L" => Item::Letter,
                    "N" => Item::Number,
                    "Cc" => Item::Control,
                    other => panic!("matcher does not know \\p{{{other}}}"),
                }
            }
            c => Item::Range(c, c),
        }
    }

    fn parse_alts(p: &[char], at: &mut usize) -> Vec<Vec<Node>> {
        let mut alts = vec![Vec::new()];
        while *at < p.len() && p[*at] != ')' {
            let c = p[*at];
            *at += 1;
            let node = match c {
                '|' => {
                    alts.push(Vec::new());
                    continue;
                }
                '^' => Node::Start,
                '$' => Node::End,
                '.' => Node::Any,
                '(' => {
                    let look = p[*at..].starts_with(&['?', '!']);
                    assert!(look || p[*at..].starts_with(&['?', ':']), "group kind");
                    *at += 2;
                    let inner = parse_alts(p, at);
                    *at += 1;
                    if look {
                        Node::NotAhead(inner)
                    } else {
                        Node::Alt(inner)
                    }
                }
                '[' => {
                    let neg = p[*at] == '^';
                    if neg {
                        *at += 1;
                    }
                    let mut items = Vec::new();
                    while p[*at] != ']' {
                        let item = if p[*at] == '\\' {
                            *at += 1;
                            parse_escape(p, at)
                        } else {
                            *at += 1;
                            Item::Range(p[*at - 1], p[*at - 1])
                        };
                        match (&item, p.get(*at), p.get(*at + 1)) {
                            (Item::Range(a, _), Some('-'), Some(z)) if *z != ']' => {
                                let (a, z) = (*a, *z);
                                *at += 2;
                                items.push(Item::Range(a, z));
                            }
                            _ => items.push(item),
                        }
                    }
                    *at += 1;
                    Node::Class(items, neg)
                }
                '\\' => match parse_escape(p, at) {
                    Item::Space => Node::Space,
                    Item::Digit => Node::Digit,
                    Item::Range(c, _) => Node::Char(c),
                    other => panic!("{other:?} outside a class"),
                },
                c => Node::Char(c),
            };
            let (lo, hi) = match p.get(*at) {
                Some('*') => (0, usize::MAX),
                Some('+') => (1, usize::MAX),
                Some('?') => (0, 1),
                _ => {
                    alts.last_mut().unwrap().push(node);
                    continue;
                }
            };
            *at += 1;
            alts.last_mut()
                .unwrap()
                .push(Node::Rep(Box::new(node), lo, hi));
        }
        alts
    }

    /// Does `seq` match at `i`, and then does the rest `k` match?
    fn run(seq: &[Node], t: &[char], i: usize, k: &dyn Fn(usize) -> bool) -> bool {
        let Some((head, tail)) = seq.split_first() else {
            return k(i);
        };
        let next = |j: usize| run(tail, t, j, k);
        match head {
            Node::Start => i == 0 && next(i),
            Node::End => i == t.len() && next(i),
            Node::Char(c) => t.get(i) == Some(c) && next(i + 1),
            Node::Any => i < t.len() && next(i + 1),
            Node::Space => t.get(i).is_some_and(|c| c.is_whitespace()) && next(i + 1),
            Node::Digit => t.get(i).is_some_and(|c| c.is_ascii_digit()) && next(i + 1),
            Node::Class(items, neg) => {
                t.get(i).is_some_and(|c| item_has(items, *neg, *c)) && next(i + 1)
            }
            Node::Alt(alts) => alts.iter().any(|a| run(a, t, i, &next)),
            Node::NotAhead(alts) => !alts.iter().any(|a| run(a, t, i, &|_| true)) && next(i),
            Node::Rep(n, lo, hi) => rep(n, *lo, *hi, 0, t, i, &next),
        }
    }

    fn rep(
        n: &Node,
        lo: usize,
        hi: usize,
        done: usize,
        t: &[char],
        i: usize,
        k: &dyn Fn(usize) -> bool,
    ) -> bool {
        if done < hi {
            let more = |j: usize| j > i && rep(n, lo, hi, done + 1, t, j, k);
            if run(std::slice::from_ref(n), t, i, &more) {
                return true;
            }
        }
        done >= lo && k(i)
    }

    fn pattern_matches(pattern: &str, text: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let mut at = 0;
        let alts = parse_alts(&p, &mut at);
        assert_eq!(at, p.len(), "unbalanced pattern");
        let t: Vec<char> = text.chars().collect();
        alts.iter().any(|a| run(a, &t, 0, &|_| true))
    }

    #[test]
    fn the_schema_font_and_easing_patterns_agree_with_the_checkers() {
        let font = schema::kind_schema(Kind::Font)["pattern"]
            .as_str()
            .unwrap()
            .to_string();
        for s in [
            "Georgia, serif",
            "\"Times New Roman\", serif",
            "'Helvetica Neue', Arial",
            "Noto Sans JP",
            "日本語フォント, serif",
            "Straße, Ünïcode",
            "a b-c_d",
            "_x, -y",
            "a  ,  b",
            " Arial ",
            "",
            " ",
            "a, ,b",
            "a,",
            ",a",
            "\"\"",
            "\" \"",
            "a;b",
            "url(x)",
            "a(b)",
            "a{b}",
            "a/b",
            "Arial, \"x/*y\"",
            "Arial /* c */",
            "\"a\\b\"",
            "\"a<b\"",
            "\"a'b\"",
            "'a\"b'",
            "\"a\nb\"",
            "a\tb",
            "a\u{7}",
            "\"a\" b",
            "\"open",
            "'x', \"y\", z",
            "a\"b",
            "a<b",
        ] {
            assert_eq!(
                check_font(s).is_ok(),
                pattern_matches(&font, s),
                "font {s:?}: check_font says {:?}",
                check_font(s)
            );
        }
        let easing = schema::kind_schema(Kind::Easing)["pattern"]
            .as_str()
            .unwrap()
            .to_string();
        for s in [
            "ease",
            "linear",
            "ease-in",
            "ease-out",
            "ease-in-out",
            "Ease",
            "ease ",
            "cubic-bezier(0.3, 0, 0.2, 1)",
            "cubic-bezier(.3,0,.2,1)",
            "cubic-bezier(1.,0,0,1)",
            "cubic-bezier(1e0,0,0,1)",
            "cubic-bezier(0.5,-1,0.5,2)",
            "cubic-bezier(+0.5,-1,0.5,2)",
            "cubic-bezier( 0 , 0 , 1 , 1 )",
            "cubic-bezier(a,b,c,d)",
            "cubic-bezier(x,0,0,1)",
            "cubic-bezier(1,2,3)",
            "cubic-bezier(1,2,3,4,5)",
            "cubic-bezier(--1,0,0,1)",
            "cubic-bezier(0.5 0.5, 1, 1)",
            "cubic-bezier(0,0,0,1) ",
            "cubic-bezier(0,0,0,1",
            "cubic-bezier(1,2,3,(4))",
            "cubic-bezier(,,,)",
            "cubic-bezier(0,0,0,.)",
            // The pattern leaves the 0 to 1 limit on the x values to the checker.
            "cubic-bezier(2,0,0,1)",
            "cubic-bezier(0,0,-1,1)",
        ] {
            let ok = check_easing(s);
            let matched = pattern_matches(&easing, s);
            let range_only = matched && ok.as_ref().err().is_some_and(|e| e.contains("x values"));
            assert!(
                ok.is_ok() == matched || range_only,
                "easing {s:?}: checker {ok:?}, pattern {matched}"
            );
        }
        // The matcher itself can say no.
        assert!(!pattern_matches(&font, "a;b"));
        assert!(pattern_matches(&font, "Georgia, serif"));
    }
}
