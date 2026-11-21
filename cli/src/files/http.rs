//! Just enough HTTP/1.1 for `serve` and its clients, over the tailnet only. One request per connection.
//! WireGuard already encrypts and authenticates the link; who the caller is comes from Tailscale, not HTTP.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const MAX_LINE: usize = 8 * 1024;
const MAX_HEADERS: usize = 64;

#[derive(Debug, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub content_length: Option<u64>,
    pub host: Option<String>,
    /// True when the request carries `Origin`, or `Sec-Fetch-Site` other than `none`: a web page sent it.
    pub from_browser: bool,
}

impl Request {
    pub fn param(&self, k: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) fn read_line(r: &mut impl BufRead) -> io::Result<String> {
    let mut buf = Vec::new();
    let n = r.take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
    }
    if buf.len() > MAX_LINE || !buf.ends_with(b"\n") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        buf.pop();
    }
    String::from_utf8(buf).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not UTF-8"))
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = |c: u8| (c as char).to_digit(16);
                match (hex(b[i + 1]), hex(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn query_string(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Reads the request line and headers. The body, if any, is left in the reader.
pub fn read_request(r: &mut impl BufRead) -> io::Result<Request> {
    let line = read_line(r)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad request line",
        ));
    };
    if !version.starts_with("HTTP/1.") || parts.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad request line",
        ));
    }
    let mut content_length = None;
    let mut host = None;
    let mut from_browser = false;
    for _ in 0..=MAX_HEADERS {
        let h = read_line(r)?;
        if h.is_empty() {
            let (path, q) = target.split_once('?').unwrap_or((target, ""));
            let query = q
                .split('&')
                .filter(|p| !p.is_empty())
                .map(|p| {
                    let (k, v) = p.split_once('=').unwrap_or((p, ""));
                    (percent_decode(k), percent_decode(v))
                })
                .collect();
            return Ok(Request {
                method: method.to_string(),
                path: path.to_string(),
                query,
                content_length,
                host,
                from_browser,
            });
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            if k == "content-length" {
                content_length = Some(v.trim().parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "bad content-length")
                })?);
            } else if k == "host" {
                if host.is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "two Host headers",
                    ));
                }
                host = Some(v.trim().to_string());
            } else if k == "origin"
                || (k == "sec-fetch-site" && !v.trim().eq_ignore_ascii_case("none"))
            {
                from_browser = true;
            } else if k == "transfer-encoding" {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunked bodies are not taken",
                ));
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "too many headers",
    ))
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

pub fn write_head(w: &mut impl Write, status: u16, ctype: &str, len: u64) -> io::Result<()> {
    write!(
        w,
        "HTTP/1.1 {status} {}\r\nContent-Type: {ctype}\r\nContent-Length: {len}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        reason(status)
    )
}

pub fn write_json(w: &mut impl Write, status: u16, body: &serde_json::Value) -> io::Result<()> {
    let text = body.to_string();
    write_head(w, status, "application/json", text.len() as u64)?;
    w.write_all(text.as_bytes())?;
    w.flush()
}

/// A response: status and body (read fully, or streamed into `sink` for a 200).
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

fn connect(addr: SocketAddr, timeout: Duration) -> io::Result<TcpStream> {
    let s = TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    Ok(s)
}

fn read_head(r: &mut impl BufRead) -> io::Result<(u16, Option<u64>)> {
    let line = read_line(r)?;
    let status: u16 = line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad status line"))?;
    let mut len = None;
    for _ in 0..=MAX_HEADERS {
        let h = read_line(r)?;
        if h.is_empty() {
            return Ok((status, len));
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok();
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "too many headers",
    ))
}

/// A request with an optional body; the answer is read whole (for JSON).
pub fn request(
    addr: SocketAddr,
    method: &str,
    target: &str,
    body: Option<(&mut dyn Read, u64)>,
    timeout: Duration,
) -> io::Result<Response> {
    let mut s = connect(addr, timeout)?;
    let len = body.as_ref().map(|b| b.1).unwrap_or(0);
    write!(
        s,
        "{method} {target} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
    )?;
    if let Some((r, n)) = body {
        io::copy(&mut r.take(n), &mut s)?;
    }
    s.flush()?;
    let mut r = BufReader::new(s);
    let (status, clen) = read_head(&mut r)?;
    let mut buf = Vec::new();
    match clen {
        Some(n) => {
            r.take(n.min(64 * 1024 * 1024)).read_to_end(&mut buf)?;
        }
        None => {
            r.take(64 * 1024 * 1024).read_to_end(&mut buf)?;
        }
    }
    Ok(Response { status, body: buf })
}

/// A GET whose 200 body is streamed into `sink`. Any other status comes back with its body read.
pub fn download(
    addr: SocketAddr,
    target: &str,
    timeout: Duration,
    sink: &mut dyn Write,
) -> io::Result<Response> {
    let mut s = connect(addr, timeout)?;
    write!(
        s,
        "GET {target} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;
    s.flush()?;
    let mut r = BufReader::new(s);
    let (status, clen) = read_head(&mut r)?;
    if status != 200 {
        let mut buf = Vec::new();
        r.take(1024 * 1024).read_to_end(&mut buf)?;
        return Ok(Response { status, body: buf });
    }
    let want = clen.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no length"))?;
    let got = io::copy(&mut r.take(want), sink)?;
    if got != want {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("the transfer stopped after {got} of {want} bytes"),
        ));
    }
    Ok(Response {
        status,
        body: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_lines_and_queries_parse() {
        let raw = b"GET /v1/search?q=sermon%20notes&limit=5 HTTP/1.1\r\nHost: x\r\n\r\n";
        let r = read_request(&mut &raw[..]).unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/v1/search");
        assert_eq!(r.param("q"), Some("sermon notes"));
        assert_eq!(r.param("limit"), Some("5"));
        let chunked = b"PUT /v1/inbox HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert!(read_request(&mut &chunked[..]).is_err());
        let long = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(MAX_LINE + 10));
        assert!(read_request(&mut long.as_bytes()).is_err());
    }

    #[test]
    fn percent_round_trip() {
        let s = "/Users/d/My Docs/a&b=c%.md";
        assert_eq!(percent_decode(&percent_encode(s)), s);
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("a%2"), "a%2");
    }
}
