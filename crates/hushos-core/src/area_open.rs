//! A family folder opened from what route 25 serves (groups 1d, Core 6), the
//! twin of the web worker's `groupOpenArea` (`packages/crypto/src/area-open.ts`,
//! which `session-groups.ts` calls) and of the area self-grant
//! (docs/envelope-migrations.md 5; `grantAreaKey`, `openAreaSelfGrant` in
//! `packages/crypto/src/workspace.ts`):
//!
//! - the **self-grant** (the member's own wrap of the area key under their
//!   account root, bound to the family by `["hushos/group/area-self-grant",1,
//!   user,group,workspace,keyVersion,workspaceKeyVersion]`) is opened first,
//!   and only when it is at a version no lower than the area's latest on the
//!   committed chain and the served one, and one the chain lists; its key
//!   must be the one the chain's commitment names. Anything else about it
//!   (another family's, another folder's, another root's, damaged) is
//!   ignored, never a refusal: the area grant decides then;
//! - otherwise the **area grant**, through its granter's keys
//!   ([`crate::area_grant_open`]), which needs the granter's identity served;
//!   a grant opened at the area's latest version, which the server also
//!   serves, is wrapped again as a self-grant for the app to store (route 23).
//!
//! So a folder keeps opening after its granter's identity is gone (an account
//! deleted, an identity replaced before the next fold-in) once this device
//! stored a self-grant, as on the web. The key goes into the ledger only
//! ([`AreaLedger::open_area`]'s rules, then `held_back`); it never crosses the
//! FFI, and the self-grant is sealed under the root the ledger holds.

use crate::area_ledger::{
    AreaLedger, AreaOpened, NOT_CHECKED_KEYS, NOT_LISTED, NOT_THE_FAMILYS, NO_ACCOUNT, NO_CHAIN,
};
use crate::bytes::{decode, encode, random, KEY_BYTES, NONCE_BYTES};
use crate::canonical::uuid;
use crate::consent::NOT_OWN_IDENTITY;
use crate::drive::WorkspaceGrant;
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreResult};
use crate::groups::{
    area_grant_open, area_key_commitment, area_write_version, AreaGrantContext, SignerHistory,
};
use crate::identity::{identity_open, IdentityEnvelope};
use crate::ids::{check_id, IdKind};
use hkdf::Hkdf;
use serde_json::json;
use sha2::Sha256;
use std::sync::Arc;
use zeroize::Zeroizing;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// A grant whose granter's identity was not served (an account gone, say): it cannot be checked.
pub const GRANTER_KEY_NEEDED: &str = "This grant needs the key of the person who made it.";
const UNSUPPORTED_GRANT: &str = "Unsupported workspace key envelope.";

/// A family folder as route 25 serves it, with what opening it needs: its id
/// seed, the key version the server says is current (`served_version`, its
/// `workspaceKeyVersion`), the area grant to this account if any, and this
/// account's self-grant if one is stored.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedArea {
    pub workspace_id: String,
    pub id_seed: String,
    pub served_version: u64,
    pub grant: Option<ServedAreaGrant>,
    pub self_grant: Option<WorkspaceGrant>,
}

/// An area grant as route 25 serves it (`envelope` decoded), the granter's
/// ML-DSA key and history as route 6 serves them (none when their identity is
/// not served), and `holder`: this account's identity at the grant's
/// `grantee_key_version` (the envelope, opened here under the account root).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedAreaGrant {
    pub envelope: Vec<u8>,
    pub workspace_key_version: u64,
    pub grantee_key_version: u64,
    pub granter_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
    pub granter_ml_dsa_public_key: Option<Vec<u8>>,
    pub granter_history: Option<SignerHistory>,
    pub holder: IdentityEnvelope,
}

/// Which envelope opened a family folder's key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum AreaKeyFrom {
    SelfGrant,
    Grant,
}

/// A family folder opened: what the ledger found ([`AreaOpened`]), which
/// envelope opened it, and the self-grant to store with route 23
/// (`PUT /api/groups/:id/areas/:workspaceId/self-grant`) when the grant
/// opened the area's current key; a refusal of that store (`area-moved`:
/// the folder's key changed meanwhile) is only a reason to sync again.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FamilyAreaOpened {
    pub opened: AreaOpened,
    pub from: AreaKeyFrom,
    pub self_grant_to_store: Option<WorkspaceGrant>,
}

