//! The OAuth flows end to end against a `State`, with the clock passed in.

use super::*;

const RESOURCE: &str = "https://agent.example.com/mcp";
const ISSUER: &str = "https://agent.example.com";
const CLAUDE: &str = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const T0: i64 = 1_800_000_000;

fn form(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn register(st: &mut State) -> String {
    let r = st
        .register(
            &json!({"redirect_uris": [CLAUDE], "client_name": "Claude <b>"}),
            &[],
            T0,
        )
        .unwrap();
    assert_eq!(r["client_name"], "Claude b", "markup is dropped from names");
    assert!(
        r.get("client_secret").is_none(),
        "a public client gets no key"
    );
    r["client_id"].as_str().unwrap().to_string()
}

fn authorize_query(client: &str, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut q = form(&[
        ("client_id", client),
        ("redirect_uri", CLAUDE),
        ("response_type", "code"),
        ("code_challenge", CHALLENGE),
        ("code_challenge_method", "S256"),
        ("state", "st-123"),
        ("scope", "read files"),
    ]);
    for (k, v) in extra {
        q.retain(|(key, _)| key != k);
        if !v.is_empty() {
            q.push((k.to_string(), v.to_string()));
        }
    }
    q
}

fn param(url: &str, k: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|p| {
        let (key, v) = p.split_once('=')?;
        (key == k).then(|| crate::files::http::percent_decode(v))
    })
}

/// Register, authorize, approve here, collect the code from the waiting page.
fn code_for(st: &mut State, client: &str) -> String {
    let (request, p) = st
        .authorize(&authorize_query(client, &[]), RESOURCE, T0)
        .unwrap();
    assert!(matches!(
        st.poll(&request, ISSUER, T0 + 1),
        Poll::Waiting(_)
    ));
    st.approve(&p.approval.to_lowercase(), None, T0 + 2)
        .unwrap();
    let Poll::Redirect(url) = st.poll(&request, ISSUER, T0 + 3) else {
        panic!("approved, so the page redirects");
    };
    assert!(url.starts_with(CLAUDE));
    assert_eq!(param(&url, "state").as_deref(), Some("st-123"));
    assert_eq!(param(&url, "iss").as_deref(), Some(ISSUER));
    // The code is made once: a second look gets nothing.
    assert!(matches!(st.poll(&request, ISSUER, T0 + 4), Poll::Gone(_)));
    param(&url, "code").unwrap()
}

fn exchange(
    st: &mut State,
    client: &str,
    code: &str,
    verifier: &str,
    now: i64,
) -> Result<Json, OAuthErr> {
    st.token(
        &form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client),
            ("code", code),
            ("redirect_uri", CLAUDE),
            ("code_verifier", verifier),
        ]),
        None,
        now,
    )
}

fn refresh(st: &mut State, client: &str, token: &str, now: i64) -> Result<Json, OAuthErr> {
    st.token(
        &form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client),
            ("refresh_token", token),
        ]),
        None,
        now,
    )
}

fn bearer(tok: &Json, k: &str) -> String {
    format!("Bearer {}", tok[k].as_str().unwrap())
}

#[test]
fn the_whole_flow_gives_a_token_with_the_owners_scopes() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let tok = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    assert_eq!(tok["scope"], "read files");
    assert_eq!(tok["token_type"], "Bearer");
    let who = st
        .verify(Some(&bearer(&tok, "access_token")), RESOURCE, true, T0 + 6)
        .unwrap();
    assert_eq!(who.kind, CallerKind::OAuth);
    assert!(who.may("files") && !who.may("act"));
    // The access token is for this endpoint only, and dies on time.
    assert!(st
        .verify(
            Some(&bearer(&tok, "access_token")),
            "https://other.example/mcp",
            true,
            T0 + 6
        )
        .is_none());
    assert!(st
        .verify(
            Some(&bearer(&tok, "access_token")),
            RESOURCE,
            true,
            T0 + 5 + ACCESS_TTL
        )
        .is_none());
    // A refresh token is not an access token.
    assert!(st
        .verify(Some(&bearer(&tok, "refresh_token")), RESOURCE, true, T0 + 6)
        .is_none());
    // Nothing secret is stored in the clear.
    let saved = serde_json::to_string(&st).unwrap();
    for k in ["access_token", "refresh_token"] {
        assert!(
            !saved.contains(tok[k].as_str().unwrap()),
            "{k} stored in the clear"
        );
    }
    assert!(!saved.contains(&code));
}

