//! `polycarp mcp`: the theme commands as MCP tools over stdio.
//!
//! JSON-RPC 2.0, one message per line. Each tool calls the same `op_*` function the command line
//! calls and returns the same envelope, so the two cannot drift.

use crate::theme::{self, ApiErr, Ctx};
use serde_json::{json, Map, Value as Json};
use std::ffi::OsString;
use std::io::{BufRead, Write};

const LATEST: &str = "2025-06-18";
const KNOWN: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "\
Polycarp themes: one theme file drives every Polycarp product and the website. Use these tools to \
customize them for the person you are helping.

Workflow:
1. Read theme_schema (every field, range, enum and contrast rule) and theme_current (what is in force).
2. Make the smallest change that does it: theme_change for one value, theme_apply for a whole theme \
(use `extends` and list only what changes), theme_accent for the brand color. Remove a theme you made \
and no longer need with theme_delete. Use a [surface.*] section \
only when one product should differ.
3. If a call is refused, read error.data.errors (each has a path; contrast errors give actual and needs) \
and adjust the colors. Do not try to get around the contrast rules.
4. Call theme_preview and show the person the HTML file (open it and take a screenshot).
5. If they dislike it, call theme_undo. theme_reset always works (it also turns the theme on, with the default). \
Also: if the person wants the apps' own look back, use `theme_off`.
Every result is {ok, data} or {ok:false, error:{code, message, suggestion, data:{errors}}}.";

