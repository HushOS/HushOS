//! The recovery key, as `packages/crypto/recovery.ts` writes it: a 32-byte
//! secret shown to the person as 24 BIP-39 words. Three HKDF keys come off it
//! with the envelope's salt: one wraps the account key, one is an Ed25519 seed
//! whose public key the server keeps to check a reset, and a third, off the
//! account key instead, backs the secret up so the phrase can be shown again.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use serde_json::json;
use sha2::{Digest as _, Sha256};

const WORDLIST: &str = include_str!("bip39-english.txt");

/// The recovery key envelope as the server hands it out.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RecoveryEnvelope {
    pub version: u32,
    pub key_version: u64,
    pub recovery_version: u64,
    pub wrapping_salt: String,
    pub wrapping_nonce: String,
    pub encrypted_key: String,
    pub backup_nonce: String,
    pub encrypted_recovery_key: String,
    pub public_key: String,
}

/// A fresh recovery key: the envelope for the server and the phrase for the person.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NewRecovery {
    pub envelope: RecoveryEnvelope,
    /// 24 words, space separated. Show once; never store.
    pub phrase: String,
}

fn words() -> Vec<&'static str> {
    WORDLIST.lines().map(str::trim).filter(|w| !w.is_empty()).collect()
}

/* BIP-39: 256 bits of entropy plus its 8-bit SHA-256 checksum, read in 11-bit words. */
pub(crate) fn phrase_from_entropy(entropy: &[u8]) -> String {
    let words = words();
    debug_assert_eq!(words.len(), 2048);
    let checksum = Sha256::digest(entropy)[0];
    let mut bits = Vec::with_capacity(entropy.len() * 8 + 8);
    for byte in entropy.iter().chain(std::iter::once(&checksum)) {
        for i in (0..8).rev() {
            bits.push((byte >> i) & 1);
        }
    }
    bits.chunks(11)
        .take(24)
        .map(|chunk| chunk.iter().fold(0usize, |acc, bit| (acc << 1) | *bit as usize))
        .map(|index| words[index])
        .collect::<Vec<_>>()
        .join(" ")
}

/* The inverse: refuses unknown words, wrong counts and a bad checksum. */
pub(crate) fn entropy_from_phrase(phrase: &str) -> CoreResult<Vec<u8>> {
    let words = words();
    let given: Vec<&str> = phrase.split_whitespace().collect();
    if given.len() != 24 {
        return Err(input("Enter your 24-word recovery phrase."));
    }
    let mut bits = Vec::with_capacity(264);
    for word in given {
        let lower = word.to_lowercase();
        let index = words
            .iter()
            .position(|w| *w == lower)
            .ok_or_else(|| input("That is not a valid recovery phrase. Check each word and try again."))?;
        for i in (0..11).rev() {
            bits.push(((index >> i) & 1) as u8);
        }
    }
    let entropy: Vec<u8> =
        bits[..256].chunks(8).map(|c| c.iter().fold(0u8, |acc, b| (acc << 1) | b)).collect();
    let checksum = bits[256..].iter().fold(0u8, |acc, b| (acc << 1) | b);
    if checksum != Sha256::digest(&entropy)[0] {
        return Err(input("That is not a valid recovery phrase. Check each word and try again."));
    }
    Ok(entropy)
}

fn derive(secret: &[u8], salt: &[u8], purpose: &str) -> CoreResult<[u8; KEY_BYTES]> {
    let mut out = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(salt), secret)
        .expand(format!("hushos/recovery/{purpose}/v1").as_bytes(), &mut out)
        .map_err(|_| input("HKDF failed"))?;
    Ok(out)
}

fn recovery_context(purpose: &str, user_id: &str, version: u64, key_version: u64) -> Vec<u8> {
    context(&[
        json!("hushos/recovery"),
        json!(1),
        json!(purpose),
        json!(user_id.to_lowercase()),
        json!(key_version),
        json!(version),
    ])
}

/// Mints a recovery key for the account key: what a master-key rotation sends
/// as `recovery`, with the phrase to show once.
///
/// ```
/// use hushos_core::{random_bytes, recovery_create, recovery_open, recovery_phrase};
/// let account_key = random_bytes(32)?;
/// let made = recovery_create("User-1".into(), account_key.clone(), 2, 3)?;
/// assert_eq!(made.phrase.split(' ').count(), 24);
/// assert_eq!(made.envelope.recovery_version, 2);
/// assert_eq!(recovery_open("user-1".into(), made.phrase.clone(), made.envelope.clone())?, account_key);
/// assert_eq!(recovery_phrase("user-1".into(), account_key, made.envelope)?, made.phrase);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_create(
    user_id: String,
    account_key: Vec<u8>,
    recovery_version: u64,
    key_version: u64,
) -> CoreResult<NewRecovery> {
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    if recovery_version < 1 || key_version < 1 {
        return Err(input("recoveryVersion and keyVersion start at 1"));
    }
    let secret = random(32);
    let salt = random(32);
    let nonce = random(NONCE_BYTES);
    let backup_nonce = random(NONCE_BYTES);
    let wrapping = derive(&secret, &salt, "account-wrap")?;
    let backup = derive(&account_key, &salt, "secret-backup")?;
    let signing_seed = derive(&secret, &salt, "authentication")?;
    let signing = SigningKey::from_bytes(&signing_seed);
    let envelope = RecoveryEnvelope {
        version: 1,
        key_version,
        recovery_version,
        wrapping_salt: encode(&salt),
        wrapping_nonce: encode(&nonce),
        encrypted_key: encode(&seal_with_nonce(
            &wrapping,
            &nonce,
            &account_key,
            &recovery_context("account-wrap", &user_id, recovery_version, key_version),
        )?),
        backup_nonce: encode(&backup_nonce),
        encrypted_recovery_key: encode(&seal_with_nonce(
            &backup,
            &backup_nonce,
            &secret,
            &recovery_context("secret-backup", &user_id, recovery_version, key_version),
        )?),
        public_key: encode(signing.verifying_key().as_bytes()),
    };
    Ok(NewRecovery { envelope, phrase: phrase_from_entropy(&secret) })
}

