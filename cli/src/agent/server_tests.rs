//! The HTTP side: loopback-only binds, Host and Origin refusal, the channel gate on tunnels, the 401 challenge, the
//! whole OAuth flow over HTTP into an MCP session, and the tailnet listener's whois allow and deny.

use super::*;
use crate::agent::app::tests::Fake;
use crate::agent::policy::WAITLIST_URL;
use crate::files::tailnet::Status;
use std::io::Cursor;
use std::net::{Ipv4Addr, Ipv6Addr};

const CLAUDE: &str = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const LOCAL: &str = "127.0.0.1:41772";

fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pc-agent-srv-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn ctx_in(dir: &std::path::Path, channel: Channel) -> Ctx {
    Ctx::new(
        dir.to_path_buf(),
        Gateway::new(Arc::new(Fake::new(true))),
        channel,
        Settings::default(),
    )
}

/// A request as bytes on the wire, parsed by the real parser.
fn req(method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Req {
    let mut raw = format!("{method} {target} HTTP/1.1\r\n");
    for (k, v) in headers {
        raw.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body.is_empty() {
        raw.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    raw.push_str("\r\n");
    let mut bytes = raw.into_bytes();
    bytes.extend_from_slice(body);
    read_req(&mut Cursor::new(bytes)).unwrap()
}

fn body_json(r: &Resp) -> Json {
    serde_json::from_slice(&r.body).unwrap_or(Json::Null)
}

fn param(url: &str, k: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|p| {
        let (key, v) = p.split_once('=')?;
        (key == k).then(|| percent_decode(v))
    })
}

#[test]
fn it_binds_loopback_only() {
    for ok in [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ] {
        assert!(check_bind(ok).is_ok(), "{ok}");
    }
    for no in [
        "0.0.0.0",
        "::",
        "192.168.1.20",
        "10.0.0.2",
        "100.101.102.103",
        "fd7a:115c:a1e0::1",
        "8.8.8.8",
    ] {
        let e = check_bind(no.parse().unwrap()).unwrap_err();
        assert!(e.contains("loopback only"), "{no}: {e}");
    }
    let ctx = Arc::new(ctx_in(&temp("bind"), Channel::Dev));
    let e = serve(ctx, &["0.0.0.0:0".parse().unwrap()], &[], &|_| {}).unwrap_err();
    assert!(e.contains("loopback only"), "{e}");
}

#[test]
fn a_real_loopback_listener_answers() {
    let ctx = Arc::new(ctx_in(&temp("live"), Channel::Dev));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = serve(ctx, &["127.0.0.1:0".parse().unwrap()], &[], &|a| {
            let _ = tx.send(a[0]);
        });
    });
    let addr = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut s = TcpStream::connect(addr).unwrap();
    write!(
        s,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        addr.port()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("polycarp-agent"));
}

