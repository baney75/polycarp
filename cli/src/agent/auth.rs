//! Who may use the gateway, and with what scopes.
//!
//! Two kinds of caller:
//!
//! - Remote connectors (claude.ai, ChatGPT, grok.com) can't send a static header, so they get a single-owner OAuth 2.1
//!   authorization server, after Waypost's `src/oauth.ts` and Tychicus D30: dynamic client registration, the
//!   authorization code grant with PKCE S256 only, exact redirect URI matching, `state` required and returned, short
//!   access tokens and refresh tokens that rotate (a spent refresh token that comes back ends the whole grant).
//!   Consent never happens on the remote page: the page shows an approval code and the owner approves it on this
//!   machine (`polycarp agent approve <code>`), choosing the scopes there.
//! - Local clients (Claude Code or Codex over HTTP, Grok Bot over the tailnet) get per-client bearer tokens from
//!   `polycarp agent token create`.
//!
//! Every credential is stored only as its SHA-256. The functions here change a `State` in memory and take the time as
//! an argument, so the flows are tested without a clock or a disk; `mod.rs` loads and saves the state under a lock.

use super::store;
use crate::files::http::percent_encode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

/// What a grant or token may do. No wildcard.
pub const SCOPES: [&str; 4] = ["read", "files", "act", "contacts"];

/// What a scope lets through, for `approve` and the docs.
pub fn scope_meaning(s: &str) -> &'static str {
    match s {
        "read" => "read the theme, the app's status, its windows list and settings",
        "files" => "search the owner's files on every device, fetch one here, send one with Taildrop",
        "act" => "change the theme and settings, switch workspaces, open the launcher, focus and move windows",
        "contacts" => "the owner's contacts (no tools use it yet)",
        _ => "unknown",
    }
}

pub const ACCESS_TTL: i64 = 3600;
pub const REFRESH_TTL: i64 = 30 * 86_400;
pub const CODE_TTL: i64 = 300;
/// How long a connection waits for the owner's approval.
pub const PENDING_TTL: i64 = 600;
const MAX_CLIENTS: usize = 100;
const MAX_PENDING: usize = 20;
const MAX_TOKENS: usize = 5000;

/// Web connectors' documented callbacks, matched exactly. Loopback http is for native clients (RFC 8252).
pub const DEFAULT_REDIRECTS: [&str; 3] = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
];
/// ChatGPT's per-connector callbacks: this prefix and an id.
const CHATGPT_CALLBACK_PREFIX: &str = "https://chatgpt.com/connector/oauth/";
/// Hosts whose callback path isn't documented (grok.com): any path on exactly these hosts.
const REDIRECT_HOSTS: [&str; 2] = ["grok.com", "x.ai"];

/// Where a connection that came through a public tunnel may send its code and still count as an assistant's: the
/// assistants' own hosts over https, and loopback for a native client. Anything else is marked unverified.
const ASSISTANT_HOSTS: [&str; 5] = ["claude.ai", "claude.com", "chatgpt.com", "grok.com", "x.ai"];

/// How a registration or an authorization request reached this server. The tailnet listener serves no OAuth
/// endpoints, so a connector only ever arrives on loopback or through a tunnel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Local,
    /// The default for a record that predates the field: the stricter reading.
    #[default]
    Tunnel,
}

impl Origin {
    pub fn name(self) -> &'static str {
        match self {
            Origin::Local => "this machine",
            Origin::Tunnel => "the public tunnel",
        }
    }
}

/// The host a redirect URI sends codes to, as `approve` shows it.
pub fn redirect_host(uri: &str) -> String {
    scheme_and_host(uri)
        .map(|(_, h)| h)
        .unwrap_or_else(|| "an unreadable address".into())
}

/// A redirect to an assistant's own host over https, or to loopback over http.
pub fn assistant_redirect(uri: &str) -> bool {
    match scheme_and_host(uri) {
        Some(("https", h)) => ASSISTANT_HOSTS.contains(&h.as_str()),
        Some(("http", h)) => matches!(h.as_str(), "127.0.0.1" | "localhost" | "[::1]"),
        _ => false,
    }
}