fn self_grant_context(
    user_id: &str,
    group_id: &str,
    workspace_id: &str,
    key_version: u64,
    workspace_key_version: u64,
) -> Vec<u8> {
    context(&[
        json!("hushos/group/area-self-grant"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(group_id.to_lowercase()),
        json!(workspace_id.to_lowercase()),
        json!(key_version),
        json!(workspace_key_version),
    ])
}

fn wrapping_key(root: &[u8], salt: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let mut wrap = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(salt), root)
        .expand(b"hushos/workspace/grant-wrap/v1", wrap.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(wrap)
}

/* A served base64url field as the web's `decode` takes it: non-empty, canonical, of `length` bytes. */
fn web_decode(value: &str, length: usize) -> CoreResult<Vec<u8>> {
    if value.is_empty() {
        return Err(input("Invalid key encoding."));
    }
    decode("value", value, Some(length)).map_err(|_| input("Invalid key encoding."))
}

/* The area key wrapped as `group_id`'s self-grant under `root` (the worker's grantAreaKey). */
pub(crate) fn self_grant_seal(
    key: &[u8],
    root: &[u8],
    user_id: &str,
    group_id: &str,
    workspace_id: &str,
    key_version: u64,
    workspace_key_version: u64,
) -> CoreResult<WorkspaceGrant> {
    uuid(workspace_id, "workspace id")?;
    uuid(group_id, "group id")?;
    if key.len() != KEY_BYTES {
        return Err(input("Invalid workspace key."));
    }
    let salt = random(32);
    let nonce = random(NONCE_BYTES);
    let wrap = wrapping_key(root, &salt)?;
    let aad = self_grant_context(user_id, group_id, workspace_id, key_version, workspace_key_version);
    Ok(WorkspaceGrant {
        version: 1,
        workspace_id: workspace_id.to_string(),
        key_version,
        workspace_key_version,
        wrapping_salt: encode(&salt),
        wrapping_nonce: encode(&nonce),
        encrypted_key: encode(&seal_with_nonce(wrap.as_slice(), &nonce, key, &aad)?),
    })
}

/* A self-grant opened as `group_id`'s only (the worker's openAreaSelfGrant): the key, or why not. */
pub(crate) fn self_grant_open(
    root: &[u8],
    user_id: &str,
    group_id: &str,
    grant: &WorkspaceGrant,
) -> CoreResult<Zeroizing<Vec<u8>>> {
    let version = |n: u64| (1..=MAX_SAFE_INTEGER).contains(&n);
    if grant.version != 1
        || uuid(&grant.workspace_id, "workspace id").is_err()
        || !version(grant.key_version)
        || !version(grant.workspace_key_version)
    {
        return Err(input(UNSUPPORTED_GRANT));
    }
    let ciphertext = web_decode(&grant.encrypted_key, KEY_BYTES + 16)?;
    let wrap = wrapping_key(root, &web_decode(&grant.wrapping_salt, 32)?)?;
    let nonce = web_decode(&grant.wrapping_nonce, NONCE_BYTES)?;
    let aad = self_grant_context(
        user_id,
        group_id,
        &grant.workspace_id,
        grant.key_version,
        grant.workspace_key_version,
    );
    Ok(Zeroizing::new(open_with_nonce(wrap.as_slice(), &nonce, &ciphertext, &aad)?))
}

/// The area key wrapped as a self-grant, for the shared fixtures only (a
/// self-grant from before a rotation, another family's, another folder's).
/// Apps never wrap one: [`AreaLedger::open_family_area`] does, under the root
/// the ledger holds.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn area_self_grant_seal(
    key: &[u8],
    root: &[u8],
    user_id: &str,
    group_id: &str,
    workspace_id: &str,
    key_version: u64,
    workspace_key_version: u64,
) -> CoreResult<WorkspaceGrant> {
    self_grant_seal(key, root, user_id, group_id, workspace_id, key_version, workspace_key_version)
}

/// A self-grant's key, for the shared fixtures only (the other twin's stored
/// self-grant opened to the key it must be).
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn area_self_grant_open(
    root: &[u8],
    user_id: &str,
    group_id: &str,
    grant: &WorkspaceGrant,
) -> CoreResult<Vec<u8>> {
    self_grant_open(root, user_id, group_id, grant).map(|key| key.to_vec())
}