#[test]
fn the_parser_takes_chunked_bodies_and_refuses_smuggling_shapes() {
    let raw = b"POST /mcp HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
    assert_eq!(
        read_req(&mut Cursor::new(raw.to_vec())).unwrap().body,
        b"{\"a\":1}"
    );
    for bad in [
        &b"POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
        b"POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n",
        b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n",
        b"GET / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
        b"GET / HTTP/1.1\r\nAuthorization: Bearer a\r\nAuthorization: Bearer b\r\n\r\n",
        b"GET http://evil/ HTTP/1.1\r\n\r\n",
        b"GET / HTTP/1.1\r\nBad Header: x\r\n\r\n",
    ] {
        assert_eq!(
            read_req(&mut Cursor::new(bad.to_vec())).unwrap_err().0,
            400,
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
    let big = format!(
        "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
        MAX_BODY + 1
    );
    assert_eq!(
        read_req(&mut Cursor::new(big.into_bytes())).unwrap_err().0,
        413
    );
}

#[test]
fn a_host_that_is_not_this_machine_is_refused() {
    let ctx = ctx_in(&temp("host"), Channel::Dev);
    for h in [
        LOCAL,
        "localhost:41772",
        "[::1]:41772",
        "localhost",
        "LOCALHOST:41772",
    ] {
        assert_eq!(
            route_local(&ctx, &req("GET", "/health", &[("Host", h)], b"")).status,
            200,
            "{h}"
        );
    }
    for h in [
        "evil.example",
        "evil.example:41772",
        "127.0.0.1.evil.example",
        "192.168.1.2:41772",
        "localhost:99999",
    ] {
        let r = route_local(&ctx, &req("GET", "/health", &[("Host", h)], b""));
        assert_eq!(r.status, 403, "{h}");
        assert_eq!(body_json(&r)["error"]["code"], "wrong_host");
    }
    assert_eq!(
        route_local(&ctx, &req("GET", "/health", &[], b"")).status,
        403
    );
}

#[test]
fn a_web_page_reaches_only_the_public_metadata_and_the_approval_page() {
    let ctx = ctx_in(&temp("origin"), Channel::Dev);
    let page_headers: [&[(&str, &str)]; 3] = [
        &[("Host", LOCAL), ("Origin", "https://evil.example")],
        &[("Host", LOCAL), ("Origin", "null")],
        &[("Host", LOCAL), ("Sec-Fetch-Site", "cross-site")],
    ];
    for h in page_headers {
        for (m, p) in [
            ("POST", "/mcp"),
            ("GET", "/mcp"),
            ("DELETE", "/mcp"),
            ("POST", "/token"),
            ("POST", "/register"),
            ("POST", "/revoke"),
        ] {
            let r = route_local(&ctx, &req(m, p, h, b"{}"));
            assert_eq!(r.status, 403, "{m} {p} {h:?}");
            assert_eq!(body_json(&r)["error"]["code"], "not_allowed");
            assert!(r.header("Access-Control-Allow-Origin").is_none());
        }
        for p in [
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource/mcp",
            "/health",
        ] {
            assert_eq!(route_local(&ctx, &req("GET", p, h, b"")).status, 200, "{p}");
        }
    }
    // A request typed into the address bar (Sec-Fetch-Site: none) is the owner's own, and still needs a token.
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Sec-Fetch-Site", "none"),
                ("Content-Type", "application/json"),
            ],
            b"{}",
        ),
    );
    assert_eq!(r.status, 401);
}

#[test]
fn an_unauthenticated_mcp_request_gets_the_challenge_that_starts_oauth() {
    let ctx = ctx_in(&temp("401"), Channel::Dev);
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[("Host", LOCAL), ("Content-Type", "application/json")],
            b"{}",
        ),
    );
    assert_eq!(r.status, 401);
    assert_eq!(
        r.header("WWW-Authenticate"),
        Some("Bearer resource_metadata=\"http://127.0.0.1:41772/.well-known/oauth-protected-resource\"")
    );
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer pca_notarealtokenatallxx"),
            ],
            b"{}",
        ),
    );
    assert!(r
        .header("WWW-Authenticate")
        .unwrap()
        .contains("error=\"invalid_token\""));
    let m = body_json(&route_local(
        &ctx,
        &req(
            "GET",
            "/.well-known/oauth-protected-resource",
            &[("Host", LOCAL)],
            b"",
        ),
    ));
    assert_eq!(m["resource"], "http://127.0.0.1:41772/mcp");
    assert_eq!(m["authorization_servers"][0], "http://127.0.0.1:41772");
    let a = body_json(&route_local(
        &ctx,
        &req(
            "GET",
            "/.well-known/oauth-authorization-server",
            &[("Host", LOCAL)],
            b"",
        ),
    ));
    assert_eq!(a["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(
        a["registration_endpoint"],
        "http://127.0.0.1:41772/register"
    );
}

fn mcp_post(
    ctx: &Ctx,
    host: &str,
    token: &str,
    session: Option<&str>,
    msg: &Json,
    accept: &str,
) -> Resp {
    let auth = format!("Bearer {token}");
    let mut h = vec![
        ("Host", host),
        ("Content-Type", "application/json"),
        ("Authorization", auth.as_str()),
        ("Accept", accept),
    ];
    if let Some(s) = session {
        h.push(("Mcp-Session-Id", s));
    }
    route_local(ctx, &req("POST", "/mcp", &h, msg.to_string().as_bytes()))
}

const BOTH: &str = "application/json, text/event-stream";

