//! Handles, deletion secrets and what is derived from them.
//!
//! The relay never stores a handle or a deletion secret, only their hashes, so a copy of its
//! database gives no handle that can be pinged and no secret that can delete one.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// 32 bytes from the operating system's generator: a handle or a deletion secret.
pub fn random32() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// Base64url without padding, as every HushOS API writes bytes.
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Exactly 32 bytes in canonical base64url without padding, or nothing.
pub fn decode32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 43 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()
}

fn hash(domain: &[u8], bytes: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0u8]);
    hasher.update(bytes);
    hasher.finalize().into()
}

/// What the database keys a registration by.
pub fn handle_key(handle: &[u8; 32]) -> [u8; 32] {
    hash(b"hushos-push handle", handle)
}

/// What the database keeps of a deletion secret.
pub fn secret_hash(secret: &[u8; 32]) -> [u8; 32] {
    hash(b"hushos-push delete", secret)
}

/// The tag a push carries so an app signed in to several accounts knows which server the ping
/// came from: the first 16 bytes of SHA-256("hushos-push tag" ‖ 0x00 ‖ handle). Apple and Google
/// see it; it cannot be used to ping the device.
pub fn tag(handle: &[u8; 32]) -> String {
    encode(&hash(b"hushos-push tag", handle)[..16])
}

/// A lowercase UUID, the only event id a push may carry, so a server cannot put words of its
/// own into the payload Apple or Google deliver.
pub fn is_event_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode32_takes_only_canonical_32_bytes() {
        let bytes = random32();
        assert_eq!(decode32(&encode(&bytes)), Some(bytes));
        assert_eq!(decode32(&encode(&bytes[..31])), None);
        assert_eq!(decode32(&format!("{}=", encode(&bytes))), None);
        // The last character carries two spare bits; a non-zero spare bit is a second spelling.
        let mut other = encode(&[0u8; 32]);
        other.pop();
        other.push('B');
        assert_eq!(decode32(&other), None);
    }

    #[test]
    fn event_ids_are_lowercase_uuids_only() {
        assert!(is_event_id("0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_event_id("0F8E2A4C-1B3D-4E5F-8A9B-0C1D2E3F4A5B"));
        assert!(!is_event_id("0f8e2a4c1b3d4e5f8a9b0c1d2e3f4a5b"));
        assert!(!is_event_id("Maya shared Taxes 2025.pdf with you!!"));
        assert!(!is_event_id("0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5g"));
    }
}