#[test]
fn the_owner_narrows_or_widens_scopes_here_and_can_say_no() {
    let mut st = State::default();
    let c = register(&mut st);
    let (request, p) = st
        .authorize(&authorize_query(&c, &[]), RESOURCE, T0)
        .unwrap();
    assert_eq!(p.scopes, vec!["read", "files"]);
    let got = st
        .approve(&p.approval, Some(vec!["read".into(), "act".into()]), T0 + 1)
        .unwrap();
    assert_eq!(
        got.decision,
        Some(Decision::Approved(vec!["read".into(), "act".into()]))
    );
    assert_eq!(st.clients[&c].scopes, vec!["read", "act"]);
    assert!(st.clients[&c].approved.is_some());
    let Poll::Redirect(url) = st.poll(&request, ISSUER, T0 + 2) else {
        panic!()
    };
    let tok = exchange(&mut st, &c, &param(&url, "code").unwrap(), VERIFIER, T0 + 3).unwrap();
    assert_eq!(tok["scope"], "read act");
    // No scope asked: read only, until the owner grants more.
    let (_, p) = st
        .authorize(&authorize_query(&c, &[("scope", "")]), RESOURCE, T0)
        .unwrap();
    assert_eq!(p.scopes, vec!["read"]);
    // A no.
    let (request, p) = st
        .authorize(&authorize_query(&c, &[]), RESOURCE, T0)
        .unwrap();
    st.deny(&p.approval, T0 + 1).unwrap();
    let Poll::Redirect(url) = st.poll(&request, ISSUER, T0 + 2) else {
        panic!()
    };
    assert_eq!(param(&url, "error").as_deref(), Some("access_denied"));
    assert_eq!(param(&url, "state").as_deref(), Some("st-123"));
    assert!(param(&url, "code").is_none());
    // An approval code works once, and not after it expires.
    assert!(st.approve(&p.approval, None, T0 + 3).is_err());
    let (_, p) = st
        .authorize(&authorize_query(&c, &[]), RESOURCE, T0)
        .unwrap();
    assert!(st.approve(&p.approval, None, T0 + PENDING_TTL + 1).is_err());
}

#[test]
fn a_wrong_pkce_verifier_is_refused_and_burns_the_code() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let wrong = "A".repeat(43);
    let e = exchange(&mut st, &c, &code, &wrong, T0 + 5).unwrap_err();
    assert_eq!((e.status, e.error), (400, "invalid_grant"));
    assert!(e.description.contains("PKCE"), "{}", e.description);
    // The right verifier is too late: the code is gone.
    assert!(exchange(&mut st, &c, &code, VERIFIER, T0 + 6).is_err());
    // No verifier at all, and plain PKCE at the start, are refused too.
    let code = code_for(&mut st, &c);
    assert!(exchange(&mut st, &c, &code, "", T0 + 5).is_err());
    let e = st
        .authorize(
            &authorize_query(&c, &[("code_challenge_method", "plain")]),
            RESOURCE,
            T0,
        )
        .unwrap_err();
    let AuthzErr::Redirect(url) = e else {
        panic!("{e:?}")
    };
    assert_eq!(param(&url, "error").as_deref(), Some("invalid_request"));
    assert!(st
        .authorize(
            &authorize_query(&c, &[("code_challenge", "short")]),
            RESOURCE,
            T0
        )
        .is_err());
}