/// The approval code the waiting page shows.
fn code_on_page(page: &str) -> String {
    page.split("polycarp agent approve ")
        .nth(1)
        .and_then(|r| r.split('<').next())
        .unwrap()
        .to_string()
}

/// Register, authorize, approve on this machine, exchange: an access token with the scopes asked for.
fn oauth_token(ctx: &Ctx, host: &str, scope: &str) -> (String, String) {
    let r = route_local(
        ctx,
        &req("POST", "/register", &[("Host", host), ("Content-Type", "application/json")],
            json!({"redirect_uris": [CLAUDE], "client_name": "Claude", "token_endpoint_auth_method": "none"}).to_string().as_bytes()),
    );
    assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
    let client = body_json(&r)["client_id"].as_str().unwrap().to_string();
    let q = format!(
        "/authorize?response_type=code&client_id={client}&redirect_uri={}&code_challenge={CHALLENGE}&code_challenge_method=S256&state=xyz&scope={scope}&nonce=n-1",
        crate::files::http::percent_encode(CLAUDE)
    );
    let r = route_local(
        ctx,
        &req(
            "GET",
            &q,
            &[("Host", host), ("Sec-Fetch-Site", "cross-site")],
            b"",
        ),
    );
    assert_eq!(r.status, 200);
    assert!(r
        .header("Content-Security-Policy")
        .unwrap()
        .starts_with("default-src 'none'"));
    assert_eq!(r.header("X-Frame-Options"), Some("DENY"));
    let page = String::from_utf8(r.body.clone()).unwrap();
    // The code is on the page, in the browser that started this, and only there.
    let approval = code_on_page(&page);
    // The notice the app shows: the client, its name, where codes go and the scopes, and nothing secret.
    let notice: Json = store::read_json(&ctx.dir.join(APPROVALS_FILE)).unwrap();
    let w = &notice["waiting"][0];
    assert_eq!(w["name"], "Claude");
    assert_eq!(w["redirect_host"], "claude.ai");
    assert_eq!(w["client"], client.as_str());
    let raw = std::fs::read_to_string(ctx.dir.join(APPROVALS_FILE)).unwrap();
    for secret in [
        "pca_",
        "pcr_",
        "pcc_",
        "challenge",
        "state\"",
        approval.as_str(),
    ] {
        assert!(!raw.contains(secret), "{secret} in approvals.json");
    }
    let wait = page
        .split("url=")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .replace("&amp;", "&");
    assert_eq!(
        route_local(
            ctx,
            &req(
                "GET",
                &wait,
                &[("Host", host), ("Sec-Fetch-Site", "same-origin")],
                b""
            )
        )
        .status,
        200
    );
    ctx.with_state(|s| s.approve(&approval, None, false, store::now()))
        .unwrap()
        .unwrap();
    let r = route_local(
        ctx,
        &req(
            "GET",
            &wait,
            &[("Host", host), ("Sec-Fetch-Site", "same-origin")],
            b"",
        ),
    );
    assert_eq!(r.status, 302);
    let loc = r.header("Location").unwrap().to_string();
    assert!(loc.starts_with(CLAUDE), "{loc}");
    assert_eq!(param(&loc, "state").as_deref(), Some("xyz"));
    let code = param(&loc, "code").unwrap();
    let form = format!(
        "grant_type=authorization_code&client_id={client}&code={code}&redirect_uri={}&code_verifier={VERIFIER}",
        crate::files::http::percent_encode(CLAUDE)
    );
    let r = route_local(
        ctx,
        &req(
            "POST",
            "/token",
            &[
                ("Host", host),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            form.as_bytes(),
        ),
    );
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let t = body_json(&r);
    assert_eq!(t["nonce"], "n-1");
    // The same code again is a replay: refused, and the grant it made ends.
    let again = route_local(
        ctx,
        &req(
            "POST",
            "/token",
            &[
                ("Host", host),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            form.as_bytes(),
        ),
    );
    assert_eq!(body_json(&again)["error"], "invalid_grant");
    assert_eq!(
        mcp_post(
            ctx,
            host,
            t["access_token"].as_str().unwrap(),
            None,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
            BOTH
        )
        .status,
        401
    );
    // So connect once more for a token that works.
    let r = route_local(ctx, &req("GET", &q, &[("Host", host)], b""));
    assert_eq!(r.status, 200);
    let page = String::from_utf8(r.body.clone()).unwrap();
    let approval = code_on_page(&page);
    ctx.with_state(|s| s.approve(&approval, None, false, store::now()))
        .unwrap()
        .unwrap();
    let page = String::from_utf8(r.body).unwrap();
    let wait = page
        .split("url=")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .replace("&amp;", "&");
    let loc = route_local(ctx, &req("GET", &wait, &[("Host", host)], b""))
        .header("Location")
        .unwrap()
        .to_string();
    let form = format!(
        "grant_type=authorization_code&client_id={client}&code={}&redirect_uri={}&code_verifier={VERIFIER}",
        param(&loc, "code").unwrap(),
        crate::files::http::percent_encode(CLAUDE)
    );
    let t = body_json(&route_local(
        ctx,
        &req(
            "POST",
            "/token",
            &[
                ("Host", host),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            form.as_bytes(),
        ),
    ));
    (client, t["access_token"].as_str().unwrap().to_string())
}

#[test]
fn oauth_over_http_into_an_mcp_session() {
    let dir = temp("e2e");
    let ctx = ctx_in(&dir, Channel::Dev);
    let (client, token) = oauth_token(&ctx, LOCAL, "read");
    let r = mcp_post(
        &ctx,
        LOCAL,
        &token,
        None,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "clientInfo": {"name": "Claude"}}}),
        BOTH,
    );
    assert_eq!(r.status, 200);
    let sid = r.header("Mcp-Session-Id").unwrap().to_string();
    assert_eq!(
        body_json(&r)["result"]["serverInfo"]["name"],
        "polycarp-agent"
    );
    let r = mcp_post(
        &ctx,
        LOCAL,
        &token,
        Some(&sid),
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        BOTH,
    );
    assert_eq!(r.status, 202);
    let r = mcp_post(
        &ctx,
        LOCAL,
        &token,
        Some(&sid),
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        BOTH,
    );
    let names: Vec<String> = body_json(&r)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().into())
        .collect();
    assert!(names.contains(&"app_status".into()));
    assert!(
        !names
            .iter()
            .any(|n| n.starts_with("files_") || n == "app_setting_set"),
        "read only: {names:?}"
    );
    // An event-stream answer when the client takes only that.
    let r = mcp_post(
        &ctx,
        LOCAL,
        &token,
        Some(&sid),
        &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "app_status"}}),
        "text/event-stream",
    );
    assert_eq!(r.header("Content-Type"), Some("text/event-stream"));
    let text = String::from_utf8(r.body).unwrap();
    assert!(text.starts_with("event: message\ndata: {"), "{text}");
    assert!(text.contains("\"version\":\"0.9\""));
    // The GET stream opens for the session's owner.
    let auth = format!("Bearer {token}");
    let g = route_local(
        &ctx,
        &req(
            "GET",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Authorization", &auth),
                ("Accept", "text/event-stream"),
                ("Mcp-Session-Id", &sid),
            ],
            b"",
        ),
    );
    assert_eq!(g.stream.as_deref(), Some(sid.as_str()));
    // Another caller can't use or end this session.
    let (_, local_tok) = ctx
        .with_state(|s| s.create_bearer("codex", vec!["read".into()], false, store::now()))
        .unwrap()
        .unwrap();
    let r = mcp_post(
        &ctx,
        LOCAL,
        &local_tok,
        Some(&sid),
        &json!({"jsonrpc": "2.0", "id": 4, "method": "ping"}),
        BOTH,
    );
    assert_eq!(r.status, 404);
    let other = format!("Bearer {local_tok}");
    assert_eq!(
        route_local(
            &ctx,
            &req(
                "DELETE",
                "/mcp",
                &[
                    ("Host", LOCAL),
                    ("Authorization", &other),
                    ("Mcp-Session-Id", &sid)
                ],
                b""
            )
        )
        .status,
        404
    );
    assert_eq!(
        route_local(
            &ctx,
            &req(
                "DELETE",
                "/mcp",
                &[
                    ("Host", LOCAL),
                    ("Authorization", &auth),
                    ("Mcp-Session-Id", &sid)
                ],
                b""
            )
        )
        .status,
        204
    );
    assert_eq!(
        mcp_post(
            &ctx,
            LOCAL,
            &token,
            Some(&sid),
            &json!({"jsonrpc": "2.0", "id": 5, "method": "ping"}),
            BOTH
        )
        .status,
        404
    );
    // Revoking the client ends its token at once.
    ctx.with_state(|s| s.revoke(&client, store::now()))
        .unwrap()
        .unwrap();
    assert_eq!(
        mcp_post(
            &ctx,
            LOCAL,
            &token,
            None,
            &json!({"jsonrpc": "2.0", "id": 6, "method": "ping"}),
            BOTH
        )
        .status,
        401
    );
    // The state on disk is private.
    if cfg!(unix) {
        assert_eq!(store::mode(&dir.join(AUTH_FILE)), Some(0o600));
        assert_eq!(store::mode(&dir.join(APPROVALS_FILE)), Some(0o600));
        assert_eq!(store::mode(&dir), Some(0o700));
    }
    let raw = std::fs::read_to_string(dir.join(AUTH_FILE)).unwrap();
    assert!(
        !raw.contains(&token) && !raw.contains(&local_tok),
        "a token is stored in the clear"
    );
}

