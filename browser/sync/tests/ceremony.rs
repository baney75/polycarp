//! The passkey page: what it answers to, and what it refuses, over plain sockets.

mod support;

use polycarp_sync::ceremony::{Answer, Ask, Ceremony, Unanswered, Words};
use polycarp_sync::passkey::Passkey;
use serde_json::{json, Value};
use std::time::Duration;
use support::http::{request, Seen};
use support::{Ask as How, Soft};

const ASKED: [u8; 32] = [7; 32];

struct Open {
    ceremony: Ceremony,
    soft: Soft,
    passkeys: Vec<Passkey>,
    port: u16,
    get: String,
}

async fn open(skip: bool) -> Open {
    let mut soft = Soft::new();
    let passkeys = vec![soft.register("Key")];
    let words = Words {
        title: "Add <Desktop>?".into(),
        go: "Use a passkey".into(),
        skip: skip.then(|| "Skip".into()),
        ..Words::default()
    };
    let ask = Ask::Allow {
        passkeys: passkeys.clone(),
        challenge: ASKED,
        prf: None,
    };
    let ceremony = Ceremony::open(ask, words).await.unwrap();
    let url = url::Url::parse(ceremony.url()).unwrap();
    assert_eq!((url.scheme(), url.host_str()), ("http", Some("localhost")));
    Open {
        port: url.port().unwrap(),
        get: url.path().into(),
        ceremony,
        soft,
        passkeys,
    }
}

impl Open {
    fn host(&self) -> String {
        format!("localhost:{}", self.port)
    }

    async fn send(&self, line: &str, headers: &[(&str, &str)], body: &str) -> Seen {
        request(self.port, line, headers, body).await
    }

    async fn visit(&self) -> Seen {
        self.send(&format!("GET {}", self.get), &[("host", &self.host())], "")
            .await
    }

    /// Visits the page and gives the address it answers to.
    async fn post(&self) -> String {
        let page = self.visit().await;
        assert_eq!(page.status, 200);
        let data = page.body.split("id=\"data\"").nth(1).unwrap();
        let data = &data[data.find('>').unwrap() + 1..data.find("</script>").unwrap()];
        let data: Value = serde_json::from_str(data).unwrap();
        assert_eq!(data["words"]["title"], "Add <Desktop>?");
        data["post"].as_str().unwrap().to_string()
    }

    fn answer(&mut self, page: &str) -> String {
        let options = polycarp_sync::passkey::request(&self.passkeys, &ASKED, None).unwrap();
        json!({ "answer": self.soft.answer(options, How { origin: page, ..How::default() }), "prf": null }).to_string()
    }

    async fn reply(&self, post: &str, body: &str) -> Seen {
        let origin = format!("http://{}", self.host());
        let headers = [
            ("host", &*self.host()),
            ("origin", &*origin),
            ("content-type", "application/json"),
        ];
        self.send(&format!("POST {post}"), &headers, body).await
    }
}