#[cfg(test)]
type LedgerHook = Option<Box<dyn Fn(&AreaLedger)>>;
#[cfg(test)]
thread_local! {
    static AFTER_OPENING_AREA: std::cell::RefCell<LedgerHook> = const { std::cell::RefCell::new(None) };
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// Opens a family folder from route 25, the worker's `groupOpenArea`, in
    /// its order: the family's committed chain ([`NO_CHAIN`]: sync first), the
    /// folder's id derived under the family from `id_seed`
    /// (`This folder does not belong to the family.`), the folder live on the
    /// chain (`This folder is not on the family’s member list.`), the account
    /// open; then the self-grant (used only when at or above both the
    /// chain's latest version and the served one, listed, and of the key the
    /// chain committed to; otherwise ignored), else the area grant
    /// ([`GRANTER_KEY_NEEDED`] without the granter's served key; its own
    /// refusals as [`crate::area_grant_open`] words them), else
    /// [`NOT_CHECKED_KEYS`]. The key is held under the family as
    /// [`AreaLedger::open_area`] holds it, still under the session and root it
    /// was opened under (`NOT_THIS_ACCOUNT` otherwise), and never returned.
    /// `account_key_version` is the account key's version (the personal
    /// workspace grant's `keyVersion`), which a self-grant to store names.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let area = ServedArea {
    ///     workspace_id: "11111111-1111-4111-8111-111111111111".into(),
    ///     id_seed: "AAAAAAAAAAAAAAAAAAAAAA".into(),
    ///     served_version: 1,
    ///     grant: None,
    ///     self_grant: None,
    /// };
    /// // No member list committed for the family on this device: nothing opens.
    /// let refused = ledger.open_family_area("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), area, 1).unwrap_err();
    /// assert_eq!(refused.to_string(), "Check the family’s member list first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn open_family_area(
        &self,
        group_id: String,
        area: ServedArea,
        account_key_version: u64,
    ) -> CoreResult<FamilyAreaOpened> {
        uuid(&group_id, "group id")?;
        let chain = self.committed_chain(&group_id).ok_or_else(|| input(NO_CHAIN))?;
        let workspace_id = area.workspace_id.clone();
        uuid(&workspace_id, "workspace id")?;
        check_id(IdKind::Workspace, group_id.clone(), area.id_seed.clone(), workspace_id.clone())
            .map_err(|_| input(NOT_THE_FAMILYS))?;
        let latest =
            area_write_version(Arc::clone(&chain), workspace_id.clone()).ok_or_else(|| input(NOT_LISTED))?;
        let listed = chain.area_keys.get(&workspace_id).cloned().unwrap_or_default();
        let (user_id, generation, root) = self.unlocked().ok_or_else(|| input(NO_ACCOUNT))?;
        if !(1..=MAX_SAFE_INTEGER).contains(&account_key_version) {
            return Err(input("Invalid account key version."));
        }
        let served = area.served_version;
        // The self-grant only at the latest version both the chain and the server name, and listed.
        let from_self = area.self_grant.as_ref().and_then(|own| {
            let v = own.workspace_key_version;
            // An index past usize (a 32-bit target) is past every listed version.
            let index = usize::try_from(v.wrapping_sub(1)).unwrap_or(usize::MAX);
            if own.workspace_id != workspace_id || v < latest || v < served || index >= listed.len() {
                return None;
            }
            let key = self_grant_open(&root, &user_id, &group_id, own).ok()?;
            let commitment = area_key_commitment(&key).ok()?;
            (listed.get(index) == Some(&commitment)).then_some((key, v))
        });
        let (key, version, from) = match (from_self, area.grant) {
            (Some((key, version)), _) => (key, version, AreaKeyFrom::SelfGrant),
            (None, Some(grant)) => {
                let granter_key = grant.granter_ml_dsa_public_key.ok_or_else(|| input(GRANTER_KEY_NEEDED))?;
                let reader_key_version = grant.holder.key_version;
                let holder = identity_open(user_id.clone(), root.to_vec(), grant.holder)
                    .map_err(|_| input(NOT_OWN_IDENTITY))?;
                let key = area_grant_open(
                    grant.envelope,
                    AreaGrantContext {
                        group_id: group_id.clone(),
                        workspace_id: workspace_id.clone(),
                        workspace_key_version: grant.workspace_key_version,
                        grantee_user_id: user_id.clone(),
                        grantee_key_version: grant.grantee_key_version,
                        granter_user_id: grant.granter_user_id,
                        roster_version: grant.roster_version,
                        roster_digest: grant.roster_digest,
                    },
                    Arc::clone(&chain),
                    area.id_seed.clone(),
                    granter_key,
                    grant.granter_history,
                    user_id.clone(),
                    reader_key_version,
                    holder,
                )?;
                (Zeroizing::new(key), grant.workspace_key_version, AreaKeyFrom::Grant)
            }
            (None, None) => return Err(input(NOT_CHECKED_KEYS)),
        };
        // The server takes a self-grant only at the area's current version.
        let self_grant_to_store = if from == AreaKeyFrom::Grant && version == latest && served == latest {
            Some(self_grant_seal(
                &key,
                &root,
                &user_id,
                &group_id,
                &workspace_id,
                account_key_version,
                version,
            )?)
        } else {
            None
        };
        // Tests only: a lock, another account or another root while the key was opened.
        #[cfg(test)]
        AFTER_OPENING_AREA.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(self)
            }
        });
        let opened = self.open_area_in(
            group_id,
            workspace_id,
            area.id_seed,
            version,
            key,
            served,
            Some((generation, &root)),
        )?;
        Ok(FamilyAreaOpened { opened, from, self_grant_to_store })
    }
}

#[cfg(test)]
mod tests;