fn check(envelope: &RecoveryEnvelope) -> CoreResult<()> {
    if envelope.version != 1 || envelope.key_version < 1 || envelope.recovery_version < 1 {
        return Err(input("Unsupported recovery key version."));
    }
    Ok(())
}

/// The phrase again, for an account that holds its key: what the Account page shows on request.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_phrase(
    user_id: String,
    account_key: Vec<u8>,
    envelope: RecoveryEnvelope,
) -> CoreResult<String> {
    check(&envelope)?;
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let backup = derive(&account_key, &salt, "secret-backup")?;
    let secret = open_with_nonce(
        &backup,
        &decode("backupNonce", &envelope.backup_nonce, Some(NONCE_BYTES))?,
        &decode("encryptedRecoveryKey", &envelope.encrypted_recovery_key, Some(KEY_BYTES + TAG_BYTES))?,
        &recovery_context("secret-backup", &user_id, envelope.recovery_version, envelope.key_version),
    )?;
    Ok(phrase_from_entropy(&secret))
}

/// The account key from the phrase: what a recovery on this device would use.
/// Checks the phrase's signing key against the envelope's before opening.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_open(user_id: String, phrase: String, envelope: RecoveryEnvelope) -> CoreResult<Vec<u8>> {
    check(&envelope)?;
    let secret = entropy_from_phrase(&phrase)?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let signing = SigningKey::from_bytes(&derive(&secret, &salt, "authentication")?);
    if encode(signing.verifying_key().as_bytes()) != envelope.public_key {
        return Err(CoreError::Sealed("The recovery phrase does not match this account.".into()));
    }
    let key = open_with_nonce(
        &derive(&secret, &salt, "account-wrap")?,
        &decode("wrappingNonce", &envelope.wrapping_nonce, Some(NONCE_BYTES))?,
        &decode("encryptedKey", &envelope.encrypted_key, Some(KEY_BYTES + TAG_BYTES))?,
        &recovery_context("account-wrap", &user_id, envelope.recovery_version, envelope.key_version),
    )?;
    expect_len("account key", &key, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid account key.".into()))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wordlist_is_bip39_english() {
        let words = words();
        assert_eq!(words.len(), 2048);
        assert_eq!((words[0], words[2047]), ("abandon", "zoo"));
        assert!(words.windows(2).all(|w| w[0] < w[1]), "sorted, so the index is the BIP-39 index");
    }

    #[test]
    fn the_phrase_is_the_bip39_test_vector_and_round_trips() {
        // The reference vector for 32 bytes of 0x7f (Trezor's python-mnemonic).
        let entropy = [0x7fu8; 32];
        let phrase = phrase_from_entropy(&entropy);
        assert_eq!(
            phrase,
            "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
        );
        assert_eq!(entropy_from_phrase(&phrase).unwrap(), entropy);
        assert_eq!(
            entropy_from_phrase(&phrase.to_uppercase()).unwrap(),
            entropy,
            "case and spacing are forgiven"
        );
        let mut wrong = phrase.clone();
        wrong.replace_range(wrong.len() - 5.., "topic");
        assert!(
            matches!(entropy_from_phrase(&wrong), Err(CoreError::Input(_))),
            "the checksum catches a swapped last word"
        );
        assert!(matches!(entropy_from_phrase("legal winner"), Err(CoreError::Input(_))));
        assert!(matches!(entropy_from_phrase(&phrase.replace("legal", "legalx")), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_phrase_from_another_account_or_version_does_not_open_the_key() {
        let account_key = random(32);
        let made = recovery_create("u".into(), account_key.clone(), 1, 1).unwrap();
        let other = recovery_create("u".into(), random(32), 1, 1).unwrap();
        assert!(matches!(
            recovery_open("u".into(), other.phrase, made.envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            recovery_open("someone-else".into(), made.phrase.clone(), made.envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        let mut bumped = made.envelope.clone();
        bumped.recovery_version = 2;
        assert!(matches!(recovery_open("u".into(), made.phrase, bumped), Err(CoreError::Sealed(_))));
        assert!(matches!(recovery_phrase("u".into(), random(32), made.envelope), Err(CoreError::Sealed(_))));
    }
}
