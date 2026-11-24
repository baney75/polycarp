//! `polycarp agent connect <client>`: the exact setup for each assistant.
//!
//! - claude-code and codex run on this machine, so they get the stdio server (`polycarp agent serve --stdio`): no
//!   port, no token, the owner's own process.
//! - grokbot gets the stdio entry for `~/.grok/config.toml` (the form magnus-singularity's client adapter writes,
//!   checked with `grok mcp doctor`), or, with --tailnet, the URL form for a Grok Bot on another of the owner's devices.
//! - claude.ai, chatgpt and grok.com run in their makers' clouds, so they need a public tunnel (the person's own) and
//!   OAuth.
//!
//! Nothing here prints a token: where one is needed, it says which command makes it.

use super::policy::Route;
use super::store::{self, Tunnel};
use std::fs;
use std::path::{Path, PathBuf};

pub const CLIENTS: [&str; 6] = [
    "claude-code",
    "codex",
    "grokbot",
    "claude.ai",
    "chatgpt",
    "grok.com",
];

pub struct Ctx<'a> {
    pub exe: PathBuf,
    pub dir: &'a Path,
    pub port: u16,
    pub home: Option<PathBuf>,
    /// This device's MagicDNS name, for --tailnet.
    pub tailnet_name: Option<String>,
}

fn exe_str(c: &Ctx) -> String {
    c.exe.display().to_string()
}

pub fn claude_code_argv(c: &Ctx) -> Vec<String> {
    vec![
        "mcp".into(),
        "add".into(),
        "--scope".into(),
        "user".into(),
        "polycarp".into(),
        "--".into(),
        exe_str(c),
        "agent".into(),
        "serve".into(),
        "--stdio".into(),
    ]
}

/// A TOML string.
fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

pub fn stdio_toml(c: &Ctx) -> String {
    format!(
        "[mcp_servers.polycarp]\ncommand = {}\nargs = [\"agent\", \"serve\", \"--stdio\"]\n",
        q(&exe_str(c))
    )
}

pub fn codex_config(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
        .join("config.toml")
}

/// Adds the polycarp entry to a TOML config, keeping everything else. Refuses a file that isn't valid TOML, and an
/// existing polycarp entry that says something else (that one is the person's to change).
pub fn add_entry(path: &Path, entry: &str) -> Result<&'static str, String> {
    let original = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let doc: toml::Value = toml::from_str(&original).map_err(|e| {
        format!(
            "{} isn't valid TOML, so it was left alone: {e}",
            path.display()
        )
    })?;
    let want: toml::Value = toml::from_str(entry).map_err(|e| e.to_string())?;
    if let Some(have) = doc.get("mcp_servers").and_then(|m| m.get("polycarp")) {
        if Some(have) == want.get("mcp_servers").and_then(|m| m.get("polycarp")) {
            return Ok("already there");
        }
        return Err(format!(
            "{} already has a different [mcp_servers.polycarp]. Replace it by hand with:\n{entry}",
            path.display()
        ));
    }
    let mut updated = original.trim_end().to_string();
    if !updated.is_empty() {
        updated.push_str("\n\n");
    }
    updated.push_str(entry);
    toml::from_str::<toml::Value>(&updated)
        .map_err(|e| format!("the result wouldn't be valid TOML: {e}"))?;
    let dir = path.parent().ok_or("a config needs a folder")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".config.toml.polycarp.{}", std::process::id()));
    fs::write(&tmp, &updated).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save {}: {e}", path.display())
    })?;
    Ok("added")
}

/// The public MCP URL for a web assistant, or why there is none yet.
pub fn public_url(c: &Ctx) -> Result<String, String> {
    let Some(t) = Tunnel::load(c.dir) else {
        return Err(
            "A web assistant runs in its maker's cloud, so it needs a public address for this Mac. You bring your \
own: `polycarp agent tunnel cloudflare --hostname <name on your Cloudflare domain>` or `polycarp agent tunnel \
tailscale --public`. Then run this again."
                .into(),
        );
    };
    let route = t.route().ok_or("tunnel.json names an unknown kind")?;
    if route == Route::TailscaleServe {
        return Err(format!(
            "{} is Tailscale Serve, which only your own devices can reach; a web assistant's servers can't. Use \
`polycarp agent tunnel tailscale --public` (Funnel) or `polycarp agent tunnel cloudflare --hostname <name>`.",
            t.public_url
        ));
    }
    Ok(format!("{}/mcp", t.public_url.trim_end_matches('/')))
}

