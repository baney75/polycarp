//! Messages on one QUIC stream: a length, then postcard, and once both sides have the group key, sealed with it.

use crate::seal::Key;
use crate::secret::Secret;
use iroh::endpoint::{RecvStream, SendStream};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;

const MAX_FRAME: usize = 4 * 1024 * 1024;
/// About how much goes in one frame of a long list.
const FRAME: usize = 1024 * 1024;
/// The most one side may say in one list.
const MAX_LIST: usize = 256 * 1024 * 1024;
const PATIENCE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// The connection ended.
    Lost,
    /// The other side said nothing for thirty seconds.
    Slow,
    TooBig,
    Malformed,
    /// Not sealed with the group key, or not for this place in this session.
    Sealed,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            WireError::Lost => "the connection was lost",
            WireError::Slow => "the other device stopped answering",
            WireError::TooBig => "the other device sent too much",
            WireError::Malformed => "the other device sent something else",
            WireError::Sealed => "the other device does not have the group key",
        })
    }
}

/// Seals each frame for one sender, one receiver and one place in the session.
pub struct Seal {
    key: Key,
    me: [u8; 32],
    peer: [u8; 32],
    sent: u64,
    got: u64,
}

impl Seal {
    /// `session` is a secret of this QUIC connection, so nothing recorded from one opens in another.
    pub fn new(group: &Key, session: &[u8; 32], me: [u8; 32], peer: [u8; 32]) -> Seal {
        Seal {
            key: group.derive("polycarp-sync wire v1", session),
            me,
            peer,
            sent: 0,
            got: 0,
        }
    }
}

fn place(from: &[u8; 32], to: &[u8; 32], n: u64) -> Vec<u8> {
    [&from[..], &to[..], &n.to_be_bytes()].concat()
}

pub struct Wire {
    pub send: SendStream,
    pub recv: RecvStream,
    pub seal: Option<Seal>,
    patience: Duration,
}

#[derive(Serialize, Deserialize)]
struct Part {
    items: Vec<Vec<u8>>,
    more: bool,
}

impl Wire {
    pub fn new(send: SendStream, recv: RecvStream) -> Wire {
        Wire {
            send,
            recv,
            seal: None,
            patience: PATIENCE,
        }
    }

    /// Waits this long for the next message: for a person, not a machine.
    pub fn wait(&mut self, patience: Duration) {
        self.patience = patience;
    }

    pub async fn say(&mut self, message: &impl Serialize) -> Result<(), WireError> {
        let bytes = self.pack(message)?;
        let sent = tokio::time::timeout(PATIENCE, put(&mut self.send, bytes));
        sent.await.map_err(|_| WireError::Slow)?
    }

    pub async fn hear<T: DeserializeOwned>(&mut self) -> Result<T, WireError> {
        let bytes = tokio::time::timeout(self.patience, take(&mut self.recv))
            .await
            .map_err(|_| WireError::Slow)??;
        self.unpack(bytes)
    }

    /// Both sides say one thing at once, so neither waits on the other's full buffer.
    pub async fn swap<T: Serialize + DeserializeOwned>(
        &mut self,
        message: &T,
    ) -> Result<T, WireError> {
        let bytes = self.pack(message)?;
        let both = async { tokio::try_join!(put(&mut self.send, bytes), take(&mut self.recv)) };
        let (_, bytes) = tokio::time::timeout(self.patience, both)
            .await
            .map_err(|_| WireError::Slow)??;
        self.unpack(bytes)
    }