#[test]
fn mcp_requests_must_be_json_and_a_known_protocol_version() {
    let ctx = ctx_in(&temp("shape"), Channel::Dev);
    let (_, tok) = ctx
        .with_state(|s| s.create_bearer("t", vec!["read".into()], false, store::now()))
        .unwrap()
        .unwrap();
    let auth = format!("Bearer {tok}");
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Authorization", &auth),
                ("Content-Type", "text/plain"),
            ],
            b"{}",
        ),
    );
    assert_eq!(
        r.status, 415,
        "a simple-request content type never reaches a tool"
    );
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Authorization", &auth),
                ("Content-Type", "application/json"),
                ("MCP-Protocol-Version", "1999-01-01"),
            ],
            b"{}",
        ),
    );
    assert_eq!(r.status, 400);
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Authorization", &auth),
                ("Content-Type", "application/json"),
            ],
            b"not json",
        ),
    );
    assert_eq!(body_json(&r)["error"]["code"], -32700);
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/mcp",
            &[
                ("Host", LOCAL),
                ("Authorization", &auth),
                ("Content-Type", "application/json"),
            ],
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}",
        ),
    );
    assert_eq!(r.status, 200, "no session: one message on its own");
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/token",
            &[("Host", LOCAL), ("Content-Type", "application/json")],
            b"{}",
        ),
    );
    assert_eq!(body_json(&r)["error"], "invalid_request");
    let r = route_local(
        &ctx,
        &req(
            "POST",
            "/token",
            &[
                ("Host", LOCAL),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            b"grant_type=a&grant_type=b",
        ),
    );
    assert!(body_json(&r)["error_description"]
        .as_str()
        .unwrap()
        .contains("repeated"));
}

