//! DNS rebinding: serve answers only the CLI, never a web page that named another host.

use super::*;

/// Serves `c` on loopback, where whois says the caller is `caller`.
pub(super) fn serve_as(mut c: Ctx, caller: Node) -> SocketAddr {
    Index::open(&c.index)
        .unwrap()
        .update(&c.roots, &[])
        .unwrap();
    c.tailnet = Arc::new(Stub {
        me: c.me.clone(),
        by_ip: [(IpAddr::V4(Ipv4Addr::LOCALHOST), caller)]
            .into_iter()
            .collect(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || accept_loop(Arc::new(c), listener));
    addr
}

/// Sends `head` as written and returns the status.
fn raw(addr: SocketAddr, head: &str) -> u16 {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(head.as_bytes()).unwrap();
    let mut got = String::new();
    let _ = s.read_to_string(&mut got);
    got.split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
}

#[test]
fn a_browser_or_a_rebound_host_gets_403_and_the_cli_does_not() {
    let d = tmp("browser");
    let addr = serve_as(ctx_with(&d, false), node("parish1", 7, "100.100.0.2"));
    let get = |headers: &str| {
        raw(
            addr,
            &format!("GET /v1/search?q=x HTTP/1.1\r\n{headers}Connection: close\r\n\r\n"),
        )
    };
    let host = format!("Host: {addr}\r\n");
    assert_eq!(get("Host: evil.example\r\n"), 403, "rebound name");
    assert_eq!(get(&format!("Host: evil.example:{}\r\n", addr.port())), 403);
    assert_eq!(get(""), 403, "no Host");
    assert_eq!(get(&format!("{host}Origin: http://evil.example\r\n")), 403);
    assert_eq!(get(&format!("{host}Sec-Fetch-Site: cross-site\r\n")), 403);
    assert_eq!(get(&format!("{host}Sec-Fetch-Site: same-origin\r\n")), 403);
    assert_eq!(get(&format!("{host}Sec-Fetch-Site: none\r\n")), 200);
    assert_eq!(get(&host), 200);
    assert_eq!(get("Host: 127.0.0.1\r\n"), 200, "without the port");
    assert_eq!(get("Host: MAC.tail.ts.net.\r\n"), 200, "full MagicDNS name");
    assert_eq!(
        get(&format!("Host: mac:{}\r\n", addr.port())),
        200,
        "short name"
    );
    assert_eq!(
        get("Host: 100.100.0.1:41771\r\n"),
        200,
        "this node's Tailscale IP"
    );
    let t = Duration::from_secs(5);
    let r = http::request(addr, "GET", "/v1/search?q=x", None, t).unwrap();
    assert_eq!(r.status, 200, "the CLI's own request");
    let _ = fs::remove_dir_all(&d);
}