fn obj(props: Json, required: &[&str]) -> Json {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

struct Tool {
    name: &'static str,
    description: &'static str,
    schema: Json,
    read_only: bool,
    /// For a tool that is not read-only: does it replace or remove something that was there?
    destructive: bool,
    /// Does calling it again with the same input change nothing more?
    idempotent: bool,
}

fn tools() -> Vec<Tool> {
    let name = json!({"type":"string","description":"A theme name from theme_list. Leave out for the current theme."});
    let surface = json!({"type":"string","enum":["spaces","voice","browser","site"],
        "description":"One product: spaces (BaneySpaces), voice (Silas), browser (Tabkyra) or site. Leave out for the theme without product overrides."});
    let theme_doc = json!({"type":["object","string"],
        "description":"The whole theme: a JSON object, or a string of TOML or JSON. Same shape as theme_schema. Use `extends` and list only what changes."});
    vec![
        Tool {
            name: "theme_schema",
            description: "Read this first. Returns the JSON Schema (draft 2020-12) for a theme: every field, with a plain description of what it colors or controls and where it shows, its range or choices, the contrast rules, and the path form used by theme_get and theme_change. Use it to learn what you can change before you change anything.",
            schema: obj(json!({}), &[]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_list",
            description: "List the built-in and user themes and which one is current. Use it to find a theme to start from or to confirm a theme exists.",
            schema: obj(json!({}), &[]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_current",
            description: "Say which theme, color mode and accent override are in force, and any problem found with the settings. Read this before changing anything, and after, to confirm.",
            schema: obj(json!({}), &[]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_show",
            description: "The full resolved theme: every value for every product, after extends and per-product overrides. Large. Prefer theme_get for one value.",
            schema: obj(json!({"name": name}), &[]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_get",
            description: "One resolved value, for example dark.accent, shape.radius, type.mono or surface.site.light.accent. Use it to see what a value is now before you change it. A section such as dark returns all its values.",
            schema: obj(json!({
                "path": {"type":"string","description":"<section>.<key> or surface.<product>.<section>.<key>. Sections: light, dark, shape, type, motion."},
                "name": name,
            }), &["path"]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_set",
            description: "Switch to a theme that already exists (built-in or user), and optionally the color mode. Use it when the person wants a different whole theme, not an edit.",
            schema: obj(json!({
                "name": {"type":"string","description":"Theme name from theme_list."},
                "mode": {"type":"string","enum":["auto","light","dark"],"description":"auto follows the system."},
            }), &["name"]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        Tool {
            name: "theme_change",
            description: "Change one value, for example path dark.accent value \"#8fb37a\", or shape.radius value 0. This is the smallest edit and the usual first move. If the current theme is built in, it first makes a user theme <name>-custom that extends it and switches to that, and says so. Otherwise it edits the current user theme in place. Validated first: a refusal changes nothing. Undo with theme_undo.",
            schema: obj(json!({
                "path": {"type":"string","description":"<section>.<key> or surface.<product>.<section>.<key>, for example dark.accent, shape.radius_large, type.mono, motion.fast, surface.browser.light.accent. title and description also work."},
                "value": {"type":["string","number","boolean"],"description":"The new value. Its type comes from the path: a \"#rrggbb\" string for colors, a number for sizes and durations, text for fonts and choices, true or false for motion.reduced."},
            }), &["path", "value"]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        Tool {
            name: "theme_apply",
            description: "Save a whole theme under its name and make it current. Use it for a bigger redesign, or to change several values at once. Use `extends` and list only what changes. All or nothing: if any part is invalid, nothing is saved. A built-in theme's name is refused. Replaces a user theme of the same name; theme_undo brings the old one back.",
            schema: obj(json!({
                "theme": theme_doc,
                "name": {"type":"string","description":"Save under this name instead of the theme's own `name`."},
                "activate": {"type":"boolean","description":"Make it current. Default true. false saves it for later."},
            }), &["theme"]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        Tool {
            name: "theme_create",
            description: "Make a new user theme that extends another and start editing it with theme_change. It does not make it current. Refused if the name is taken (pass force true to overwrite your own theme; theme_undo brings the old one back), is a built-in name, or the result would not load. Delete what you made with theme_delete.",
            schema: obj(json!({
                "name": {"type":"string","description":"New theme name: lowercase letters, digits and hyphens."},
                "extends": {"type":"string","description":"The theme to start from, a name from theme_list."},
                "force": {"type":"boolean","description":"Overwrite a user theme of the same name."},
            }), &["name", "extends"]),
            read_only: false,
            destructive: false,
            idempotent: false,
        },
        Tool {
            name: "theme_delete",
            description: "Delete a user theme, for example one you made with theme_create or theme_apply and no longer need. Built-in themes, the current theme, a theme the current one extends and a theme another user theme extends are refused. An unreadable theme file also blocks it unless force is true. theme_undo brings it back.",
            schema: obj(json!({
                "name": {"type":"string","description":"The user theme to delete, a name from theme_list."},
                "force": {"type":"boolean","description":"Delete even though a theme file could not be read, so it is unknown whether it extends this one. A copy is kept in history. A theme that is known to extend it still blocks."},
            }), &["name"]),
            read_only: false,
            destructive: true,
            idempotent: false,
        },
        Tool {
            name: "theme_accent",
            description: "Set the brand color for the current theme. With no mode, the color is kept where it reads and moved the smallest step where it does not, and the result says what it chose. With a mode, it is taken exactly or refused. It picks a readable on_accent. A surface that sets its own accent keeps it.",
            schema: obj(json!({
                "color": {"type":"string","description":"\"#rrggbb\". Leave out when clear is true."},
                "mode": {"type":"string","enum":["light","dark"],"description":"Take the color exactly for this one mode. Leave out to use it everywhere, adjusted as needed."},
                "clear": {"type":"boolean","description":"Remove the accent override."},
            }), &[]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        Tool {
            name: "theme_validate",
            description: "Check a theme without saving or applying it. Use it to test a draft; the answer lists every problem at once, with paths.",
            schema: obj(json!({"theme": theme_doc}), &["theme"]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_preview",
            description: "Write one self-contained HTML page that shows the theme on realistic product UI: the workspace dock, dictation overlay, browser side panel with a chat turn and a permission prompt, a settings form, code, buttons and status text. Writes only into the previews folder of the config folder, and returns the file path. Open it in a browser and take a screenshot to show the person. Call it after every change.",
            schema: obj(json!({
                "name": name,
                "mode": {"type":"string","enum":["light","dark","both"],"description":"Default both, side by side."},
                "surface": surface,
            }), &[]),
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_export",
            description: "The theme as CSS variables (--pc-*) or as JSON, as products read it. Use it to check exactly what a product will get.",
            schema: obj(json!({
                "format": {"type":"string","enum":["css","json"]},
                "name": name,
                "surface": surface,
            }), &["format"]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_undo",
            description: "Step back one change (a theme_change, theme_apply, theme_set, theme_accent, theme_off, theme_on or theme_reset), including the theme file it edited. Use it when the person dislikes what you just did. Call it again to go back further. If the theme file was edited by hand after that change, it refuses; pass force true only if the person agrees, and the edited text is first saved in history/.",
            schema: obj(json!({"force": {"type": "boolean", "description": "Undo even though the theme file was edited after the change. The edited text is saved in history/ first."}}), &[]),
            read_only: false,
            destructive: true,
            idempotent: false,
        },
        Tool {
            name: "theme_history",
            description: "Past changes, newest first, with who made each. Yours show as agent:<your client name>.",
            schema: obj(json!({}), &[]),
            read_only: true,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_off",
            description: "Turn the theme off. Removes current/theme.json and the css files and records enabled = false; your themes and settings stay on disk. Apps that read those files use their own look when they next check. Use it when the person wants the apps' own look back. It fails, naming the files left, if any file cannot be removed. theme_on or theme_undo brings the theme back.",
            schema: obj(json!({}), &[]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
        Tool {
            name: "theme_on",
            description: "Turn the last theme back on after theme_off and write the files in current/ again. theme_set, theme_accent and theme_change also turn it on, and so does theme_apply when it activates the theme (not with activate false).",
            schema: obj(json!({}), &[]),
            read_only: false,
            destructive: false,
            idempotent: true,
        },
        Tool {
            name: "theme_reset",
            description: "Go back to the default theme (polycarp), mode auto, no accent override, and turn the theme on. Always works, even if a theme file is broken. Your own themes stay on disk.",
            schema: obj(json!({}), &[]),
            read_only: false,
            destructive: true,
            idempotent: true,
        },
    ]
}

/// MCP annotations. The destructive and idempotent hints only mean something for a tool that
/// writes, so a read-only tool leaves them out.
fn annotations(t: &Tool) -> Json {
    if t.read_only {
        return json!({"readOnlyHint": true, "openWorldHint": false});
    }
    json!({
        "readOnlyHint": false,
        "destructiveHint": t.destructive,
        "idempotentHint": t.idempotent,
        "openWorldHint": false,
    })
}

fn tool_list() -> Json {
    let list: Vec<Json> = tools()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "title": t.name.replace('_', " "),
                "description": t.description,
                "inputSchema": t.schema,
                "annotations": annotations(&t),
            })
        })
        .collect();
    json!({"tools": list})
}

/// The arguments of one call, checked against the tool's input schema.
struct Args {
    map: Map<String, Json>,
}

impl Args {
    fn new(tool: &Tool, v: Option<&Json>) -> Result<Args, ApiErr> {
        let map = match v {
            None | Some(Json::Null) => Map::new(),
            Some(Json::Object(m)) => m.clone(),
            Some(_) => return Err(ApiErr::usage("arguments must be an object")),
        };
        let known = tool.schema["properties"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for k in map.keys() {
            if !known.contains_key(k) {
                let names: Vec<&String> = known.keys().collect();
                return Err(ApiErr::usage(format!(
                    "unknown argument {k:?} (this tool takes: {})",
                    if names.is_empty() {
                        "none".to_string()
                    } else {
                        names
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                )));
            }
        }
        for r in tool.schema["required"].as_array().into_iter().flatten() {
            let r = r.as_str().unwrap_or_default();
            if !map.contains_key(r) {
                return Err(ApiErr::usage(format!("missing argument {r:?}")));
            }
        }
        Ok(Args { map })
    }
    fn text(&self, k: &str) -> Result<Option<&str>, ApiErr> {
        match self.map.get(k) {
            None | Some(Json::Null) => Ok(None),
            Some(Json::String(s)) => Ok(Some(s)),
            Some(_) => Err(ApiErr::usage(format!("{k} must be a string"))),
        }
    }
    fn need(&self, k: &str) -> Result<&str, ApiErr> {
        self.text(k)?
            .ok_or_else(|| ApiErr::usage(format!("missing argument {k:?}")))
    }
    fn flag(&self, k: &str) -> Result<Option<bool>, ApiErr> {
        match self.map.get(k) {
            None | Some(Json::Null) => Ok(None),
            Some(Json::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(ApiErr::usage(format!("{k} must be true or false"))),
        }
    }
}

/// Runs one tool. None means there is no such tool.
fn call(name: &str, args: Option<&Json>, caller: &str) -> Option<theme::Envelope> {
    let tool = tools().into_iter().find(|t| t.name == name)?;
    let run = || -> theme::Res {
        let a = Args::new(&tool, args)?;
        if name == "theme_schema" {
            return theme::op_schema();
        }
        let c = Ctx::new(caller)?;
        match name {
            "theme_list" => theme::op_list(&c),
            "theme_current" => theme::op_current(&c),
            "theme_show" => theme::op_show(&c, a.text("name")?),
            "theme_get" => theme::op_get(&c, a.need("path")?, a.text("name")?),
            "theme_set" => theme::op_set(&c, a.need("name")?, a.text("mode")?),
            "theme_change" => {
                let v = a.map.get("value").cloned().unwrap_or(Json::Null);
                theme::op_change(&c, a.need("path")?, &v)
            }
            "theme_apply" => {
                let doc = theme::doc_from_json(a.map.get("theme").unwrap_or(&Json::Null))?;
                let activate = a.flag("activate")?.unwrap_or(true);
                theme::op_apply(&c, doc, a.text("name")?, activate)
            }
            "theme_create" => theme::op_create(
                &c,
                a.need("name")?,
                a.need("extends")?,
                a.flag("force")?.unwrap_or(false),
            ),
            "theme_delete" => {
                theme::op_delete(&c, a.need("name")?, a.flag("force")?.unwrap_or(false))
            }
            "theme_accent" => {
                if a.flag("clear")?.unwrap_or(false) {
                    if a.text("color")?.is_some() {
                        return Err(ApiErr::usage("pass color or clear, not both"));
                    }
                    theme::op_accent(&c, None, a.text("mode")?)
                } else {
                    theme::op_accent(&c, Some(a.need("color")?), a.text("mode")?)
                }
            }
            "theme_validate" => {
                let doc = theme::doc_from_json(a.map.get("theme").unwrap_or(&Json::Null))?;
                theme::op_validate(&c, &doc, None, "the theme")
            }
            "theme_preview" => theme::op_preview(
                &c,
                a.text("name")?,
                a.text("mode")?,
                a.text("surface")?,
                None,
            ),
            "theme_export" => {
                theme::op_export(&c, a.need("format")?, a.text("name")?, a.text("surface")?)
            }
            "theme_undo" => theme::op_undo(&c, a.flag("force")?.unwrap_or(false)),
            "theme_history" => theme::op_history(&c),
            "theme_off" => theme::op_off(&c),
            "theme_on" => theme::op_on(&c),
            "theme_reset" => theme::op_reset(&c),
            _ => Err(ApiErr::usage("unknown tool")),
        }
    };
    Some(theme::envelope(&run()))
}

fn reply(id: &Json, result: Json) -> Json {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: &Json, code: i64, message: &str) -> Json {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

struct Server {
    client: String,
}

impl Server {
    fn caller(&self) -> String {
        format!("agent:{}", self.client)
    }

    /// One line in, at most one line out. Notifications get no answer.
    fn handle(&mut self, line: &str) -> Option<Json> {
        let msg: Json = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(e) => return Some(rpc_error(&Json::Null, -32700, &format!("parse error: {e}"))),
        };
        let Some(o) = msg.as_object() else {
            return Some(rpc_error(
                &Json::Null,
                -32600,
                "a request must be a JSON object",
            ));
        };
        let id = o.get("id").cloned();
        let Some(method) = o.get("method").and_then(Json::as_str) else {
            // A response from the client, or junk: nothing to do for a notification-shaped one.
            return id.map(|i| rpc_error(&i, -32600, "missing method"));
        };
        let params = o.get("params");
        let Some(id) = id else {
            // A notification. `notifications/initialized` and the rest need no answer.
            return None;
        };
        Some(match method {
            "initialize" => {
                let asked = params
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(Json::as_str)
                    .unwrap_or(LATEST);
                let version = if KNOWN.contains(&asked) {
                    asked
                } else {
                    LATEST
                };
                if let Some(n) = params
                    .and_then(|p| p.get("clientInfo"))
                    .and_then(|c| c.get("name"))
                    .and_then(Json::as_str)
                {
                    self.client = if n.trim().is_empty() {
                        "unknown".into()
                    } else {
                        theme::clean_caller(n)
                    };
                }
                reply(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "polycarp", "title": "Polycarp themes", "version": env!("CARGO_PKG_VERSION")},
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" => reply(&id, json!({})),
            "tools/list" => reply(&id, tool_list()),
            "tools/call" => {
                let Some(name) = params.and_then(|p| p.get("name")).and_then(Json::as_str) else {
                    return Some(rpc_error(&id, -32602, "tools/call needs params.name"));
                };
                let args = params.and_then(|p| p.get("arguments"));
                match call(name, args, &self.caller()) {
                    None => rpc_error(&id, -32602, &format!("unknown tool {name:?}")),
                    Some((env, ok)) => reply(
                        &id,
                        json!({
                            "content": [{"type": "text", "text": serde_json::to_string_pretty(&env).unwrap_or_default()}],
                            "structuredContent": env,
                            "isError": !ok,
                        }),
                    ),
                }
            }
            other => rpc_error(&id, -32601, &format!("method not found: {other}")),
        })
    }
}

pub fn run(args: &[OsString]) -> i32 {
    if !args.is_empty() {
        eprintln!("polycarp: mcp takes no arguments. It reads JSON-RPC lines on standard input.");
        return 2;
    }
    let mut server = Server {
        client: "unknown".into(),
    };
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return 0,
            Ok(_) => {}
        }
        let answer = match std::str::from_utf8(&buf) {
            Ok(text) => {
                let line = text.trim();
                if line.is_empty() {
                    continue;
                }
                server.handle(line)
            }
            Err(_) => Some(rpc_error(
                &Json::Null,
                -32700,
                "parse error: not UTF-8 text",
            )),
        };
        if let Some(a) = answer {
            let mut out = stdout.lock();
            if writeln!(out, "{a}").and_then(|_| out.flush()).is_err() {
                return 0;
            }
        }
    }
}
