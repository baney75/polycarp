//! The guide on the website comes from docs/guide.md. It and the product must list the same
//! commands, MCP tools and built-in themes, in both directions, so neither can drift.
use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn guide() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/guide.md");
    std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

fn help(args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_polycarp"))
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The word after `prefix ` on each usage line.
fn from_usage(usage: &str, prefix: &str) -> BTreeSet<String> {
    usage
        .lines()
        .filter_map(|l| {
            l.trim()
                .strip_prefix(&format!("{prefix} "))
                .map(str::to_string)
        })
        .filter_map(|rest| rest.split_whitespace().next().map(str::to_string))
        .collect()
}

fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Every whole word that follows `prefix ` anywhere in the text.
fn words_after(text: &str, prefix: &str) -> BTreeSet<String> {
    let lead = format!("{prefix} ");
    text.match_indices(&lead)
        .map(|(at, _)| {
            text[at + lead.len()..]
                .chars()
                .take_while(|c| word_char(*c))
                .collect::<String>()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

#[test]
fn the_guide_and_the_command_list_the_same_theme_commands() {
    let code = from_usage(&help(&["theme", "--help"]), "polycarp theme");
    let docs = words_after(&guide(), "polycarp theme");
    assert!(code.len() >= 15, "{code:?}");
    let code: BTreeSet<String> = code.into_iter().filter(|w| !w.starts_with('<')).collect();
    let docs: BTreeSet<String> = docs.into_iter().filter(|w| !w.starts_with('-')).collect();
    assert_eq!(
        code, docs,
        "docs/guide.md and `polycarp theme --help` disagree"
    );
}

#[test]
fn the_guide_covers_every_top_level_command() {
    let guide = guide();
    let code = from_usage(&help(&["--help"]), "polycarp");
    assert!(code.len() >= 6, "{code:?}");
    for word in code {
        assert!(
            guide.contains(&format!("polycarp {word}")),
            "docs/guide.md never mentions `polycarp {word}`"
        );
    }
}

/// The names a real server returns from tools/list.
fn served_tools() -> BTreeSet<String> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_polycarp"))
        .arg("mcp")
        .env(
            "POLYCARP_CONFIG_DIR",
            Path::new(env!("CARGO_TARGET_TMPDIR")).join("docs-cfg"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-06-18","capabilities":{{}},"clientInfo":{{"name":"docs-test","version":"1"}}}}}}"#).unwrap();
    writeln!(input, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list"}}"#).unwrap();
    drop(input);
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let list = text
        .lines()
        .find(|l| l.contains(r#""id":2"#))
        .expect("a tools/list answer");
    let value: serde_json::Value = serde_json::from_str(list).unwrap();
    value["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_guide_and_the_server_list_the_same_mcp_tools() {
    let code = served_tools();
    assert!(code.len() >= 15, "{code:?}");
    let guide = guide();
    let docs: BTreeSet<String> = guide
        .match_indices("theme_")
        .map(|(at, _)| guide[at..].chars().take_while(|c| word_char(*c)).collect())
        .collect();
    assert_eq!(code, docs, "docs/guide.md and tools/list disagree");
}

#[test]
fn the_guide_and_the_themes_folder_list_the_same_built_ins() {
    let mut code = BTreeSet::new();
    for file in std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../themes")).unwrap()
    {
        let name = file.unwrap().file_name().to_string_lossy().into_owned();
        if let Some(theme) = name.strip_suffix(".toml") {
            code.insert(theme.to_string());
        }
    }
    assert!(code.len() >= 6, "{code:?}");
    let guide = guide();
    let table = guide
        .split("| Theme | What it's like |")
        .nth(1)
        .expect("the themes table");
    let docs: BTreeSet<String> = table
        .lines()
        .skip(2)
        .take_while(|l| l.starts_with('|'))
        .filter_map(|l| l.split('`').nth(1).map(str::to_string))
        .collect();
    assert_eq!(code, docs, "docs/guide.md and themes/ disagree");
}
