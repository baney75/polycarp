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

/// The built-in themes `polycarp theme list --json` reports with an empty config folder.
fn listed_built_ins() -> BTreeSet<String> {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("docs-empty-cfg");
    let _ = std::fs::remove_dir_all(&dir);
    let out = Command::new(env!("CARGO_BIN_EXE_polycarp"))
        .args(["theme", "list", "--json"])
        .env("POLYCARP_CONFIG_DIR", &dir)
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    v["data"]["themes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["source"] == "built-in")
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_guide_and_theme_list_name_the_same_built_ins() {
    let code = listed_built_ins();
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
    assert_eq!(code, docs, "docs/guide.md and `theme list` disagree");
    // The themes folder ships the same files.
    let mut files = BTreeSet::new();
    for file in std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../themes")).unwrap()
    {
        let name = file.unwrap().file_name().to_string_lossy().into_owned();
        if let Some(theme) = name.strip_suffix(".toml") {
            files.insert(theme.to_string());
        }
    }
    assert_eq!(code, files, "themes/ and `theme list` disagree");
}

/// The rows of the markdown table that follows `header`, as lists of cells.
fn table_rows(text: &str, header: &str) -> Vec<Vec<String>> {
    text.split(header)
        .nth(1)
        .unwrap_or_else(|| panic!("no table headed {header}"))
        .lines()
        .skip(2)
        .take_while(|l| l.starts_with('|'))
        .map(|l| {
            l.trim_matches('|')
                .split(" | ")
                .map(|c| c.trim().to_string())
                .collect()
        })
        .collect()
}

/// Every backticked piece of text in `cell`.
fn backticked(cell: &str) -> Vec<String> {
    cell.split('`')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn the_command_table_and_help_list_the_same_commands_both_ways() {
    let code = from_usage(&help(&["--help"]), "polycarp");
    assert!(code.len() >= 8, "{code:?}");
    let docs: BTreeSet<String> = table_rows(&guide(), "| Command | What it does |")
        .iter()
        .flat_map(|row| backticked(&row[0]))
        .filter_map(|c| {
            c.strip_prefix("polycarp ")
                .and_then(|r| r.split_whitespace().next())
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        code, docs,
        "the command table and `polycarp --help` disagree"
    );
}

#[test]
fn the_mcp_table_names_every_served_tool_and_nothing_else() {
    let served = served_tools();
    let docs: BTreeSet<String> = table_rows(&guide(), "| Tool | Use it to |")
        .iter()
        .flat_map(|row| backticked(&row[0]))
        .collect();
    assert_eq!(served, docs, "the MCP table and tools/list disagree");
}

#[test]
fn every_flag_in_a_guide_example_is_in_that_commands_usage() {
    let usage = help(&["theme", "--help"]);
    let guide = guide();
    let mut in_block = false;
    let mut checked = 0;
    for line in guide.lines() {
        if line.starts_with("```") {
            in_block = !in_block;
            continue;
        }
        let Some(rest) = line
            .trim()
            .strip_prefix("polycarp theme ")
            .filter(|_| in_block)
        else {
            continue;
        };
        let mut words = rest.split_whitespace();
        let sub = words.next().unwrap();
        let usage_line = usage
            .lines()
            .find(|l| {
                let l = l.trim();
                l == format!("polycarp theme {sub}")
                    || l.starts_with(&format!("polycarp theme {sub} "))
            })
            .unwrap_or_else(|| panic!("the guide runs `polycarp theme {sub}`, which has no usage"));
        for flag in words.filter(|w| w.starts_with("--")) {
            checked += 1;
            assert!(
                usage_line.contains(flag),
                "the guide uses {flag} with `theme {sub}`, but its usage is: {usage_line}"
            );
        }
    }
    assert!(checked >= 4, "only {checked} flags were checked");
}