const APPROVE: &str = "When you connect, the assistant opens a Polycarp page with a code like ABCD-EFGH. Nothing is \
shared until you run `polycarp agent approve ABCD-EFGH` on this Mac (add `--scopes read,files,act` to give more than \
read). `polycarp agent clients` lists what you approved; `polycarp agent revoke <id>` ends one.";

/// The text `connect` prints for a client. `tailnet` asks for the URL form (grokbot).
pub fn instructions(c: &Ctx, client: &str, tailnet: bool) -> Result<String, String> {
    let lines = match client {
        "claude-code" => format!(
            "Claude Code on this Mac runs Polycarp over stdio, with every scope (it is your own process). Run:\n\n  \
claude {}\n\nor `polycarp agent connect claude-code --run` to run it for you. Check with `claude mcp list`.",
            claude_code_argv(c)
                .iter()
                .map(|a| if a.contains(' ') { q(a) } else { a.clone() })
                .collect::<Vec<_>>()
                .join(" ")
        ),
        "codex" => {
            let path = c.home.as_deref().map(codex_config).unwrap_or_else(|| PathBuf::from("~/.codex/config.toml"));
            format!(
                "Codex on this Mac runs Polycarp over stdio. Add this to {}:\n\n{}\nor run `polycarp agent connect codex --write` to add it for you (the rest of the file is kept).",
                path.display(),
                stdio_toml(c)
            )
        }
        "grokbot" if tailnet => {
            let host = c.tailnet_name.clone().unwrap_or_else(|| "<this-mac>.<tailnet>.ts.net".into());
            format!(
                "For a Grok Bot on another of your devices. On this Mac, turn on the tailnet listener \
(`polycarp agent serve --tailnet`, or `tailnet = true` in {}) and make it a token:\n\n  \
polycarp agent token create --name grokbot --scopes read,act\n\nThen on the Grok Bot's device add this to \
~/.grok/config.toml, with that token in place of <token>:\n\n[mcp_servers.polycarp]\nurl = \"http://{host}:{}/mcp\"\n\
headers = {{ \"Authorization\" = \"Bearer <token>\" }}\n\nOnly your own devices get past whois; check with `grok mcp doctor polycarp`.",
                c.dir.join(store::SETTINGS_FILE).display(),
                c.port
            )
        }
        "grokbot" => format!(
            "Grok Bot on this Mac runs Polycarp over stdio. Add this to ~/.grok/config.toml (Grok's own config; the \
same form magnus-singularity writes for its servers):\n\n{}\nthen start a new session and check with `grok mcp doctor \
polycarp`. For a Grok Bot on another device, run `polycarp agent connect grokbot --tailnet`.",
            stdio_toml(c)
        ),
        "claude.ai" => {
            let url = public_url(c)?;
            format!(
                "In claude.ai: Settings > Connectors > Add custom connector.\n  Name: Polycarp\n  Remote MCP server URL: \
{url}\n  Leave the OAuth client fields empty: Claude registers itself.\nThen click Connect.\n\n{APPROVE}"
            )
        }
        "chatgpt" => {
            let url = public_url(c)?;
            format!(
                "In ChatGPT: Settings > Apps & Connectors > Advanced settings, turn on Developer mode. Then Settings > \
Apps & Connectors > Create.\n  Name: Polycarp\n  MCP server URL: {url}\n  Authentication: OAuth\nTrust the \
connector, then Create and connect.\n\n{APPROVE}"
            )
        }
        "grok.com" => {
            let url = public_url(c)?;
            format!(
                "On grok.com: open Connectors (grok.com/connectors), then New Connector > Custom.\n  Name: Polycarp\n  \
Server URL: {url}\n  Authentication: OAuth\nThen connect.\n\n{APPROVE}"
            )
        }
        other => {
            return Err(format!(
                "unknown client {other:?}: one of {}",
                CLIENTS.join(", ")
            ))
        }
    };
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(dir: &Path) -> Ctx<'_> {
        Ctx {
            exe: PathBuf::from("/Users/d/.local/bin/polycarp"),
            dir,
            port: 41772,
            home: Some(PathBuf::from("/Users/d")),
            tailnet_name: Some("mac.tail1234.ts.net".into()),
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pc-agent-connect-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn local_clients_get_the_stdio_server() {
        let d = temp("local");
        let c = ctx(&d);
        let cc = instructions(&c, "claude-code", false).unwrap();
        assert!(cc.contains("claude mcp add --scope user polycarp -- /Users/d/.local/bin/polycarp agent serve --stdio"), "{cc}");
        let cx = instructions(&c, "codex", false).unwrap();
        assert!(cx.contains("[mcp_servers.polycarp]\ncommand = \"/Users/d/.local/bin/polycarp\"\nargs = [\"agent\", \"serve\", \"--stdio\"]"), "{cx}");
        let g = instructions(&c, "grokbot", false).unwrap();
        assert!(g.contains("~/.grok/config.toml") && g.contains("grok mcp doctor polycarp"));
        let g = instructions(&c, "grokbot", true).unwrap();
        assert!(
            g.contains("url = \"http://mac.tail1234.ts.net:41772/mcp\""),
            "{g}"
        );
        assert!(g.contains("Bearer <token>") && !g.contains("pct_"));
        assert!(instructions(&c, "cursor", false)
            .unwrap_err()
            .contains("claude-code"));
    }

    #[test]
    fn web_assistants_need_a_public_tunnel_of_your_own() {
        let d = temp("web");
        for client in ["claude.ai", "chatgpt", "grok.com"] {
            let e = instructions(&ctx(&d), client, false).unwrap_err();
            assert!(
                e.contains("bring") && e.contains("tunnel cloudflare"),
                "{e}"
            );
        }
        let t = |kind: &str| Tunnel {
            kind: kind.into(),
            public_url: "https://agent.example.com".into(),
            host: "agent.example.com".into(),
            name: None,
            created: 1,
        };
        store::write_json(&d.join(store::TUNNEL_FILE), &t("tailscale")).unwrap();
        assert!(instructions(&ctx(&d), "claude.ai", false)
            .unwrap_err()
            .contains("only your own devices"));
        store::write_json(&d.join(store::TUNNEL_FILE), &t("cloudflare")).unwrap();
        let ok = instructions(&ctx(&d), "claude.ai", false).unwrap();
        assert!(
            ok.contains("https://agent.example.com/mcp")
                && ok.contains("Add custom connector")
                && ok.contains("polycarp agent approve")
        );
        assert!(instructions(&ctx(&d), "chatgpt", false)
            .unwrap()
            .contains("Developer mode"));
        assert!(instructions(&ctx(&d), "grok.com", false)
            .unwrap()
            .contains("New Connector"));
    }

    #[test]
    fn the_codex_entry_is_added_once_and_the_rest_of_the_file_is_kept() {
        let d = temp("codex");
        let p = d.join("config.toml");
        let c = ctx(&d);
        fs::write(
            &p,
            "model = \"gpt-6\"\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .unwrap();
        assert_eq!(add_entry(&p, &stdio_toml(&c)).unwrap(), "added");
        assert_eq!(add_entry(&p, &stdio_toml(&c)).unwrap(), "already there");
        let v: toml::Value = toml::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["model"].as_str(), Some("gpt-6"));
        assert_eq!(v["mcp_servers"]["other"]["command"].as_str(), Some("x"));
        assert_eq!(
            v["mcp_servers"]["polycarp"]["args"][2].as_str(),
            Some("--stdio")
        );
        let other = Ctx {
            exe: PathBuf::from("/elsewhere/polycarp"),
            ..ctx(&d)
        };
        assert!(add_entry(&p, &stdio_toml(&other))
            .unwrap_err()
            .contains("different"));
        fs::write(&p, "not = [valid").unwrap();
        assert!(add_entry(&p, &stdio_toml(&c))
            .unwrap_err()
            .contains("left alone"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "not = [valid");
    }
}