#[test]
fn a_redirect_uri_that_does_not_match_exactly_never_gets_a_code() {
    let mut st = State::default();
    let c = register(&mut st);
    for other in [
        "https://claude.ai/api/mcp/auth_callback/",
        "https://claude.ai/api/mcp/auth_callback?x=1",
        "https://evil.example/cb",
        "https://CLAUDE.ai/api/mcp/auth_callback",
    ] {
        let e = st
            .authorize(
                &authorize_query(&c, &[("redirect_uri", other)]),
                RESOURCE,
                T0,
            )
            .unwrap_err();
        assert!(matches!(e, AuthzErr::Page(_)), "{other}: {e:?}");
    }
    // The token request must name the same redirect too.
    let code = code_for(&mut st, &c);
    let e = st
        .token(
            &form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &c),
                ("code", &code),
                ("redirect_uri", "https://claude.com/api/mcp/auth_callback"),
                ("code_verifier", VERIFIER),
            ]),
            None,
            T0 + 5,
        )
        .unwrap_err();
    assert!(e.description.contains("redirect_uri"), "{}", e.description);
    // Registration takes only the known callbacks.
    for bad in [
        "https://evil.example/cb",
        "http://evil.example/cb",
        "https://claude.ai/other",
        "https://claude.ai@evil.example/api/mcp/auth_callback",
        "https://grok.com.evil.example/cb",
        "https://chatgpt.com/connector/oauth/../x",
        "javascript:alert(1)",
        "https://claude.ai/api/mcp/auth_callback#frag",
    ] {
        assert!(!redirect_allowed(bad, &[]), "{bad}");
        let e = st
            .register(&json!({"redirect_uris": [bad]}), &[], T0)
            .unwrap_err();
        assert_eq!(e.error, "invalid_redirect_uri", "{bad}");
    }
    for good in [
        CLAUDE,
        "https://claude.com/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/abc_123",
        "https://grok.com/any/path",
        "http://127.0.0.1:33418/callback",
        "http://localhost/cb",
        "http://[::1]:9/cb",
    ] {
        assert!(redirect_allowed(good, &[]), "{good}");
    }
    assert!(redirect_allowed(
        "https://mine.example/cb",
        &["https://mine.example/cb".to_string()]
    ));
}

#[test]
fn state_is_required_and_comes_back_unchanged() {
    let mut st = State::default();
    let c = register(&mut st);
    let e = st
        .authorize(&authorize_query(&c, &[("state", "")]), RESOURCE, T0)
        .unwrap_err();
    let AuthzErr::Redirect(url) = e else { panic!() };
    assert_eq!(param(&url, "error").as_deref(), Some("invalid_request"));
    let odd = "a b&c=d/é";
    let (request, p) = st
        .authorize(
            &authorize_query(&c, &[("state", odd), ("nonce", "n-1")]),
            RESOURCE,
            T0,
        )
        .unwrap();
    st.approve(&p.approval, None, T0).unwrap();
    let Poll::Redirect(url) = st.poll(&request, ISSUER, T0) else {
        panic!()
    };
    assert_eq!(param(&url, "state").as_deref(), Some(odd));
    let tok = exchange(&mut st, &c, &param(&url, "code").unwrap(), VERIFIER, T0 + 1).unwrap();
    assert_eq!(tok["nonce"], "n-1", "the nonce is bound to the grant");
}

#[test]
fn a_replayed_code_is_refused_and_ends_the_grant_it_made() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let tok = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    assert!(st
        .verify(Some(&bearer(&tok, "access_token")), RESOURCE, true, T0 + 6)
        .is_some());
    let e = exchange(&mut st, &c, &code, VERIFIER, T0 + 7).unwrap_err();
    assert_eq!(e.error, "invalid_grant");
    assert!(
        st.verify(Some(&bearer(&tok, "access_token")), RESOURCE, true, T0 + 8)
            .is_none(),
        "the replay ended the grant"
    );
    assert!(refresh(&mut st, &c, tok["refresh_token"].as_str().unwrap(), T0 + 9).is_err());
    // A code expires on its own too.
    let code = code_for(&mut st, &c);
    assert!(exchange(&mut st, &c, &code, VERIFIER, T0 + 3 + CODE_TTL + 1).is_err());
    // And belongs to its client only.
    let other = register(&mut st);
    let code = code_for(&mut st, &c);
    assert!(exchange(&mut st, &other, &code, VERIFIER, T0 + 5).is_err());
}

