//! Encodings and randomness shared by every module.

use crate::error::{input, CoreResult};
use base64::{engine::general_purpose as b64, Engine as _};
use rand::RngCore;
use std::fmt;

pub(crate) const KEY_BYTES: usize = 32;
pub(crate) const NONCE_BYTES: usize = 24;
pub(crate) const TAG_BYTES: usize = 16;
const BASE64: b64::GeneralPurpose = b64::URL_SAFE_NO_PAD;
const RANDOM_MAX_BYTES: u32 = 1024;

pub(crate) fn encode(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/* The API and the web write bytes as canonical base64url without padding; anything else is refused. */
pub(crate) fn decode(context: &str, value: &str, length: Option<usize>) -> CoreResult<Vec<u8>> {
    let bytes =
        BASE64.decode(value).map_err(|error| input(format!("{context} is not valid base64url; {error}")))?;
    if BASE64.encode(&bytes) != value {
        return Err(input(format!("{context} is not canonical base64url")));
    }
    if let Some(expected) = length {
        expect_len(context, &bytes, expected)?;
    }
    Ok(bytes)
}

pub(crate) fn expect_len(context: &str, bytes: &[u8], expected: usize) -> CoreResult<()> {
    if bytes.len() != expected {
        return Err(input(format!("{context} must be {expected} bytes, got {}", bytes.len())));
    }
    Ok(())
}

/* What a Debug print shows in place of a key, a phrase or a link secret: that it is there, never what it is. */
pub(crate) struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Private key material (a private key, a seed, a raw symmetric key) that
/// wipes itself when it is dropped, so a record holding one leaves nothing
/// behind in freed memory. It crosses UniFFI as plain bytes (`Data` in Swift,
/// `ByteArray` in Kotlin); the copy handed to the app is the app's to wipe.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        SecretBytes(bytes)
    }

    /// A plain copy, for an API that takes `Vec<u8>`; wrap it again or wipe it.
    pub fn to_vec(&self) -> Vec<u8> {
        self.0.clone()
    }
}

impl From<Vec<u8>> for SecretBytes {
    fn from(bytes: Vec<u8>) -> Self {
        SecretBytes(bytes)
    }
}

impl PartialEq<Vec<u8>> for SecretBytes {
    fn eq(&self, other: &Vec<u8>) -> bool {
        &self.0 == other
    }
}

impl PartialEq<SecretBytes> for Vec<u8> {
    fn eq(&self, other: &SecretBytes) -> bool {
        self == &other.0
    }
}

impl std::ops::Deref for SecretBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        Redacted.fmt(f)
    }
}

#[cfg(feature = "uniffi")]
uniffi::custom_type!(SecretBytes, Vec<u8>, {
    lower: |secret| secret.to_vec(),
    try_lift: |bytes| Ok(SecretBytes(bytes)),
});

/* Whether a Debug print shows these bytes in any form a careless impl would use: the derived list, hex or base64url. */
#[cfg(test)]
pub(crate) fn shows(printed: &str, secret: &[u8]) -> bool {
    let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    printed.contains(&format!("{secret:?}")) || printed.contains(&hex) || printed.contains(&encode(secret))
}

pub(crate) fn random(length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out
}

/// Bytes as the API writes them: base64url, no padding.
///
/// ```
/// assert_eq!(hushos_core::base64url_encode(vec![0xfb, 0xff]), "-_8");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base64url_encode(bytes: Vec<u8>) -> String {
    encode(&bytes)
}

/// The inverse of [`base64url_encode`]; refuses padding and non-canonical text,
/// so two different strings can never name the same bytes.
///
/// ```
/// use hushos_core::{base64url_decode, CoreError};
/// assert_eq!(base64url_decode("-_8".into()).unwrap(), vec![0xfb, 0xff]);
/// assert!(matches!(base64url_decode("-_8=".into()), Err(CoreError::Input(_))));
/// assert!(matches!(base64url_decode("-_9".into()), Err(CoreError::Input(_))));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base64url_decode(value: String) -> CoreResult<Vec<u8>> {
    decode("value", &value, None)
}

/// Fresh random bytes from the operating system, for keys, nonces and ids.
/// At most 1024 at a time; a key is 32, a content nonce 16.
///
/// ```
/// let key = hushos_core::random_bytes(32).unwrap();
/// assert_eq!(key.len(), 32);
/// assert!(hushos_core::random_bytes(0).is_err());
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn random_bytes(length: u32) -> CoreResult<Vec<u8>> {
    if length == 0 || length > RANDOM_MAX_BYTES {
        return Err(input(format!("length must be 1..={RANDOM_MAX_BYTES}")));
    }
    Ok(random(length as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_refuses_padding_and_non_canonical_trailing_bits() {
        assert_eq!(decode("v", "AQ", None).unwrap(), vec![1]);
        assert!(decode("v", "AQ==", None).is_err(), "padding is not canonical");
        assert!(decode("v", "AR", None).is_err(), "AR sets bits the byte cannot hold");
        assert!(decode("v", "AQ+", None).is_err(), "standard alphabet is refused");
    }

    #[test]
    fn decode_checks_the_length_it_was_given() {
        let key = encode(&[7u8; 32]);
        assert_eq!(decode("key", &key, Some(32)).unwrap().len(), 32);
        let error = decode("key", &key, Some(24)).unwrap_err();
        assert_eq!(error.to_string(), "key must be 24 bytes, got 32");
    }

    #[test]
    fn random_bytes_differ_between_calls_and_respect_the_cap() {
        assert_ne!(random_bytes(32).unwrap(), random_bytes(32).unwrap());
        assert_eq!(random_bytes(1024).unwrap().len(), 1024);
        assert!(random_bytes(1025).is_err());
    }

    #[test]
    fn secret_bytes_never_print_and_one_copy_s_wipe_leaves_the_others_whole() {
        let secret = random(32);
        let held = SecretBytes::from(secret.clone());
        assert!(!shows(&format!("{held:?}"), &secret));
        // A record holding it prints none of it either.
        let keys = ContentKeyProbe { key: held.clone() };
        assert!(!shows(&format!("{keys:?}"), &secret));
        let survivor = held.clone();
        drop(held);
        drop(keys);
        assert_eq!(survivor.to_vec(), secret);
    }

    #[derive(Debug)]
    struct ContentKeyProbe {
        #[allow(dead_code)]
        key: SecretBytes,
    }
}