fn write_tunnel(dir: &std::path::Path, kind: &str) {
    store::write_json(
        &dir.join(store::TUNNEL_FILE),
        &Tunnel {
            kind: kind.into(),
            public_url: "https://agent.example.com".into(),
            host: "agent.example.com".into(),
            name: Some("polycarp-agent".into()),
            created: 1,
        },
    )
    .unwrap();
}

#[test]
fn a_tunnel_works_on_dev_and_nightly_and_stable_gets_the_waitlist() {
    let dir = temp("tunnel");
    write_tunnel(&dir, "cloudflare");
    let h = [("Host", "agent.example.com")];
    for c in [Channel::Dev, Channel::Nightly] {
        let ctx = ctx_in(&dir, c);
        let r = route_local(
            &ctx,
            &req("GET", "/.well-known/oauth-protected-resource", &h, b""),
        );
        assert_eq!(r.status, 200);
        assert_eq!(body_json(&r)["resource"], "https://agent.example.com/mcp");
    }
    let stable = ctx_in(&dir, Channel::Stable);
    for kind in ["cloudflare", "tailscale", "funnel"] {
        write_tunnel(&dir, kind);
        let r = route_local(&stable, &req("GET", "/health", &h, b""));
        assert_eq!(r.status, 403, "{kind}");
        let b = body_json(&r);
        assert_eq!(b["error"]["code"], "waitlisted");
        assert!(b["error"]["message"]
            .as_str()
            .unwrap()
            .contains(WAITLIST_URL));
    }
    // An invite is for the hosted tunnel, not one's own.
    policy::redeem(&dir, Channel::Stable, "pcinv_abcdefgh", 1).unwrap();
    assert_eq!(
        route_local(&stable, &req("GET", "/health", &h, b"")).status,
        403
    );
    // Local still works on stable.
    assert_eq!(
        route_local(&stable, &req("GET", "/health", &[("Host", LOCAL)], b"")).status,
        200
    );
}