/// The letters an approval code is made of: no 0/O, 1/I/L, so it reads back without mistakes.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    /// `none`, `client_secret_post` or `client_secret_basic`.
    pub auth_method: String,
    /// SHA-256 of the client's key, for the two methods that have one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_digest: Option<String>,
    pub created: i64,
    /// When the owner last approved it on this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<i64>,
    /// What the owner granted it last.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Where it registered. A visitor to a public tunnel can register any name, so this, not the name, is shown.
    #[serde(default)]
    pub origin: Origin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Access,
    Refresh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    pub kind: Kind,
    pub client: String,
    /// Every token of one grant shares a family; ending the family ends the grant.
    pub family: String,
    pub scopes: Vec<String>,
    pub resource: String,
    pub expires: i64,
    /// A refresh token that was already exchanged. Kept until it expires, so its return is seen.
    #[serde(default)]
    pub spent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Code {
    pub client: String,
    pub redirect_uri: String,
    pub challenge: String,
    pub scopes: Vec<String>,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    pub expires: i64,
    /// Set when the code was exchanged: the family it made, ended if the code comes back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Decision {
    Approved(Vec<String>),
    Denied,
}

/// An authorization request waiting for the owner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pending {
    /// What the owner types: `ABCD-EFGH`.
    pub approval: String,
    pub client: String,
    pub redirect_uri: String,
    pub state: String,
    pub challenge: String,
    /// What the client asked for.
    pub scopes: Vec<String>,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    pub created: i64,
    pub expires: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    /// Where the authorization request came from.
    #[serde(default)]
    pub origin: Origin,
}

/// A local client's bearer token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bearer {
    pub id: String,
    pub name: String,
    pub hash: String,
    pub scopes: Vec<String>,
    /// Also taken through a public tunnel. Off by default: a token made for a local agent works on this machine and the
    /// tailnet only.
    #[serde(default)]
    pub remote: bool,
    pub created: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked: Option<i64>,
}

/// `agent/auth.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct State {
    #[serde(default)]
    pub clients: BTreeMap<String, Client>,
    /// By the token's SHA-256.
    #[serde(default)]
    pub tokens: BTreeMap<String, Token>,
    /// By the code's SHA-256.
    #[serde(default)]
    pub codes: BTreeMap<String, Code>,
    /// By the SHA-256 of the request id the waiting browser holds.
    #[serde(default)]
    pub pending: BTreeMap<String, Pending>,
    #[serde(default)]
    pub bearers: Vec<Bearer>,
}

/// An OAuth error answer: status, `error` and `error_description`.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthErr {
    pub status: u16,
    pub error: &'static str,
    pub description: String,
}

impl OAuthErr {
    fn new(status: u16, error: &'static str, description: impl Into<String>) -> OAuthErr {
        OAuthErr {
            status,
            error,
            description: description.into(),
        }
    }
    pub fn json(&self) -> Json {
        json!({"error": self.error, "error_description": self.description})
    }
}

/// How a caller got in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerKind {
    /// stdio: the owner's own process, full access.
    Stdio,
    /// A bearer token from `token create`.
    Token,
    /// An OAuth access token.
    OAuth,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    /// The client or token id: sessions belong to it.
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub kind: CallerKind,
}

impl Caller {
    pub fn stdio() -> Caller {
        Caller {
            id: "stdio".into(),
            name: "stdio".into(),
            scopes: SCOPES.iter().map(|s| s.to_string()).collect(),
            kind: CallerKind::Stdio,
        }
    }
    pub fn may(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

/// Scopes from `read,files` or `read files`: known ones only, at least one, each once, in SCOPES order.
pub fn parse_scopes(text: &str) -> Result<Vec<String>, String> {
    let mut want = Vec::new();
    for s in text
        .split([',', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !SCOPES.contains(&s) {
            return Err(format!(
                "unknown scope {s:?} (the scopes are {})",
                SCOPES.join(", ")
            ));
        }
        want.push(s);
    }
    if want.is_empty() {
        return Err(format!("name at least one scope: {}", SCOPES.join(", ")));
    }
    Ok(SCOPES
        .iter()
        .filter(|s| want.contains(s))
        .map(|s| s.to_string())
        .collect())
}

/// The scheme and lowercase host of an absolute URL we take, or None.
fn scheme_and_host(uri: &str) -> Option<(&str, String)> {
    if uri.len() > 500 || uri.contains('#') || uri.chars().any(|c| c.is_control() || c == ' ') {
        return None;
    }
    let (scheme, rest) = uri.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains(['@', '\\', '%']) {
        return None;
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        if !after.is_empty() && !after.starts_with(':') {
            return None;
        }
        (format!("[{h}]"), after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    if port.is_some_and(|p| p.parse::<u16>().is_err()) {
        return None;
    }
    Some((scheme, host.to_lowercase()))
}

/// Where an authorization code may be sent: a web connector's documented callback (exactly), any path on grok.com or
/// x.ai, an exact callback the owner listed, or http on loopback for a native client.
pub fn redirect_allowed(uri: &str, extra: &[String]) -> bool {
    let Some((scheme, host)) = scheme_and_host(uri) else {
        return false;
    };
    if scheme == "http" {
        return matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
    }
    if DEFAULT_REDIRECTS.contains(&uri) || extra.iter().any(|e| e == uri) {
        return true;
    }
    if let Some(id) = uri.strip_prefix(CHATGPT_CALLBACK_PREFIX) {
        return !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    }
    REDIRECT_HOSTS.contains(&host.as_str())
}

/// Two resource URLs name the same endpoint: equal apart from a final slash, with every loopback name the same.
pub fn same_resource(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.trim_end_matches('/').to_string();
        for lo in ["http://localhost:", "http://[::1]:"] {
            if let Some(rest) = s.strip_prefix(lo) {
                return format!("http://127.0.0.1:{rest}");
            }
        }
        s
    };
    norm(a) == norm(b)
}

fn clean_name(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| !c.is_control() && !"<>\"'&`".contains(*c))
        .take(100)
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "MCP client".into()
    } else {
        s
    }
}

type Form = [(String, String)];

fn field<'a>(form: &'a Form, k: &str) -> Option<&'a str> {
    form.iter()
        .find(|(key, _)| key == k)
        .map(|(_, v)| v.as_str())
}

