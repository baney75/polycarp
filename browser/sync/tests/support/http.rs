//! One HTTP request, written by hand so a test can send what no browser would.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Seen {
    pub status: u16,
    /// Status line and headers, in lower case.
    pub head: String,
    pub body: String,
}

pub async fn request(port: u16, line: &str, headers: &[(&str, &str)], body: &str) -> Seen {
    let mut text = format!(
        "{line} HTTP/1.1\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    text.push_str("\r\n");
    text.push_str(body);
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(text.as_bytes()).await.unwrap();
    let mut all = String::new();
    stream.read_to_string(&mut all).await.unwrap();
    let (head, body) = all.split_once("\r\n\r\n").unwrap_or((&all, ""));
    Seen {
        status: head
            .split(' ')
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        head: head.to_lowercase(),
        body: body.to_string(),
    }
}
