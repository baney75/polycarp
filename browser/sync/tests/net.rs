//! The door: who gets a connection, over iroh on the loopback with relays off.

mod support;

use polycarp_sync::net::{now, NOT_A_MEMBER, SYNC};
use support::nodes::{dialed, Dev};
use support::vaults::{self, device, remove};
use support::Soft;

#[tokio::test]
async fn a_stranger_gets_no_connection_past_the_handshake() {
    let mut soft = Soft::new();
    let a = Dev::first(&mut soft).await;
    assert_eq!(dialed(device(), SYNC, &a).await, Some(NOT_A_MEMBER));
    // A device in no group counts no one as a member.
    let lone = Dev::empty().await;
    assert_eq!(dialed(device(), SYNC, &lone).await, Some(NOT_A_MEMBER));
}

#[tokio::test]
async fn a_member_gets_in_until_it_is_removed() {
    let mut soft = Soft::new();
    let a = Dev::first(&mut soft).await;
    let mut b = vaults::vault();
    vaults::add(&mut soft, &mut a.vault.lock(), &mut b, "Desktop", now());
    let who = b.identity.clone();
    assert_eq!(dialed(who.clone(), SYNC, &a).await, None);
    remove(&mut soft, &mut a.vault.lock(), who.bytes(), now()).unwrap();
    assert_eq!(dialed(who, SYNC, &a).await, Some(NOT_A_MEMBER));
}

#[tokio::test]
async fn a_device_goes_only_to_members_too() {
    let mut soft = Soft::new();
    let (a, b) = (Dev::first(&mut soft).await, Dev::first(&mut soft).await);
    assert!(a.node.dial(b.addr(), SYNC).await.is_none());
}
