//! The host's line, with no server and no account.

use super::*;

#[test]
fn messages_cross_the_line_whole_and_within_their_limits() {
    let mut buf = Vec::new();
    write_message(&mut buf, &json!({ "op": "mail.presets", "id": 4 })).unwrap();
    let mut r = &buf[..];
    assert_eq!(
        read_message(&mut r).unwrap(),
        Some(json!({ "op": "mail.presets", "id": 4 }))
    );
    assert_eq!(
        read_message(&mut r).unwrap(),
        None,
        "a closed line is the end"
    );
    let mut big = (65u32 << 20).to_ne_bytes().to_vec();
    big.extend(b"{}");
    let too_big = read_message(&mut &big[..]).unwrap_err();
    assert_eq!(
        too_big.kind(),
        io::ErrorKind::InvalidData,
        "refused for its size, before reading: {too_big}"
    );
    assert!(
        read_message(&mut &buf[..buf.len() - 1]).is_err(),
        "a cut message is an error, not a request"
    );
    assert!(write_message(&mut Vec::new(), &json!("x".repeat(MOST_OUT))).is_err());
}

#[test]
fn the_host_answers_presets_and_refuses_what_it_cannot_do() {
    let r = answer(&json!({ "op": "mail.presets", "id": 1 }));
    assert_eq!((r.len(), r[0]["ok"].as_bool()), (1, Some(true)));
    for p in r[0]["presets"].as_array().unwrap() {
        for side in ["imap", "smtp"] {
            if let Some(s) = p.get(side) {
                assert!(
                    ["tls", "starttls"].contains(&s["security"].as_str().unwrap()),
                    "{p}"
                );
            }
        }
    }
    assert_eq!(
        answer(&json!({ "op": "mail.send", "id": 5 }))[0]["error"],
        "unknown request"
    );
}