impl State {
    /// Drops what has expired, and the oldest tokens past the cap.
    pub fn prune(&mut self, now: i64) {
        self.tokens.retain(|_, t| t.expires > now);
        self.codes.retain(|_, c| c.expires > now);
        self.pending.retain(|_, p| p.expires > now);
        if self.tokens.len() > MAX_TOKENS {
            let mut by_age: Vec<(String, i64)> = self
                .tokens
                .iter()
                .map(|(h, t)| (h.clone(), t.expires))
                .collect();
            by_age.sort_by_key(|(_, e)| *e);
            let extra = self.tokens.len() - MAX_TOKENS;
            for (h, _) in by_age.into_iter().take(extra) {
                self.tokens.remove(&h);
            }
        }
    }

    fn end_family(&mut self, family: &str) {
        self.tokens.retain(|_, t| t.family != family);
    }

    // ------------------------------------------------------------------------------------------
    // Registration (RFC 7591)
    // ------------------------------------------------------------------------------------------

    pub fn register(
        &mut self,
        body: &Json,
        extra: &[String],
        origin: Origin,
        now: i64,
    ) -> Result<Json, OAuthErr> {
        let bad = |m: &str| OAuthErr::new(400, "invalid_client_metadata", m);
        let uris: Vec<String> = match body.get("redirect_uris").and_then(Json::as_array) {
            Some(list) if (1..=5).contains(&list.len()) => list
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect::<Option<_>>()
                .ok_or_else(|| bad("redirect_uris must be strings"))?,
            _ => return Err(bad("redirect_uris is required (1 to 5 URIs)")),
        };
        if let Some(u) = uris.iter().find(|u| !redirect_allowed(u, extra)) {
            return Err(OAuthErr::new(
                400,
                "invalid_redirect_uri",
                format!(
                    "{u} is not a callback this server sends codes to: only claude.ai, claude.com, chatgpt.com, \
grok.com, x.ai, the owner's extra_redirects, or http on localhost"
                ),
            ));
        }
        let method = body
            .get("token_endpoint_auth_method")
            .and_then(Json::as_str)
            .unwrap_or("none");
        if !["none", "client_secret_post", "client_secret_basic"].contains(&method) {
            return Err(bad(
                "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic",
            ));
        }
        let list_ok = |k: &str, allowed: &[&str]| match body.get(k) {
            None | Some(Json::Null) => true,
            Some(Json::Array(a)) => {
                a.len() <= 10
                    && a.iter()
                        .all(|v| v.as_str().is_some_and(|s| allowed.contains(&s)))
            }
            _ => false,
        };
        if !list_ok("grant_types", &["authorization_code", "refresh_token"]) {
            return Err(bad(
                "only the authorization_code and refresh_token grants are offered",
            ));
        }
        if !list_ok("response_types", &["code"]) {
            return Err(bad("only response_type code is offered"));
        }
        let name = clean_name(
            body.get("client_name")
                .and_then(Json::as_str)
                .unwrap_or("MCP client"),
        );
        if self.clients.len() >= MAX_CLIENTS {
            // Only a client that was never approved and is over an hour old makes room: a flood of registrations can't
            // push out the owner's real clients.
            let oldest = self
                .clients
                .values()
                .filter(|c| c.approved.is_none() && c.created < now - 3600)
                .min_by_key(|c| c.created)
                .map(|c| c.id.clone());
            match oldest {
                Some(id) => {
                    self.clients.remove(&id);
                }
                None => {
                    return Err(bad(
                        "too many registered clients: the owner can remove some with `polycarp agent revoke`",
                    ))
                }
            }
        }
        let id = store::secret("pcl_");
        let key = (method != "none").then(|| store::secret("pcs_"));
        self.clients.insert(
            id.clone(),
            Client {
                id: id.clone(),
                name: name.clone(),
                redirect_uris: uris.clone(),
                auth_method: method.to_string(),
                key_digest: key.as_deref().map(store::sha256_hex),
                created: now,
                approved: None,
                last_used: None,
                scopes: Vec::new(),
                origin,
            },
        );
        let mut out = json!({
            "client_id": id,
            "client_id_issued_at": now,
            "client_name": name,
            "redirect_uris": uris,
            "token_endpoint_auth_method": method,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        });
        if let Some(k) = key {
            out[concat!("client_", "secret")] = json!(k);
            out[concat!("client_", "secret_expires_at")] = json!(0);
        }
        Ok(out)
    }

