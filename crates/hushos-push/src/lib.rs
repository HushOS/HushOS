//! The push relay at `push.hushos.com` (docs/devices-design.md 5, "The relay"; docs/push-relay-plan.md).
//!
//! Apps register their APNs or FCM token and get back a random handle, which they give to their
//! server. Servers ping a handle with an event id, and the relay sends a push that carries only
//! that id and a tag: the device fetches the event over its own session and writes the
//! notification itself. The relay stores handle → token and nothing about accounts.

pub mod api;
pub mod apns;
pub mod config;
pub mod fcm;
pub mod handle;
pub mod limits;
pub mod push;
pub mod store;
