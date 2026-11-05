//! The guide on the website comes from docs/guide.md. It must cover everything the command can do.
use std::path::Path;
use std::process::Command;

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

/// `polycarp <word>` or `polycarp theme <word>` for every line of a usage block.
fn commands(usage: &str, prefix: &str) -> Vec<String> {
    usage
        .lines()
        .filter_map(|l| {
            l.trim()
                .strip_prefix(&format!("{prefix} "))
                .map(str::to_string)
        })
        .filter_map(|rest| rest.split_whitespace().next().map(str::to_string))
        .map(|w| format!("{prefix} {w}"))
        .collect()
}

#[test]
fn the_guide_covers_every_command() {
    let guide = guide();
    let top = commands(&help(&["--help"]), "polycarp");
    let theme = commands(&help(&["theme", "--help"]), "polycarp theme");
    assert!(top.len() >= 6, "{top:?}");
    assert!(theme.len() >= 15, "{theme:?}");
    for command in top.iter().chain(&theme) {
        assert!(
            guide.contains(command),
            "docs/guide.md never mentions `{command}`"
        );
    }
}

#[test]
fn the_guide_covers_every_mcp_tool_and_built_in_theme() {
    let guide = guide();
    let source =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp.rs")).unwrap();
    let tools: Vec<&str> = source
        .split("name: \"")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .filter(|n| n.starts_with("theme_"))
        .collect();
    assert!(tools.len() >= 15, "{tools:?}");
    for tool in tools {
        assert!(
            guide.contains(tool),
            "docs/guide.md never mentions `{tool}`"
        );
    }
    for file in std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../themes")).unwrap()
    {
        let name = file.unwrap().file_name().to_string_lossy().into_owned();
        if let Some(theme) = name.strip_suffix(".toml") {
            assert!(
                guide.contains(&format!("`{theme}`")),
                "docs/guide.md never mentions `{theme}`"
            );
        }
    }
}