    // ------------------------------------------------------------------------------------------
    // Authorization: the remote page waits; the owner approves here
    // ------------------------------------------------------------------------------------------

    /// Checks an authorization request and parks it for the owner. Returns the request id the browser keeps (it
    /// fetches the result with it) and the pending entry, whose `approval` code the page shows.
    pub fn authorize(
        &mut self,
        q: &Form,
        resource: &str,
        origin: Origin,
        now: i64,
    ) -> Result<(String, Pending), AuthzErr> {
        let client_id = field(q, "client_id").unwrap_or_default();
        let redirect_uri = field(q, "redirect_uri").unwrap_or_default();
        // Never redirect to an unchecked address: these errors show on the page instead.
        let Some(client) = self.clients.get(client_id) else {
            return Err(AuthzErr::Page(
                "This connector isn't registered here (or was revoked). Remove it in the assistant and add it again."
                    .into(),
            ));
        };
        if !client.redirect_uris.iter().any(|u| u == redirect_uri) {
            return Err(AuthzErr::Page(
                "The redirect address doesn't match the one this connector registered, so nothing was sent."
                    .into(),
            ));
        }
        let state = field(q, "state").unwrap_or_default();
        let fail = |error: &str, description: &str| {
            AuthzErr::Redirect(with_params(
                redirect_uri,
                &[
                    ("error", error),
                    ("error_description", description),
                    ("state", state),
                ],
            ))
        };
        if field(q, "response_type") != Some("code") {
            return Err(fail("unsupported_response_type", "only response_type=code"));
        }
        let challenge = field(q, "code_challenge").unwrap_or_default();
        let pkce_shape = challenge.len() == 43
            && challenge
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if field(q, "code_challenge_method") != Some("S256") || !pkce_shape {
            return Err(fail(
                "invalid_request",
                "PKCE with code_challenge_method=S256 is required",
            ));
        }
        if state.is_empty() || state.len() > 500 {
            return Err(fail(
                "invalid_request",
                "state is required (at most 500 characters)",
            ));
        }
        if let Some(r) = field(q, "resource") {
            if !same_resource(r, resource) {
                return Err(fail(
                    "invalid_target",
                    "this server issues tokens for its own MCP endpoint only",
                ));
            }
        }
        let scopes = match field(q, "scope").map(str::trim).filter(|s| !s.is_empty()) {
            None => vec!["read".to_string()],
            Some(s) => match parse_scopes(s) {
                Ok(v) => v,
                Err(e) => return Err(fail("invalid_scope", &e)),
            },
        };
        let nonce = field(q, "nonce").filter(|n| !n.is_empty() && n.len() <= 200);
        self.prune(now);
        if self.pending.len() >= MAX_PENDING {
            return Err(AuthzErr::Page(
                "Too many connections are waiting for approval. Wait ten minutes, or deny them with `polycarp agent deny`."
                    .into(),
            ));
        }
        let approval = loop {
            let code: String = store::random(8)
                .iter()
                .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
                .collect();
            let code = format!("{}-{}", &code[..4], &code[4..]);
            if !self.pending.values().any(|p| p.approval == code) {
                break code;
            }
        };
        let request = store::secret("");
        let p = Pending {
            approval,
            client: client_id.to_string(),
            redirect_uri: redirect_uri.to_string(),
            state: state.to_string(),
            challenge: challenge.to_string(),
            scopes,
            resource: resource.to_string(),
            nonce: nonce.map(str::to_string),
            created: now,
            expires: now + PENDING_TTL,
            decision: None,
            origin,
        };
        self.pending.insert(store::sha256_hex(&request), p.clone());
        Ok((request, p))
    }