#[test]
fn a_local_token_stays_off_the_tunnel_unless_made_for_it() {
    let dir = temp("tunneltok");
    write_tunnel(&dir, "cloudflare");
    let ctx = ctx_in(&dir, Channel::Dev);
    let (_, local) = ctx
        .with_state(|s| s.create_bearer("codex", vec!["read".into()], false, store::now()))
        .unwrap()
        .unwrap();
    let (_, remote) = ctx
        .with_state(|s| s.create_bearer("grok", vec!["read".into()], true, store::now()))
        .unwrap()
        .unwrap();
    let ping = json!({"jsonrpc": "2.0", "id": 1, "method": "ping"});
    assert_eq!(mcp_post(&ctx, LOCAL, &local, None, &ping, BOTH).status, 200);
    assert_eq!(
        mcp_post(&ctx, "agent.example.com", &local, None, &ping, BOTH).status,
        401
    );
    assert_eq!(
        mcp_post(&ctx, "agent.example.com", &remote, None, &ping, BOTH).status,
        200
    );
}

#[test]
fn basic_auth_and_base64() {
    assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
    assert_eq!(base64_decode("YQ").unwrap(), b"a");
    assert!(base64_decode("a").is_none() && base64_decode("!!!!").is_none());
    assert_eq!(
        basic_auth(Some(&format!("Basic {}", store::b64url(b"pcl_x:a%20b")))),
        Some(("pcl_x".into(), "a b".into()))
    );
    assert_eq!(basic_auth(Some("Bearer x")), None);
}

// ------------------------------------------------------------------------------------------------
// The tailnet listener, with a stub Tailscale
// ------------------------------------------------------------------------------------------------

struct Stub {
    peer: Option<Node>,
}

impl Tailnet for Stub {
    fn status(&self) -> Result<Status, String> {
        Ok(Status::default())
    }
    fn whois(&self, _: SocketAddr) -> Result<Node, String> {
        self.peer.clone().ok_or_else(|| "no such peer".into())
    }
}

fn node(name: &str, user: i64, tags: &[&str]) -> Node {
    Node {
        name: name.into(),
        dns: format!("{name}.tail.ts.net"),
        ips: vec!["127.0.0.1".parse().unwrap()],
        user,
        online: true,
        os: "macOS".into(),
        tags: tags.iter().map(|t| t.to_string()).collect(),
    }
}

