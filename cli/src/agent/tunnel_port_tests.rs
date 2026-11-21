//! `tunnel tailscale` changes port 8443 only when nothing serves there or the gateway itself does.

use super::*;

const DNS: &str = "mac.tail1234.ts.net";
const OURS: &str = "http://127.0.0.1:41772";

fn check(status: &str) -> Result<(), String> {
    port_free_or_ours(Ok(status.into()), DNS, OURS)
}

#[test]
fn a_free_port_or_the_gateways_own_proxy_is_fine() {
    for ok in [
        "{}",
        "",
        r#"{"Web":{"other.tail1234.ts.net:8443":{"Handlers":{"/":{"Path":"/srv"}}}}}"#,
        r#"{"TCP":{"8443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:41772"}}}}}"#,
        r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:41772/"}}}}}"#,
    ] {
        assert!(check(ok).is_ok(), "{ok}");
    }
}

#[test]
fn any_other_handler_on_the_port_is_left_alone() {
    for taken in [
        // Another proxy.
        r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#,
        // A folder, and a text handler: no Proxy field at all.
        r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Path":"/Users/me/site"}}}}}"#,
        r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Text":"hello"}}}}}"#,
        // Ours at / and something else at another path.
        r#"{"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:41772"},"/x":{"Path":"/srv"}}}}}"#,
        // A raw TCP forward on the port.
        r#"{"TCP":{"8443":{"TCPForward":"127.0.0.1:22"}}}"#,
    ] {
        let e = check(taken).unwrap_err();
        assert!(e.contains("won't replace it"), "{taken}: {e}");
    }
}

#[test]
fn a_status_that_fails_or_cant_be_read_refuses_the_change() {
    let e = port_free_or_ours(Err("exit status 1".into()), DNS, OURS).unwrap_err();
    assert!(e.contains("won't change"), "{e}");
    let e = check("not json").unwrap_err();
    assert!(e.contains("won't change"), "{e}");
}