    /// Both sides send a list, in as many frames as it takes.
    pub async fn swap_list<T: Serialize + DeserializeOwned>(
        &mut self,
        list: &[T],
    ) -> Result<Vec<T>, WireError> {
        let mut parts = Vec::new();
        let mut part = Part {
            items: Vec::new(),
            more: true,
        };
        let mut size = 0;
        for item in list {
            let item = postcard::to_stdvec(item).map_err(|_| WireError::Malformed)?;
            if size + item.len() > FRAME && !part.items.is_empty() {
                parts.push(std::mem::replace(
                    &mut part,
                    Part {
                        items: Vec::new(),
                        more: true,
                    },
                ));
                size = 0;
            }
            size += item.len();
            part.items.push(item);
        }
        part.more = false;
        parts.push(part);
        let mut parts = parts.into_iter();
        let (mut ours, mut theirs, mut got, mut all) = (parts.next(), true, 0, Vec::new());
        // Frames pass one for one while both have some; after that one side only listens.
        while ours.is_some() || theirs {
            let part: Option<Part> = match (ours.take(), theirs) {
                (Some(part), true) => Some(self.swap(&part).await?),
                (Some(part), false) => {
                    self.say(&part).await?;
                    None
                }
                (None, _) => Some(self.hear().await?),
            };
            ours = parts.next();
            for item in part.iter().flat_map(|p| &p.items) {
                got += item.len();
                if got > MAX_LIST {
                    return Err(WireError::TooBig);
                }
                all.push(postcard::from_bytes(item).map_err(|_| WireError::Malformed)?);
            }
            if let Some(part) = part {
                theirs = part.more;
            }
        }
        Ok(all)
    }

    /// Waits until the other side has all of it.
    pub async fn done(&mut self) {
        let _ = self.send.finish();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.send.stopped()).await;
    }

    fn pack(&mut self, message: &impl Serialize) -> Result<Secret, WireError> {
        let plain = Secret::new(postcard::to_stdvec(message).map_err(|_| WireError::Malformed)?);
        let bytes = match &mut self.seal {
            None => plain,
            Some(s) => {
                let place = place(&s.me, &s.peer, s.sent);
                s.sent += 1;
                Secret::new(s.key.seal(&place, plain.expose()))
            }
        };
        if bytes.len() > MAX_FRAME {
            return Err(WireError::TooBig);
        }
        Ok(bytes)
    }

    fn unpack<T: DeserializeOwned>(&mut self, bytes: Secret) -> Result<T, WireError> {
        let plain = match &mut self.seal {
            None => bytes,
            Some(s) => {
                let place = place(&s.peer, &s.me, s.got);
                s.got += 1;
                s.key
                    .open(&place, bytes.expose())
                    .map_err(|_| WireError::Sealed)?
            }
        };
        let (message, rest) =
            postcard::take_from_bytes(plain.expose()).map_err(|_| WireError::Malformed)?;
        if rest.is_empty() {
            Ok(message)
        } else {
            Err(WireError::Malformed)
        }
    }
}

async fn put(send: &mut SendStream, bytes: Secret) -> Result<(), WireError> {
    let len = (bytes.len() as u32).to_be_bytes();
    send.write_all(&len).await.map_err(|_| WireError::Lost)?;
    send.write_all(bytes.expose())
        .await
        .map_err(|_| WireError::Lost)
}

async fn take(recv: &mut RecvStream) -> Result<Secret, WireError> {
    let mut len = [0; 4];
    recv.read_exact(&mut len)
        .await
        .map_err(|_| WireError::Lost)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(WireError::TooBig);
    }
    let mut bytes = vec![0; len];
    recv.read_exact(&mut bytes)
        .await
        .map_err(|_| WireError::Lost)?;
    Ok(Secret::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_opens_once_in_its_place_for_its_session() {
        let key = Key::random();
        let (a, b) = ([1; 32], [2; 32]);
        let sealed = |group: &Key, session, me, peer, n| {
            let s = Seal::new(group, session, me, peer);
            s.key.seal(&place(&s.me, &s.peer, n), b"x")
        };
        let frame = sealed(&key, &[7; 32], a, b, 0);
        let opens = |group: &Key, session, me, peer, n| {
            let s = Seal::new(group, session, me, peer);
            s.key.open(&place(&s.peer, &s.me, n), &frame).is_ok()
        };
        assert!(opens(&key, &[7; 32], b, a, 0));
        assert!(!opens(&Key::random(), &[7; 32], b, a, 0), "another group");
        assert!(!opens(&key, &[8; 32], b, a, 0), "another session");
        assert!(!opens(&key, &[7; 32], a, b, 0), "sent back to its sender");
        assert!(!opens(&key, &[7; 32], b, [3; 32], 0), "from another device");
        assert!(!opens(&key, &[7; 32], [3; 32], a, 0), "to another device");
        assert!(!opens(&key, &[7; 32], b, a, 1), "again, or out of order");
    }
}