    fn pending_by_code(&mut self, approval: &str, now: i64) -> Result<&mut Pending, String> {
        let want: String = approval
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .collect();
        self.prune(now);
        self.pending
            .values_mut()
            .find(|p| p.approval.replace('-', "") == want && p.decision.is_none())
            .ok_or_else(|| {
                format!(
                    "no connection is waiting with code {approval}: it may have expired (codes last ten minutes). \
Start connecting again in the assistant."
                )
            })
    }

    /// A waiting request that came through the public tunnel (or from a client registered there) and sends its code
    /// somewhere other than an assistant's own host over https. Its name proves nothing, so approving it takes
    /// `--unverified`. Loopback counts only from this machine: a native client never arrives through the tunnel, and a
    /// visitor's own 127.0.0.1 is the visitor's machine, not this one.
    pub fn unverified(&self, p: &Pending) -> bool {
        let tunnel = p.origin == Origin::Tunnel
            || self
                .clients
                .get(&p.client)
                .is_none_or(|c| c.origin == Origin::Tunnel);
        let assistant_host = matches!(scheme_and_host(&p.redirect_uri), Some(("https", _)))
            && assistant_redirect(&p.redirect_uri);
        tunnel && !assistant_host
    }

    /// The owner's yes, on this machine. `scopes` None grants what the client asked for. An unverified request needs
    /// `unverified_ok`, the owner's `--unverified`.
    pub fn approve(
        &mut self,
        approval: &str,
        scopes: Option<Vec<String>>,
        unverified_ok: bool,
        now: i64,
    ) -> Result<Pending, String> {
        let p = self.pending_by_code(approval, now)?.clone();
        if self.unverified(&p) && !unverified_ok {
            let name = self
                .clients
                .get(&p.client)
                .map(|c| c.name.as_str())
                .unwrap_or("a client");
            return Err(format!(
                "not approved: this request came through your public tunnel, and its code goes to {}, which is not \
Claude, ChatGPT or Grok. The name \"{name}\" is whatever the visitor typed. If you didn't start this, run \
`polycarp agent deny {approval}`. If you did and you trust {}, run `polycarp agent approve {approval} --unverified`.",
                redirect_host(&p.redirect_uri),
                redirect_host(&p.redirect_uri),
            ));
        }
        let p = self.pending_by_code(approval, now)?;
        let grant = scopes.unwrap_or_else(|| p.scopes.clone());
        if grant.is_empty() || grant.iter().any(|s| !SCOPES.contains(&s.as_str())) {
            return Err("grant at least one known scope".into());
        }
        p.decision = Some(Decision::Approved(grant.clone()));
        let p = p.clone();
        // A new approval is the owner's current word on this client: any grant or unused code it already holds that
        // goes beyond it ends now, so approving again with fewer scopes narrows what the client can do.
        let wider = |scopes: &[String]| scopes.iter().any(|s| !grant.contains(s));
        let families: Vec<String> = self
            .tokens
            .values()
            .filter(|t| t.client == p.client && wider(&t.scopes))
            .map(|t| t.family.clone())
            .collect();
        for f in families {
            self.end_family(&f);
        }
        self.codes
            .retain(|_, c| !(c.client == p.client && wider(&c.scopes)));
        if let Some(c) = self.clients.get_mut(&p.client) {
            c.approved = Some(now);
            c.scopes = grant;
        }
        Ok(p)
    }

    pub fn deny(&mut self, approval: &str, now: i64) -> Result<Pending, String> {
        let p = self.pending_by_code(approval, now)?;
        p.decision = Some(Decision::Denied);
        Ok(p.clone())
    }

