//! Devices on this computer's loopback, with relays off.

use super::vaults;
use super::Soft;
use iroh::endpoint::{presets, Connection, ConnectionError};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};
use polycarp_sync::keys::Identity;
use polycarp_sync::net::{now, Node, Reach, Shared};
use polycarp_sync::vault::Vault;
use std::time::Duration;

pub struct Dev {
    pub node: Node,
    pub vault: Shared,
}

impl Dev {
    pub async fn new(vault: Vault) -> Dev {
        let vault = Shared::new(vault);
        let node = Node::start(vault.clone(), Reach::Loopback).await.unwrap();
        Dev { node, vault }
    }

    pub async fn empty() -> Dev {
        Dev::new(vaults::vault()).await
    }

    pub async fn first(soft: &mut Soft) -> Dev {
        Dev::new(vaults::first(soft, now())).await
    }

    pub fn id(&self) -> [u8; 32] {
        self.vault.lock().identity.bytes()
    }

    pub fn addr(&self) -> EndpointAddr {
        self.node.endpoint.addr()
    }
}

/// A device that keeps none of the rules.
pub async fn raw(key: SecretKey, alpn: &[u8]) -> Endpoint {
    let alone = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .clear_ip_transports();
    let alone = alone.bind_addr("127.0.0.1:0").unwrap();
    alone
        .secret_key(key)
        .alpns(vec![alpn.to_vec()])
        .bind()
        .await
        .unwrap()
}

/// The code a connection was ended with.
pub async fn ended(conn: &Connection) -> u32 {
    match conn.closed().await {
        ConnectionError::ApplicationClosed(why) => why.error_code.into_inner() as u32,
        e => panic!("{e:?}"),
    }
}

/// Dials `to` as `who`. The code it is turned away with, or none when it is still let stay a moment later.
pub async fn dialed(who: Identity, alpn: &[u8], to: &Dev) -> Option<u32> {
    let net = raw(who.signing, alpn).await;
    // The dialer may think it is through, and then all it gets is the end.
    let conn = net.connect(to.addr(), alpn).await.unwrap();
    let left = tokio::time::timeout(Duration::from_secs(1), ended(&conn))
        .await
        .ok();
    if left.is_some() {
        assert!(conn.open_bi().await.is_err());
    }
    left
}
