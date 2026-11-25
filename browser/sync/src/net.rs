//! This device on the network: iroh, with a door that only members get through.

use crate::vault::Vault;
use iroh::endpoint::{presets, AfterHandshakeOutcome, Connection, EndpointHooks, VarInt};
use iroh::{Endpoint, EndpointAddr, PublicKey, RelayMode};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub const SYNC: &[u8] = b"polycarp-sync/sync/1";
const DIAL: Duration = Duration::from_secs(20);
/// Connections served at once.
const BUSY: usize = 16;

/// Why a connection was ended, as the other side sees it.
pub const DONE: u32 = 0;
pub const FAILED: u32 = 1;
pub const NOT_A_MEMBER: u32 = 403;

/// The vault, shared between the network, the browser and the command line. Never held across an await.
#[derive(Clone, Debug)]
pub struct Shared(Arc<Mutex<Vault>>);

impl Shared {
    pub fn new(vault: Vault) -> Shared {
        Shared(Arc::new(Mutex::new(vault)))
    }

    pub fn lock(&self) -> MutexGuard<'_, Vault> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// How far this device can be reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// From this computer alone: for tests.
    Loopback,
    /// Directly where that works and through iroh's public relays where not; its address lookup finds the others.
    Internet,
}

/// Decides, once a connection's keys are proven and before anything is said on it.
struct Door {
    vault: Shared,
}

impl std::fmt::Debug for Door {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Door")
    }
}

impl Door {
    fn opens(&self, alpn: &[u8], remote: &PublicKey) -> bool {
        match alpn {
            SYNC => self.vault.lock().is_member(remote.as_bytes()),
            _ => false,
        }
    }
}

impl EndpointHooks for Door {
    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        if self.opens(conn.alpn(), &conn.remote_id()) {
            return AfterHandshakeOutcome::Accept;
        }
        // Nothing here says whether there is a group, or who is in it.
        AfterHandshakeOutcome::Reject {
            error_code: VarInt::from_u32(NOT_A_MEMBER),
            reason: Vec::new(),
        }
    }
}

pub struct Node {
    pub endpoint: Endpoint,
    pub vault: Shared,
    _tasks: JoinSet<()>,
}

impl Node {
    pub async fn start(vault: Shared, reach: Reach) -> std::io::Result<Node> {
        let identity = vault.lock().identity.clone();
        let builder = match reach {
            Reach::Loopback => {
                let only = Endpoint::builder(presets::Minimal)
                    .relay_mode(RelayMode::Disabled)
                    .clear_ip_transports();
                only.bind_addr("127.0.0.1:0")
                    .map_err(std::io::Error::other)?
            }
            Reach::Internet => Endpoint::builder(presets::N0),
        };
        let door = Door {
            vault: vault.clone(),
        };
        let builder = builder
            .secret_key(identity.signing.clone())
            .alpns(vec![SYNC.to_vec()])
            .hooks(door);
        let endpoint = builder.bind().await.map_err(std::io::Error::other)?;
        let mut tasks = JoinSet::new();
        tasks.spawn(serve(endpoint.clone()));
        Ok(Node {
            endpoint,
            vault,
            _tasks: tasks,
        })
    }

    pub async fn dial(&self, to: EndpointAddr, alpn: &[u8]) -> Option<Connection> {
        tokio::time::timeout(DIAL, self.endpoint.connect(to, alpn))
            .await
            .ok()?
            .ok()
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

async fn serve(endpoint: Endpoint) {
    let busy = Arc::new(Semaphore::new(BUSY));
    let mut tasks = JoinSet::new();
    while let Some(incoming) = endpoint.accept().await {
        while tasks.try_join_next().is_some() {}
        let Ok(place) = busy.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        tasks.spawn(async move {
            let _place = place;
            let Ok(conn) = incoming.await else { return };
            // Nothing is said yet: it stays open until the other side hangs up.
            conn.closed().await;
        });
    }
}
