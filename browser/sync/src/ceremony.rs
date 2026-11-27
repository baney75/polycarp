//! The page a passkey is asked on: one page, for one question, on a port of its own, gone once answered.
//!
//! The browser gives passkeys to secure pages only. `http://localhost` is one, and nothing is sent off this computer.

use crate::passkey::{self, Passkey, EXPIRES_MS};
use crate::seal::{hash, random};
use crate::secret::Secret;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderName, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use data_encoding::BASE64URL_NOPAD;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

const PAGE: &str = include_str!("../page/ceremony.html");
const MAX_BODY: usize = 64 * 1024;

/// What the page says.
#[derive(Clone, Debug, Default)]
pub struct Words {
    pub title: String,
    pub lines: Vec<String>,
    /// The six digits to compare.
    pub code: Option<String>,
    pub go: String,
    /// Shown when the person may go on without.
    pub skip: Option<String>,
}

/// What is asked of the passkey.
pub enum Ask {
    /// Options from `passkey::begin`.
    Register(Value),
    Allow {
        passkeys: Vec<Passkey>,
        challenge: [u8; 32],
        prf: Option<[u8; 32]>,
    },
}

#[derive(Debug)]
pub struct Answer {
    /// `PublicKeyCredential.toJSON()`, or none when the person skipped.
    pub credential: Option<Value>,
    /// The key the passkey made, when it was asked for one and can.
    pub prf: Option<Secret>,
    /// Whether a new passkey says it can make keys.
    pub makes_keys: bool,
    verdict: oneshot::Sender<Result<String, String>>,
}

impl Answer {
    /// Tells the page what came of it.
    pub fn done(self, verdict: Result<&str, String>) {
        // The person may have closed the page.
        let _ = self.verdict.send(verdict.map(str::to_string));
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Unanswered {
    /// Five minutes went by.
    Expired,
    /// The answer came from a page on another address.
    Origin,
}

impl std::fmt::Display for Unanswered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Unanswered::Expired => "nobody answered within five minutes",
            Unanswered::Origin => "the answer came from a different page",
        })
    }
}

/// A question waiting on its page. Dropping it takes the page down.
pub struct Ceremony {
    url: String,
    answers: mpsc::Receiver<Said>,
    origin: String,
    _servers: JoinSet<io::Result<()>>,
}

impl std::fmt::Debug for Ceremony {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ceremony(..)")
    }
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    skip: bool,
    answer: Option<Value>,
    prf: Option<Secret>,
    makes_keys: Option<bool>,
}

/// What the page sent, and where its verdict goes.
type Said = (Reply, oneshot::Sender<Result<String, String>>);

struct Waiting {
    host: String,
    origin: String,
    may_skip: bool,
    get: [u8; 32],
    post: [u8; 32],
    /// Taken by the first visit.
    page: Mutex<Option<String>>,
    /// Taken by the first answer.
    answer: Mutex<Option<mpsc::Sender<Said>>>,
    nonce: String,
}

impl Ceremony {
    pub async fn open(ask: Ask, words: Words) -> io::Result<Ceremony> {
        let (listeners, port) = listen().await?;
        let (get, post, nonce) = (token(), token(), token());
        let (register, options) = match ask {
            Ask::Register(options) => (true, options),
            Ask::Allow {
                passkeys,
                challenge,
                prf,
            } => {
                let options = passkey::request(&passkeys, &challenge, prf.as_ref());
                (false, options.map_err(|e| io::Error::other(e.to_string()))?)
            }
        };
        let data = json!({
            "register": register,
            "options": options,
            "post": format!("/{post}"),
            "words": {
                "title": words.title, "lines": words.lines, "code": words.code, "go": words.go, "skip": words.skip,
            },
        });
        // Inside a script element only "<" can end it.
        let data = data.to_string().replace('<', "\\u003c");
        let page = PAGE.replace("__NONCE__", &nonce).replace("__DATA__", &data);
        let (send, answers) = mpsc::channel(1);
        let host = format!("localhost:{port}");
        let origin = format!("http://{host}");
        let waiting = Arc::new(Waiting {
            host,
            origin: origin.clone(),
            may_skip: words.skip.is_some(),
            get: path_hash(&get),
            post: path_hash(&post),
            page: Mutex::new(Some(page)),
            answer: Mutex::new(Some(send)),
            nonce,
        });
        let app = Router::new()
            .fallback(serve)
            .layer(DefaultBodyLimit::max(MAX_BODY))
            .with_state(waiting);
        let mut servers = JoinSet::new();
        for listener in listeners {
            let app = app.clone();
            servers.spawn(async move { axum::serve(listener, app).await });
        }
        Ok(Ceremony {
            url: format!("{origin}/{get}"),
            answers,
            origin,
            _servers: servers,
        })
    }