#[test]
fn refresh_tokens_rotate_and_a_spent_one_ends_the_grant() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let first = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    let r1 = first["refresh_token"].as_str().unwrap().to_string();
    let second = refresh(&mut st, &c, &r1, T0 + 100).unwrap();
    let r2 = second["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(r1, r2, "a refresh gives a new refresh token");
    assert!(
        st.verify(
            Some(&bearer(&first, "access_token")),
            RESOURCE,
            true,
            T0 + 101
        )
        .is_none(),
        "the old access token ends with the refresh"
    );
    assert!(st
        .verify(
            Some(&bearer(&second, "access_token")),
            RESOURCE,
            true,
            T0 + 101
        )
        .is_some());
    // The spent one comes back: someone has a copy, so the whole grant ends, the new pair too.
    let e = refresh(&mut st, &c, &r1, T0 + 200).unwrap_err();
    assert!(e.description.contains("already used"), "{}", e.description);
    assert!(st
        .verify(
            Some(&bearer(&second, "access_token")),
            RESOURCE,
            true,
            T0 + 201
        )
        .is_none());
    assert!(refresh(&mut st, &c, &r2, T0 + 202).is_err());
    // A refresh can narrow the scopes but never widen them.
    let code = code_for(&mut st, &c);
    let t = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    let r = t["refresh_token"].as_str().unwrap();
    let wide = st.token(
        &form(&[
            ("grant_type", "refresh_token"),
            ("client_id", &c),
            ("refresh_token", r),
            ("scope", "read act"),
        ]),
        None,
        T0 + 6,
    );
    assert_eq!(wide.unwrap_err().error, "invalid_scope");
    let narrow = st
        .token(
            &form(&[
                ("grant_type", "refresh_token"),
                ("client_id", &c),
                ("refresh_token", r),
                ("scope", "read"),
            ]),
            None,
            T0 + 7,
        )
        .unwrap();
    assert_eq!(narrow["scope"], "read");
}

#[test]
fn an_expired_refresh_token_is_refused() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let t = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    let r = t["refresh_token"].as_str().unwrap();
    let e = refresh(&mut st, &c, r, T0 + 5 + REFRESH_TTL).unwrap_err();
    assert_eq!(e.error, "invalid_grant");
    st.prune(T0 + 5 + REFRESH_TTL);
    assert!(st.tokens.is_empty(), "expired tokens are dropped");
}

#[test]
fn a_revoked_client_loses_every_grant_and_must_register_again() {
    let mut st = State::default();
    let c = register(&mut st);
    let code = code_for(&mut st, &c);
    let t = exchange(&mut st, &c, &code, VERIFIER, T0 + 5).unwrap();
    let (_, waiting) = st
        .authorize(&authorize_query(&c, &[]), RESOURCE, T0)
        .unwrap();
    assert_eq!(st.revoke(&c, T0 + 6), Ok("client"));
    assert!(st
        .verify(Some(&bearer(&t, "access_token")), RESOURCE, true, T0 + 7)
        .is_none());
    let e = refresh(&mut st, &c, t["refresh_token"].as_str().unwrap(), T0 + 8).unwrap_err();
    assert_eq!((e.status, e.error), (401, "invalid_client"));
    assert!(
        st.approve(&waiting.approval, None, T0 + 9).is_err(),
        "its waiting request went too"
    );
    assert!(matches!(
        st.authorize(&authorize_query(&c, &[]), RESOURCE, T0 + 10),
        Err(AuthzErr::Page(_))
    ));
    assert!(st.revoke(&c, T0 + 11).is_err(), "already gone");
}