/// One request through a real tailnet listener whose whois says `peer`.
fn over_tailnet(peer: Option<Node>, allow: &[&str], raw: &dyn Fn(u16) -> String) -> (u16, String) {
    let dir = temp(&format!("tn-{}", store::b64url(&store::random(4))));
    let mut ctx = ctx_in(&dir, Channel::Stable);
    ctx.settings.allow_devices = allow.iter().map(|s| s.to_string()).collect();
    ctx.tailnet = Some(TailCtx::new(Arc::new(Stub { peer }), node("mac", 7, &[])));
    let (_, tok) = ctx
        .with_state(|s| s.create_bearer("grokbot", vec!["read".into()], false, store::now()))
        .unwrap()
        .unwrap();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let t = std::thread::spawn(move || serve_one_tailnet(&ctx, &l));
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let text = raw(port).replace("TOKEN", &tok);
    s.write_all(text.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    t.join().unwrap();
    let status = out.split(' ').nth(1).unwrap_or("0").parse().unwrap_or(0);
    (status, out)
}

fn mcp_ping(port: u16) -> String {
    let body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
    format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer TOKEN\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn the_tailnet_lets_in_the_owners_devices_and_no_one_else() {
    // The owner's laptop, with a token: in, on every channel (this one is stable).
    let (s, out) = over_tailnet(Some(node("laptop", 7, &[])), &[], &mcp_ping);
    assert_eq!(s, 200, "{out}");
    // The owner's device without a token: whois isn't enough.
    let (s, _) = over_tailnet(Some(node("laptop", 7, &[])), &[], &|p| {
        mcp_ping(p).replace("Bearer TOKEN", "Bearer nope")
    });
    assert_eq!(s, 401);
    // Another person's device, a tagged one, one whois can't name, or one outside allow_devices: out before the request
    // is read.
    for (peer, allow) in [
        (Some(node("theirs", 8, &[])), vec![]),
        (Some(node("server", 7, &["tag:server"])), vec![]),
        (None, vec![]),
        (Some(node("laptop", 7, &[])), vec!["phone"]),
    ] {
        let (s, out) = over_tailnet(peer.clone(), &allow, &mcp_ping);
        assert_eq!(s, 403, "{peer:?} {allow:?}: {out}");
    }
    let (s, _) = over_tailnet(Some(node("laptop", 7, &[])), &["laptop"], &mcp_ping);
    assert_eq!(s, 200);
    // A web page on the owner's device, a rebinding Host, and the OAuth pages: all refused on the tailnet.
    let (s, _) = over_tailnet(Some(node("laptop", 7, &[])), &[], &|p| {
        mcp_ping(p).replace(
            "Content-Type",
            "Origin: https://evil.example\r\nContent-Type",
        )
    });
    assert_eq!(s, 403);
    let (s, _) = over_tailnet(Some(node("laptop", 7, &[])), &[], &|p| {
        mcp_ping(p).replace(&format!("127.0.0.1:{p}"), "evil.example")
    });
    assert_eq!(s, 403);
    let (s, _) = over_tailnet(Some(node("laptop", 7, &[])), &[], &|p| {
        format!("GET /authorize HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n")
    });
    assert_eq!(s, 404);
}

/// A real loopback listener on a free port, for wire-level tests.
fn listen(ctx: Ctx) -> SocketAddr {
    let ctx = Arc::new(ctx);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = serve(ctx, &["127.0.0.1:0".parse().unwrap()], &[], &|a| {
            let _ = tx.send(a[0]);
        });
    });
    rx.recv_timeout(Duration::from_secs(5)).unwrap()
}

/// Sends raw bytes and reads the whole answer.
fn exchange(addr: SocketAddr, raw: &[u8]) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    s.write_all(raw).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    String::from_utf8_lossy(&out).into_owned()
}

fn health_ok(addr: SocketAddr) -> bool {
    let raw = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        addr.port()
    );
    exchange(addr, raw.as_bytes()).starts_with("HTTP/1.1 200")
}

#[test]
fn a_chunk_size_that_would_overflow_is_refused_and_the_server_keeps_serving() {
    let addr = listen(ctx_in(&temp("overflow"), Channel::Dev));
    let host = format!("127.0.0.1:{}", addr.port());
    for size in [
        "ffffffffffffffff",
        "fffffffffffffffff",
        "10000000000000000",
        "+1",
        "400001",
    ] {
        let raw = format!(
            "POST /register HTTP/1.1\r\nHost: {host}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n{size}\r\n"
        );
        let out = exchange(addr, raw.as_bytes());
        assert!(
            out.starts_with("HTTP/1.1 400") || out.starts_with("HTTP/1.1 413"),
            "{size}: {out}"
        );
        assert!(health_ok(addr), "the server stopped after {size}");
    }
    // The parser alone: the huge size never reaches an addition.
    let raw =
        b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\nffffffffffffffff\r\n";
    let e = read_req(&mut Cursor::new(raw.to_vec())).unwrap_err().0;
    assert!(e == 400 || e == 413, "{e}");
}

#[test]
fn a_dropped_slot_gives_its_count_back_even_through_a_panic() {
    let n = Arc::new(AtomicUsize::new(1));
    let m = Arc::clone(&n);
    let _ = std::thread::spawn(move || {
        let _slot = Slot(&m);
        panic!("a handler fell over");
    })
    .join();
    assert_eq!(n.load(Ordering::SeqCst), 0);
}