#[tokio::test]
async fn one_page_takes_one_answer() {
    let mut o = open(false).await;
    let post = o.post().await;
    assert_eq!(o.visit().await.status, 410, "a page is given once");
    let body = o.answer(&format!("http://{}", o.host()));
    let mut ceremony = std::mem::replace(&mut o.ceremony, open(false).await.ceremony);
    let waited = tokio::spawn(async move {
        let answer = ceremony.answer().await.unwrap();
        let credential = answer.credential.clone().unwrap();
        answer.done(Ok("Desktop joined."));
        (credential, ceremony)
    });
    let seen = o.reply(&post, &body).await;
    assert_eq!(
        (seen.status, &*seen.body),
        (200, r#"{"said":"Desktop joined."}"#)
    );
    let (credential, _still_up) = waited.await.unwrap();
    let proof = polycarp_sync::passkey::Proof::from_json(credential).unwrap();
    polycarp_sync::passkey::verify(&o.passkeys, |_| 0, &ASKED, &proof).unwrap();
    assert_eq!(
        o.reply(&post, &body).await.status,
        410,
        "an answer is taken once"
    );
}

#[tokio::test]
async fn only_this_host_name_is_served() {
    let o = open(false).await;
    let get = format!("GET {}", o.get);
    let (port, host) = (o.port, o.host());
    let (ip, evil, other) = (
        format!("127.0.0.1:{port}"),
        format!("evil.example:{port}"),
        format!("localhost:{}", port - 1),
    );
    for hosts in [
        vec![&*ip],
        vec![&*evil],
        vec![&*other],
        vec!["localhost"],
        vec![&*host, &*evil],
        vec![&*evil, &*host],
    ] {
        let headers: Vec<_> = hosts.iter().map(|h| ("host", *h)).collect();
        let seen = o.send(&get, &headers, "").await;
        assert!(
            (400..500).contains(&seen.status),
            "{hosts:?}: {}",
            seen.status
        );
        assert!(!seen.body.contains("challenge"));
    }
    assert_eq!(
        o.visit().await.status,
        200,
        "none of those used the page up"
    );
}

#[tokio::test]
async fn only_the_page_itself_answers() {
    let mut o = open(false).await;
    let post = o.post().await;
    let body = o.answer(&format!("http://{}", o.host()));
    let (host, origin) = (o.host(), format!("http://{}", o.host()));
    let (line, json) = (format!("POST {post}"), "application/json");
    let other = format!("http://localhost:{}", o.port - 1);
    let cases: Vec<Vec<(&str, &str)>> = vec![
        vec![("host", &host), ("content-type", json)],
        vec![("host", &host), ("content-type", json), ("origin", "null")],
        vec![
            ("host", &host),
            ("content-type", json),
            ("origin", "http://evil.example"),
        ],
        vec![("host", &host), ("content-type", json), ("origin", &other)],
        vec![
            ("host", &host),
            ("content-type", json),
            ("origin", &origin),
            ("origin", "http://evil.example"),
        ],
        vec![
            ("host", &host),
            ("content-type", json),
            ("origin", &origin),
            ("sec-fetch-site", "cross-site"),
        ],
        vec![
            ("host", &host),
            ("content-type", "text/plain"),
            ("origin", &origin),
        ],
        vec![("host", &host), ("origin", &origin)],
        vec![
            ("host", "evil.example"),
            ("content-type", json),
            ("origin", &origin),
        ],
    ];
    for headers in cases {
        let seen = o.send(&line, &headers, &body).await;
        assert_eq!(seen.status, 403, "{headers:?}");
    }
    assert_eq!(
        o.ceremony
            .answer_within(Duration::from_millis(50))
            .await
            .unwrap_err(),
        Unanswered::Expired
    );
}

#[tokio::test]
async fn nothing_is_found_without_its_token() {
    let o = open(false).await;
    let host = o.host();
    for line in [
        "GET /",
        "GET /favicon.ico",
        "POST /",
        &format!("POST {}", o.get),
        &format!("OPTIONS {}", o.get),
    ] {
        assert_eq!(
            o.send(line, &[("host", &host)], "").await.status,
            404,
            "{line}"
        );
    }
    let framed = [("host", &*host), ("sec-fetch-dest", "iframe")];
    assert_eq!(
        o.send(&format!("GET {}", o.get), &framed, "").await.status,
        403
    );
    let post = o.post().await;
    assert_ne!(post, o.get);
    assert_eq!(
        o.send(&format!("GET {post}"), &[("host", &host)], "")
            .await
            .status,
        404
    );
    assert!(o.get.len() > 40 && post.len() > 40);
}

#[tokio::test]
async fn no_other_site_may_read_or_frame_it() {
    let o = open(false).await;
    let origin = "http://evil.example";
    let page = o
        .send(
            &format!("GET {}", o.get),
            &[("host", &o.host()), ("origin", origin)],
            "",
        )
        .await;
    let missing = o
        .send("OPTIONS /", &[("host", &o.host()), ("origin", origin)], "")
        .await;
    for seen in [&page, &missing] {
        assert!(!seen.head.contains("access-control"), "{}", seen.head);
        for line in [
            "frame-ancestors 'none'",
            "default-src 'none'",
            "x-frame-options: deny",
            "cache-control: no-store",
            "referrer-policy: no-referrer",
        ] {
            assert!(seen.head.contains(line), "{line} in {}", seen.head);
        }
    }
    assert!(
        !page.body.contains("<Desktop>"),
        "words must not become markup"
    );
}

#[tokio::test]
async fn an_answer_from_a_page_on_another_port_is_refused() {
    let mut o = open(false).await;
    let post = o.post().await;
    let body = o.answer(&format!("http://localhost:{}", o.port - 1));
    let (host, port) = (o.host(), o.port);
    let sent = tokio::spawn(async move {
        let origin = format!("http://{host}");
        let headers = [
            ("host", &*host),
            ("origin", &*origin),
            ("content-type", "application/json"),
        ];
        request(port, &format!("POST {post}"), &headers, &body).await
    });
    assert_eq!(o.ceremony.answer().await.unwrap_err(), Unanswered::Origin);
    assert_eq!(sent.await.unwrap().status, 403);
}

#[tokio::test]
async fn skipping_needs_to_be_offered() {
    let o = open(false).await;
    let post = o.post().await;
    assert_eq!(o.reply(&post, r#"{"skip":true}"#).await.status, 400);
    assert_eq!(
        o.reply(&post, r#"{"skip":true}"#).await.status,
        410,
        "a bad answer uses the page up"
    );
    let mut o = open(true).await;
    let post = o.post().await;
    let (host, port) = (o.host(), o.port);
    let sent = tokio::spawn(async move {
        let origin = format!("http://{host}");
        let headers = [
            ("host", &*host),
            ("origin", &*origin),
            ("content-type", "application/json"),
        ];
        request(port, &format!("POST {post}"), &headers, r#"{"skip":true}"#).await
    });
    let answer: Answer = o.ceremony.answer().await.unwrap();
    assert!(answer.credential.is_none());
    answer.done(Err("stopped".into()));
    let seen = sent.await.unwrap();
    assert_eq!((seen.status, &*seen.body), (403, r#"{"said":"stopped"}"#));
}

#[tokio::test]
async fn a_page_nobody_answers_expires_and_goes() {
    let mut o = open(false).await;
    let start = std::time::Instant::now();
    assert_eq!(
        o.ceremony
            .answer_within(Duration::from_millis(20))
            .await
            .unwrap_err(),
        Unanswered::Expired
    );
    assert!(start.elapsed() < Duration::from_secs(15));
    let Open { ceremony, port, .. } = o;
    drop(ceremony);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
}

#[tokio::test]
async fn both_loopback_addresses_are_taken() {
    let o = open(false).await;
    if tokio::net::TcpListener::bind("[::1]:0").await.is_err() {
        return;
    }
    assert!(tokio::net::TcpListener::bind(("::1", o.port))
        .await
        .is_err());
    assert!(tokio::net::TcpStream::connect(("::1", o.port))
        .await
        .is_ok());
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", o.port))
        .await
        .is_ok());
}

#[tokio::test]
async fn debug_output_has_no_address() {
    let o = open(false).await;
    assert!(!format!("{:?}", o.ceremony).contains(&o.get[1..]));
}