    /// What the waiting page shows next. Once approved, the code is made here, once: the pending entry goes, so a
    /// second look gets nothing.
    pub fn poll(&mut self, request: &str, issuer: &str, now: i64) -> Poll {
        let key = store::sha256_hex(request);
        let Some(p) = self.pending.get(&key).cloned() else {
            return Poll::Gone(
                "This request is finished or unknown. Start connecting again in the assistant."
                    .into(),
            );
        };
        if p.expires <= now {
            self.pending.remove(&key);
            return Poll::Gone(
                "Nobody approved this in ten minutes, so it expired. Start connecting again in the assistant."
                    .into(),
            );
        }
        match &p.decision {
            None => Poll::Waiting(Box::new(p)),
            Some(Decision::Denied) => {
                self.pending.remove(&key);
                Poll::Redirect(with_params(
                    &p.redirect_uri,
                    &[
                        ("error", "access_denied"),
                        ("error_description", "the owner said no"),
                        ("state", &p.state),
                    ],
                ))
            }
            Some(Decision::Approved(scopes)) => {
                self.pending.remove(&key);
                // The owner's latest approval of this client is the ceiling: a yes given earlier and polled late
                // never brings back scopes a later, narrower yes took away.
                let current = self
                    .clients
                    .get(&p.client)
                    .map(|c| c.scopes.clone())
                    .unwrap_or_default();
                let scopes: Vec<String> = scopes
                    .iter()
                    .filter(|s| current.contains(s))
                    .cloned()
                    .collect();
                if scopes.is_empty() {
                    return Poll::Gone(
                        "The owner has since changed what this connection may do. Start connecting again in the assistant."
                            .into(),
                    );
                }
                let code = store::secret("pcc_");
                self.codes.insert(
                    store::sha256_hex(&code),
                    Code {
                        client: p.client.clone(),
                        redirect_uri: p.redirect_uri.clone(),
                        challenge: p.challenge.clone(),
                        scopes: scopes.clone(),
                        resource: p.resource.clone(),
                        nonce: p.nonce.clone(),
                        expires: now + CODE_TTL,
                        used_family: None,
                    },
                );
                Poll::Redirect(with_params(
                    &p.redirect_uri,
                    &[("code", &code), ("state", &p.state), ("iss", issuer)],
                ))
            }
        }
    }

    pub fn waiting(&mut self, now: i64) -> Vec<Pending> {
        self.prune(now);
        let mut v: Vec<Pending> = self
            .pending
            .values()
            .filter(|p| p.decision.is_none())
            .cloned()
            .collect();
        v.sort_by_key(|p| p.created);
        v
    }

    // ------------------------------------------------------------------------------------------
    // Tokens
    // ------------------------------------------------------------------------------------------

    fn authenticate(
        &self,
        form: &Form,
        basic: Option<(String, String)>,
    ) -> Result<Client, OAuthErr> {
        let (id, key) = match basic {
            Some((i, k)) => (i, Some(k)),
            None => (
                field(form, "client_id").unwrap_or_default().to_string(),
                field(form, concat!("client_", "secret")).map(str::to_string),
            ),
        };
        let c = self
            .clients
            .get(&id)
            .ok_or_else(|| OAuthErr::new(401, "invalid_client", "unknown client"))?;
        if let Some(digest) = &c.key_digest {
            let ok = key.is_some_and(|k| store::same(&store::sha256_hex(&k), digest));
            if !ok {
                return Err(OAuthErr::new(
                    401,
                    "invalid_client",
                    "client authentication failed",
                ));
            }
        }
        Ok(c.clone())
    }