    /// Where the person's browser is sent. Whoever has it can see the question, so it goes to the browser and nowhere
    /// else: not to a log and not to the terminal.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn answer(&mut self) -> Result<Answer, Unanswered> {
        self.answer_within(Duration::from_millis(EXPIRES_MS)).await
    }

    pub async fn answer_within(&mut self, time: Duration) -> Result<Answer, Unanswered> {
        let waited = tokio::time::timeout(time, self.answers.recv()).await;
        let (reply, verdict) = waited.ok().flatten().ok_or(Unanswered::Expired)?;
        if let Some(credential) = &reply.answer {
            // webauthn-rs takes any port of localhost, because a proof is checked again long after its port is gone.
            let page = credential["response"]["clientDataJSON"].as_str();
            let page = page.and_then(|d| BASE64URL_NOPAD.decode(d.as_bytes()).ok());
            if page.and_then(|d| passkey::origin(&d)).as_ref() != Some(&self.origin) {
                let _ = verdict.send(Err(Unanswered::Origin.to_string()));
                return Err(Unanswered::Origin);
            }
        }
        let prf = reply
            .prf
            .as_ref()
            .and_then(|p| BASE64URL_NOPAD.decode(p.expose()).ok());
        Ok(Answer {
            credential: reply.answer,
            prf: prf.map(Secret::new),
            makes_keys: reply.makes_keys.unwrap_or(false),
            verdict,
        })
    }
}

/// Both loopback addresses on one port, so no other program can sit on the one the browser happens to try for
/// "localhost".
async fn listen() -> io::Result<(Vec<TcpListener>, u16)> {
    let mut last = None;
    for _ in 0..32 {
        let four = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let port = four.local_addr()?.port();
        match TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).await {
            Ok(six) => return Ok((vec![four, six], port)),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => last = Some(e),
            // No IPv6 here, so nothing else has that address either.
            Err(_) => return Ok((vec![four], port)),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("no port")))
}

fn token() -> String {
    BASE64URL_NOPAD.encode(&random::<32>())
}

/// Compared by hash, so the time it takes says nothing about the token.
fn path_hash(token: &str) -> [u8; 32] {
    hash("polycarp-sync page v1", &[token.as_bytes()])
}

async fn serve(
    State(w): State<Arc<Waiting>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = path_hash(uri.path().trim_start_matches('/'));
    let is = |name: HeaderName, want: &str| {
        let mut all = headers.get_all(name).iter();
        all.next().is_some_and(|v| v.as_bytes() == want.as_bytes()) && all.next().is_none()
    };
    let unless = |name: &'static str, want: &str| {
        headers
            .get(name)
            .is_none_or(|v| v.as_bytes() == want.as_bytes())
    };
    let refuse = |status: StatusCode| with_headers(&w, status, "text/plain", "Not here.".into());
    // A page on another name that was pointed at this computer sends its own name.
    if !is(header::HOST, &w.host) {
        return refuse(StatusCode::FORBIDDEN);
    }
    if method == Method::GET && path == w.get {
        if !unless("sec-fetch-dest", "document") {
            return refuse(StatusCode::FORBIDDEN);
        }
        let page = w.page.lock().unwrap().take();
        return match page {
            Some(page) => with_headers(&w, StatusCode::OK, "text/html; charset=utf-8", page),
            None => with_headers(
                &w,
                StatusCode::GONE,
                "text/plain",
                "This page was used. Start again in Polycarp.".into(),
            ),
        };
    }
    if method == Method::POST && path == w.post {
        let ours = is(header::ORIGIN, &w.origin) && unless("sec-fetch-site", "same-origin");
        if !ours || !is(header::CONTENT_TYPE, "application/json") {
            return refuse(StatusCode::FORBIDDEN);
        }
        let Some(send) = w.answer.lock().unwrap().take() else {
            return refuse(StatusCode::GONE);
        };
        let reply = serde_json::from_slice::<Reply>(&body)
            .ok()
            .filter(|r| match &r.answer {
                Some(_) => !r.skip,
                None => r.skip && w.may_skip,
            });
        let Some(reply) = reply else {
            return refuse(StatusCode::BAD_REQUEST);
        };
        let (verdict, said) = oneshot::channel();
        if send.send((reply, verdict)).await.is_err() {
            return refuse(StatusCode::GONE);
        }
        let (status, said) = match said.await {
            Ok(Ok(said)) => (StatusCode::OK, said),
            Ok(Err(said)) => (StatusCode::FORBIDDEN, said),
            Err(_) => (
                StatusCode::GONE,
                "Polycarp stopped. Start again there.".into(),
            ),
        };
        return with_headers(
            &w,
            status,
            "application/json",
            json!({ "said": said }).to_string(),
        );
    }
    refuse(StatusCode::NOT_FOUND)
}

/// No CORS header is ever sent, so no other page can read an answer from here.
fn with_headers(w: &Waiting, status: StatusCode, kind: &str, body: String) -> Response {
    let n = &w.nonce;
    let policy = format!(
        "default-src 'none'; script-src 'nonce-{n}'; style-src 'nonce-{n}'; connect-src 'self'; base-uri 'none'; \
         form-action 'none'; frame-ancestors 'none'"
    );
    let headers = [
        (header::CONTENT_TYPE, kind.to_string()),
        (header::CONTENT_SECURITY_POLICY, policy),
        (header::X_FRAME_OPTIONS, "DENY".into()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        (header::CACHE_CONTROL, "no-store".into()),
        (header::REFERRER_POLICY, "no-referrer".into()),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin".into(),
        ),
        (
            HeaderName::from_static("cross-origin-resource-policy"),
            "same-origin".into(),
        ),
        (
            HeaderName::from_static("permissions-policy"),
            "publickey-credentials-get=(self), publickey-credentials-create=(self)".into(),
        ),
    ];
    (status, headers, body).into_response()
}
