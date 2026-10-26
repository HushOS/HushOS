//! A new account's keys, made on the device as the web's `registerFinish`
//! makes them (packages/crypto/src/session.ts): a fresh account key sealed
//! under the OPAQUE export key, its recovery key, a version 2 identity and the
//! personal workspace's first grant. The account key is made, used and wiped
//! here; it never crosses to the app.

use crate::account::{account_seal, AccountKeyEnvelope};
use crate::bytes::{random, KEY_BYTES};
use crate::drive::{workspace_grant_create, WorkspaceGrant};
use crate::error::{input, CoreResult};
use crate::identity::{identity_create, IdentityEnvelope};
use crate::recovery::{recovery_create, RecoveryEnvelope};
use zeroize::Zeroizing;

/// Everything `POST /api/auth/register/finish` takes beside the name and the
/// OPAQUE record. No phrase: the app reads it back from the account once
/// signed in (`recovery_phrase`), so the words it shows are the ones the
/// server kept, and they are never held between the two steps.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NewAccount {
    /// Send as `envelope`: key version 1, credential version 1.
    pub envelope: AccountKeyEnvelope,
    /// Send as `recovery`: recovery version 1 at key version 1.
    pub recovery: RecoveryEnvelope,
    /// Send as `identity`: version 2 at key version 1.
    pub identity: IdentityEnvelope,
    /// Send as `workspace.id`: a fresh UUID, lowercase.
    pub workspace_id: String,
    /// Send as `workspace.grant`.
    pub grant: WorkspaceGrant,
}

/// The keys of a new account for `user_id` (the `userId` that
/// `POST /api/auth/register/start` answers with), the account key sealed
/// under `export_key` from `opaque_finish_registration`.
///
/// ```
/// use hushos_core::{account_create, account_unlock, random_bytes, workspace_open};
/// let export_key = random_bytes(64)?;
/// let made = account_create("user-1".into(), export_key.clone())?;
/// let root = account_unlock("user-1".into(), export_key, made.envelope)?;
/// assert_eq!(workspace_open("user-1".into(), root, made.grant)?.len(), 32);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn account_create(user_id: String, export_key: Vec<u8>) -> CoreResult<NewAccount> {
    let export_key = Zeroizing::new(export_key);
    if user_id.trim().is_empty() {
        return Err(input("userId is empty"));
    }
    let root = Zeroizing::new(random(KEY_BYTES));
    let envelope = account_seal(user_id.clone(), export_key.to_vec(), root.to_vec(), 1, 1)?;
    let recovery = recovery_create(user_id.clone(), root.to_vec(), 1, 1)?.envelope;
    let identity = identity_create(user_id.clone(), root.to_vec(), 1)?;
    let workspace_id = uuid_v4();
    let grant = workspace_grant_create(user_id, root.to_vec(), workspace_id.clone(), 1)?;
    Ok(NewAccount { envelope, recovery, identity, workspace_id, grant })
}

/* A random version 4 UUID in lowercase, as the web's crypto.randomUUID(). */
fn uuid_v4() -> String {
    let mut b = random(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::account_unlock;
    use crate::drive::{is_workspace_id, workspace_open};
    use crate::identity::{identity_open, identity_verify_keys, public_identity};
    use crate::recovery::{recovery_open, recovery_phrase};

    const USER: &str = "6f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";

    fn made() -> (Vec<u8>, NewAccount) {
        let export_key = random(64);
        let account = account_create(USER.into(), export_key.clone()).unwrap();
        (export_key, account)
    }

    /* The server takes only these versions at sign-up (finishRegistration, decodeRecovery/Identity/WorkspaceGrant with 1). */
    #[test]
    fn makes_the_versions_sign_up_requires() {
        let (_, account) = made();
        assert_eq!(
            (
                account.envelope.envelope_version,
                account.envelope.key_version,
                account.envelope.credential_version
            ),
            (1, 1, 1)
        );
        assert_eq!(
            (account.recovery.version, account.recovery.key_version, account.recovery.recovery_version),
            (1, 1, 1)
        );
        assert_eq!((account.identity.version, account.identity.key_version), (2, 1));
        assert_eq!(
            (account.grant.version, account.grant.key_version, account.grant.workspace_key_version),
            (1, 1, 1)
        );
        assert_eq!(account.grant.workspace_id, account.workspace_id);
        assert!(is_workspace_id(&account.workspace_id), "{}", account.workspace_id);
        assert_eq!(&account.workspace_id[14..15], "4");
    }

    /* One account key opens all four: the password's envelope, the phrase, the identity and the grant. */
    #[test]
    fn every_part_opens_under_the_one_account_key() {
        let (export_key, account) = made();
        let root = account_unlock(USER.into(), export_key, account.envelope.clone()).unwrap();
        let phrase = recovery_phrase(USER.into(), root.clone(), account.recovery.clone()).unwrap();
        assert_eq!(phrase.split(' ').count(), 24);
        assert_eq!(recovery_open(USER.into(), phrase, account.recovery.clone()).unwrap(), root);
        identity_open(USER.into(), root.clone(), account.identity.clone()).unwrap();
        assert!(identity_verify_keys(USER.into(), public_identity(account.identity.clone()).unwrap()));
        assert_eq!(workspace_open(USER.into(), root, account.grant.clone()).unwrap().len(), 32);
    }

    /* Bound to the account it was made for: another user id or another password's export key opens nothing. */
    #[test]
    fn opens_for_no_other_account_or_password() {
        let (export_key, account) = made();
        let other = "6f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2c";
        assert!(account_unlock(other.into(), export_key.clone(), account.envelope.clone()).is_err());
        assert!(account_unlock(USER.into(), random(64), account.envelope.clone()).is_err());
        let root = account_unlock(USER.into(), export_key, account.envelope.clone()).unwrap();
        assert!(workspace_open(other.into(), root.clone(), account.grant.clone()).is_err());
        assert!(identity_open(other.into(), root.clone(), account.identity.clone()).is_err());
        let phrase = recovery_phrase(USER.into(), root, account.recovery.clone()).unwrap();
        assert!(recovery_open(other.into(), phrase, account.recovery).is_err());
    }

    /* Every sign-up gets its own keys and workspace: a fixed or reused source would give two accounts one key. */
    #[test]
    fn two_sign_ups_share_nothing() {
        let (first_key, first) = made();
        let (second_key, second) = made();
        let first_root = account_unlock(USER.into(), first_key, first.envelope).unwrap();
        let second_root = account_unlock(USER.into(), second_key, second.envelope).unwrap();
        assert_ne!(first_root, second_root);
        assert_ne!(first.workspace_id, second.workspace_id);
        assert_ne!(first.identity.signing_public_key, second.identity.signing_public_key);
        assert!(workspace_open(USER.into(), first_root, second.grant).is_err());
    }

    #[test]
    fn refuses_an_empty_export_key_or_user() {
        assert!(account_create(USER.into(), Vec::new()).is_err());
        assert!(account_create(" ".into(), random(64)).is_err());
    }

    #[test]
    fn a_grant_needs_a_lowercase_workspace_id() {
        let root = random(32);
        for id in ["0C6F1D2E-3A4B-4C5D-8E6F-7A8B9C0D1E2F", "0c6f1d2e3a4b4c5d8e6f7a8b9c0d1e2f", "../x", ""] {
            assert!(workspace_grant_create(USER.into(), root.clone(), id.into(), 1).is_err(), "{id}");
        }
        assert!(workspace_grant_create(USER.into(), root, "0c6f1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f".into(), 0)
            .is_err());
    }
}