    fn issue(
        &mut self,
        client: &str,
        scopes: &[String],
        resource: &str,
        family: &str,
        now: i64,
    ) -> Json {
        let access = store::secret("pca_");
        let refresh = store::secret("pcr_");
        for (t, kind, ttl) in [
            (&access, Kind::Access, ACCESS_TTL),
            (&refresh, Kind::Refresh, REFRESH_TTL),
        ] {
            self.tokens.insert(
                store::sha256_hex(t),
                Token {
                    kind,
                    client: client.to_string(),
                    family: family.to_string(),
                    scopes: scopes.to_vec(),
                    resource: resource.to_string(),
                    expires: now + ttl,
                    spent: false,
                },
            );
        }
        if let Some(c) = self.clients.get_mut(client) {
            c.last_used = Some(now);
        }
        json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL,
            "refresh_token": refresh,
            "scope": scopes.join(" "),
        })
    }

    /// The token endpoint. `basic` is the client id and key from an `Authorization: Basic` header.
    pub fn token(
        &mut self,
        form: &Form,
        basic: Option<(String, String)>,
        now: i64,
    ) -> Result<Json, OAuthErr> {
        let grant = field(form, "grant_type").unwrap_or_default().to_string();
        let client = self.authenticate(form, basic)?;
        let invalid = |m: &str| OAuthErr::new(400, "invalid_grant", m);
        match grant.as_str() {
            "authorization_code" => {
                let key = store::sha256_hex(field(form, "code").unwrap_or_default());
                let Some(code) = self.codes.get(&key).cloned() else {
                    return Err(invalid(
                        "the authorization code is invalid, expired or already used",
                    ));
                };
                if let Some(f) = &code.used_family {
                    // A code that comes back was copied: end what it made.
                    self.end_family(f);
                    self.codes.remove(&key);
                    return Err(invalid(
                        "this authorization code was already used, so the grant it made has been ended. Connect again.",
                    ));
                }
                if code.expires <= now {
                    self.codes.remove(&key);
                    return Err(invalid("the authorization code expired"));
                }
                if code.client != client.id {
                    return Err(invalid("the authorization code belongs to another client"));
                }
                if field(form, "redirect_uri") != Some(code.redirect_uri.as_str()) {
                    return Err(invalid(
                        "redirect_uri does not match the authorization request",
                    ));
                }
                let verifier = field(form, "code_verifier").unwrap_or_default();
                let shape = (43..=128).contains(&verifier.len())
                    && verifier.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
                    });
                if !shape || !store::same(&store::s256(verifier), &code.challenge) {
                    // One wrong verifier burns the code: a stolen code can't be tried again and again.
                    self.codes.remove(&key);
                    return Err(invalid("PKCE verification failed"));
                }
                if let Some(r) = field(form, "resource") {
                    if !same_resource(r, &code.resource) {
                        return Err(OAuthErr::new(
                            400,
                            "invalid_target",
                            "the resource does not match the authorization request",
                        ));
                    }
                }
                let family = store::secret("");
                let mut out = self.issue(&client.id, &code.scopes, &code.resource, &family, now);
                if let Some(n) = &code.nonce {
                    out["nonce"] = json!(n);
                }
                if let Some(c) = self.codes.get_mut(&key) {
                    c.used_family = Some(family);
                }
                Ok(out)
            }
            "refresh_token" => {
                let key = store::sha256_hex(field(form, "refresh_token").unwrap_or_default());
                let Some(t) = self.tokens.get(&key).cloned() else {
                    return Err(invalid("the refresh token is invalid or expired"));
                };
                if t.kind != Kind::Refresh || t.client != client.id || t.expires <= now {
                    return Err(invalid("the refresh token is invalid or expired"));
                }
                if t.spent {
                    // A rotated refresh token came back: someone holds a copy. End the whole grant.
                    self.end_family(&t.family);
                    return Err(invalid(
                        "this refresh token was already used, so the grant has been ended. Connect again.",
                    ));
                }
                let scopes = match field(form, "scope")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    None => t.scopes.clone(),
                    Some(s) => {
                        let want =
                            parse_scopes(s).map_err(|e| OAuthErr::new(400, "invalid_scope", e))?;
                        if want.iter().any(|w| !t.scopes.contains(w)) {
                            return Err(OAuthErr::new(
                                400,
                                "invalid_scope",
                                "a refresh can narrow the scopes, never widen them",
                            ));
                        }
                        want
                    }
                };
                if let Some(old) = self.tokens.get_mut(&key) {
                    old.spent = true;
                }
                let family = t.family.clone();
                self.tokens
                    .retain(|_, x| !(x.family == family && x.kind == Kind::Access));
                Ok(self.issue(&client.id, &scopes, &t.resource, &family, now))
            }
            _ => Err(OAuthErr::new(
                400,
                "unsupported_grant_type",
                "use authorization_code or refresh_token",
            )),
        }
    }

    /// RFC 7009: ends the grant the token belongs to, when it is the caller's. Unknown tokens are not an error.
    pub fn revoke_token(
        &mut self,
        form: &Form,
        basic: Option<(String, String)>,
    ) -> Result<(), OAuthErr> {
        let client = self.authenticate(form, basic)?;
        let token = field(form, "token").unwrap_or_default();
        if let Some(t) = self.tokens.get(&store::sha256_hex(token)).cloned() {
            if t.client == client.id {
                self.end_family(&t.family);
            }
        }
        Ok(())
    }

    /// Who an `Authorization: Bearer` header belongs to. Tokens in query strings are never read.
    /// `resource` is the MCP endpoint this request reached; `via_tunnel` is true when it came through a public tunnel.
    pub fn verify(
        &self,
        header: Option<&str>,
        resource: &str,
        via_tunnel: bool,
        now: i64,
    ) -> Option<Caller> {
        let token = header?.strip_prefix("Bearer ")?.trim();
        if !(20..=200).contains(&token.len())
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return None;
        }
        let hash = store::sha256_hex(token);
        if let Some(t) = self.tokens.get(&hash) {
            let client = self.clients.get(&t.client)?;
            let live = t.kind == Kind::Access && !t.spent && t.expires > now;
            return (live && same_resource(&t.resource, resource)).then(|| Caller {
                id: client.id.clone(),
                name: client.name.clone(),
                scopes: t.scopes.clone(),
                kind: CallerKind::OAuth,
            });
        }
        let b = self
            .bearers
            .iter()
            .find(|b| b.revoked.is_none() && store::same(&b.hash, &hash))?;
        if via_tunnel && !b.remote {
            return None;
        }
        Some(Caller {
            id: b.id.clone(),
            name: b.name.clone(),
            scopes: b.scopes.clone(),
            kind: CallerKind::Token,
        })
    }

    /// Notes a use, for `clients`.
    pub fn touch(&mut self, id: &str, now: i64) {
        if let Some(c) = self.clients.get_mut(id) {
            c.last_used = Some(now);
        }
        if let Some(b) = self.bearers.iter_mut().find(|b| b.id == id) {
            b.last_used = Some(now);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Local tokens and the owner's commands
    // ------------------------------------------------------------------------------------------

    /// A bearer token for a local client. The token is returned once; only its hash is kept.
    pub fn create_bearer(
        &mut self,
        name: &str,
        scopes: Vec<String>,
        remote: bool,
        now: i64,
    ) -> Result<(String, String), String> {
        let name = name.trim();
        if name.is_empty()
            || name.len() > 60
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || " ._-".contains(c))
        {
            return Err(
                "--name takes 1 to 60 letters, digits, spaces, dots, dashes or underscores".into(),
            );
        }
        if scopes.is_empty() {
            return Err("name at least one scope".into());
        }
        let id = format!("tok_{}", store::b64url(&store::random(6)));
        let token = store::secret("pct_");
        self.bearers.push(Bearer {
            id: id.clone(),
            name: name.to_string(),
            hash: store::sha256_hex(&token),
            scopes,
            remote,
            created: now,
            last_used: None,
            revoked: None,
        });
        Ok((id, token))
    }

    /// Revokes an OAuth client (with every grant, code and waiting request it has) or a bearer token, by id.
    pub fn revoke(&mut self, id: &str, now: i64) -> Result<&'static str, String> {
        if self.clients.remove(id).is_some() {
            self.tokens.retain(|_, t| t.client != id);
            self.codes.retain(|_, c| c.client != id);
            self.pending.retain(|_, p| p.client != id);
            return Ok("client");
        }
        if let Some(b) = self
            .bearers
            .iter_mut()
            .find(|b| b.id == id && b.revoked.is_none())
        {
            b.revoked = Some(now);
            return Ok("token");
        }
        Err(format!(
            "no client or token has the id {id}. `polycarp agent clients` lists them."
        ))
    }

    /// Every client and token, for `clients`, without a hash in sight.
    pub fn listing(&self, now: i64) -> Json {
        let grants = |id: &str| {
            let mut fams: Vec<&str> = self
                .tokens
                .values()
                .filter(|t| t.client == id && t.expires > now && !t.spent)
                .map(|t| t.family.as_str())
                .collect();
            fams.sort_unstable();
            fams.dedup();
            fams.len()
        };
        let clients: Vec<Json> = self
            .clients
            .values()
            .map(|c| {
                json!({
                    "id": c.id,
                    "kind": "oauth",
                    "name": c.name,
                    "redirect": c.redirect_uris,
                    "created": c.created,
                    "approved": c.approved,
                    "last_used": c.last_used,
                    "scopes": c.scopes,
                    "grants": grants(&c.id),
                })
            })
            .collect();
        let tokens: Vec<Json> = self
            .bearers
            .iter()
            .filter(|b| b.revoked.is_none())
            .map(|b| {
                json!({
                    "id": b.id,
                    "kind": "token",
                    "name": b.name,
                    "created": b.created,
                    "last_used": b.last_used,
                    "scopes": b.scopes,
                    "remote": b.remote,
                })
            })
            .collect();
        json!({"clients": clients, "tokens": tokens})
    }
}

/// What `authorize` refuses with: a page of its own (the redirect address can't be trusted), or a redirect carrying
/// the error back to the client.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthzErr {
    Page(String),
    Redirect(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    Waiting(Box<Pending>),
    Redirect(String),
    Gone(String),
}

/// `uri` with query parameters added. Empty values are left out.
pub fn with_params(uri: &str, params: &[(&str, &str)]) -> String {
    let mut out = uri.to_string();
    let mut sep = if uri.contains('?') { '&' } else { '?' };
    for (k, v) in params.iter().filter(|(_, v)| !v.is_empty()) {
        out.push(sep);
        out.push_str(&format!("{}={}", percent_encode(k), percent_encode(v)));
        sep = '&';
    }
    out
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