/// A tunnel visitor registers as "Claude" with its own callback and starts connecting. Plain `approve <code>` refuses
/// it, and no published surface (approvals.json, doctor, the serve log's inputs) carries the code to approve it by.
#[test]
fn a_tunnel_visitor_named_like_an_assistant_cant_be_approved_by_a_plain_approve() {
    let dir = temp("spoof");
    write_tunnel(&dir, "cloudflare");
    let settings = Settings {
        extra_redirects: vec!["https://evil.example/cb".into()],
        ..Settings::default()
    };
    let ctx = Ctx::new(
        dir.clone(),
        Gateway::new(Arc::new(Fake::new(true))),
        Channel::Nightly,
        settings,
    );
    let tunnel = "agent.example.com";
    let start = |redirect: &str, host: &str| -> (String, String) {
        let r = route_local(
            &ctx,
            &req(
                "POST",
                "/register",
                &[("Host", host), ("Content-Type", "application/json")],
                json!({"redirect_uris": [redirect], "client_name": "Claude"})
                    .to_string()
                    .as_bytes(),
            ),
        );
        assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
        let client = body_json(&r)["client_id"].as_str().unwrap().to_string();
        let q = format!(
            "/authorize?response_type=code&client_id={client}&redirect_uri={}&code_challenge={CHALLENGE}&code_challenge_method=S256&state=s&scope=read",
            crate::files::http::percent_encode(redirect)
        );
        let r = route_local(&ctx, &req("GET", &q, &[("Host", host)], b""));
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        (client, code_on_page(&String::from_utf8(r.body).unwrap()))
    };

    let (client, code) = start("https://evil.example/cb", tunnel);
    // What the owner can see without the page: the client id, where codes go, how it came. Never the code.
    let raw = std::fs::read_to_string(dir.join(APPROVALS_FILE)).unwrap();
    assert!(!raw.contains(&code), "the code is in approvals.json: {raw}");
    assert!(!raw.contains(&code.replace('-', "")), "{raw}");
    let notice: Json = serde_json::from_str(&raw).unwrap();
    let w = &notice["waiting"][0];
    assert_eq!(w["client"], client.as_str());
    assert_eq!(w["redirect_host"], "evil.example");
    assert_eq!(w["origin"], "tunnel");
    assert_eq!(w["unverified"], true);
    assert!(w.get("approval").is_none() && w.get("command").is_none());
    let facts = crate::agent::doctor::gather(&dir, Channel::Nightly, false, None);
    let advice = crate::agent::doctor::fixes(&facts).join("\n");
    assert!(
        !advice.contains(&code),
        "the code is in doctor's advice: {advice}"
    );
    assert!(
        advice.contains(&client)
            && advice.contains("evil.example")
            && advice.contains("unverified"),
        "{advice}"
    );
    let as_json = serde_json::to_string(&facts).unwrap();
    assert!(!as_json.contains(&code), "the code is in doctor --json");

    // Plain approve refuses, says where the code would go, and leaves the request waiting.
    let e = ctx
        .with_state(|s| s.approve(&code, None, false, store::now()))
        .unwrap()
        .unwrap_err();
    assert!(
        e.contains("evil.example") && e.contains("--unverified"),
        "{e}"
    );
    let st: State = store::read_json(&dir.join(AUTH_FILE)).unwrap();
    assert!(st.clients[&client].approved.is_none());
    // The owner who started it on purpose says so.
    ctx.with_state(|s| s.approve(&code, None, true, store::now()))
        .unwrap()
        .unwrap();

    // A tunnel request whose code goes to the assistant's own host is approved plainly.
    let (_, code) = start(CLAUDE, tunnel);
    ctx.with_state(|s| s.approve(&code, None, false, store::now()))
        .unwrap()
        .unwrap();
    // So is the owner's own extra callback, started on this machine.
    let (_, code) = start("https://evil.example/cb", "127.0.0.1:41772");
    ctx.with_state(|s| s.approve(&code, None, false, store::now()))
        .unwrap()
        .unwrap();
}