#[test]
fn a_confidential_client_must_present_its_key() {
    let mut st = State::default();
    let r = st
        .register(
            &json!({"redirect_uris": [CLAUDE], "token_endpoint_auth_method": "client_secret_basic"}),
            &[],
            T0,
        )
        .unwrap();
    let c = r["client_id"].as_str().unwrap().to_string();
    let key = r["client_secret"].as_str().unwrap().to_string();
    let code = code_for(&mut st, &c);
    assert_eq!(
        exchange(&mut st, &c, &code, VERIFIER, T0 + 5)
            .unwrap_err()
            .error,
        "invalid_client"
    );
    let ok = st.token(
        &form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", CLAUDE),
            ("code_verifier", VERIFIER),
        ]),
        Some((c.clone(), key)),
        T0 + 6,
    );
    assert!(ok.is_ok(), "{ok:?}");
}

#[test]
fn local_bearer_tokens_are_hashed_scoped_revocable_and_stay_off_tunnels_unless_asked() {
    let mut st = State::default();
    let (id, token) = st
        .create_bearer("Grok Bot", vec!["read".into(), "files".into()], false, T0)
        .unwrap();
    assert!(token.starts_with("pct_"));
    assert!(!serde_json::to_string(&st).unwrap().contains(&token));
    let h = format!("Bearer {token}");
    let who = st
        .verify(Some(&h), "http://127.0.0.1:41772/mcp", false, T0)
        .unwrap();
    assert_eq!(
        (who.kind, who.name.as_str()),
        (CallerKind::Token, "Grok Bot")
    );
    assert!(
        st.verify(Some(&h), RESOURCE, true, T0).is_none(),
        "not through a tunnel"
    );
    assert!(st
        .verify(Some(&format!("Bearer {token}x")), RESOURCE, false, T0)
        .is_none());
    assert!(
        st.verify(Some(&token), RESOURCE, false, T0).is_none(),
        "needs the Bearer scheme"
    );
    let (_, remote) = st
        .create_bearer("cloud", vec!["read".into()], true, T0)
        .unwrap();
    assert!(st
        .verify(Some(&format!("Bearer {remote}")), RESOURCE, true, T0)
        .is_some());
    assert_eq!(st.revoke(&id, T0 + 1), Ok("token"));
    assert!(st
        .verify(Some(&h), "http://127.0.0.1:41772/mcp", false, T0 + 2)
        .is_none());
    assert!(st
        .create_bearer("bad/name", vec!["read".into()], false, T0)
        .is_err());
    assert!(st.create_bearer("x", vec![], false, T0).is_err());
    let list = st.listing(T0);
    assert_eq!(
        list["tokens"].as_array().unwrap().len(),
        1,
        "revoked tokens are not listed"
    );
    assert!(!list.to_string().contains("hash"));
}

#[test]
fn scopes_parse_strictly() {
    assert_eq!(parse_scopes("act, read").unwrap(), vec!["read", "act"]);
    assert_eq!(parse_scopes("read files act contacts").unwrap().len(), 4);
    assert!(parse_scopes("").is_err());
    assert!(parse_scopes("read,admin").is_err());
    assert!(parse_scopes("*").is_err());
}

#[test]
fn same_resource_treats_loopback_names_alike() {
    assert!(same_resource(
        "http://localhost:41772/mcp",
        "http://127.0.0.1:41772/mcp/"
    ));
    assert!(same_resource(
        "http://[::1]:41772/mcp",
        "http://127.0.0.1:41772/mcp"
    ));
    assert!(!same_resource(
        "http://127.0.0.1:41773/mcp",
        "http://127.0.0.1:41772/mcp"
    ));
    assert!(!same_resource(
        RESOURCE,
        "https://agent.example.com.evil/mcp"
    ));
}
