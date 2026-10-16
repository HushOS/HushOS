//! Ids derived from a seed and a scope, as `docs/integrity-design.md` fixes
//! them ("Ids derived from a seed and a scope"): a client never names an id
//! directly. It draws a 16-byte seed and derives
//!
//! ```text
//! id = uuidv8(SHA-256(["hushos/id", 1, kind, scopeId, seed])[0..16])
//! ```
//!
//! with the statement in the compact JSON of associated data (the scope
//! lowercased, the seed base64url). The server recomputes the id from the
//! seed, the kind and the workspace of the request, so an id made for one
//! workspace cannot be asked about in another.
//!
//! Groups add two kinds (docs/groups-design.md 5): a `Group` id is scoped to
//! the account that creates the group, and a `Workspace` id (a group's area)
//! to its group.

use crate::bytes::{decode, encode, random};
use crate::envelope::context;
use crate::error::{input, CoreResult};
use serde_json::json;
use sha2::{Digest as _, Sha256};

pub(crate) const ID_SEED_BYTES: usize = 16;

/// What an id names; part of what it is derived from, so a node's seed never
/// derives a version's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum IdKind {
    Node,
    Version,
    Object,
    Link,
    Report,
    /// A group, scoped to the account that creates it.
    Group,
    /// A group's area, scoped to its group.
    Workspace,
}

impl IdKind {
    fn as_str(self) -> &'static str {
        match self {
            IdKind::Node => "node",
            IdKind::Version => "version",
            IdKind::Object => "object",
            IdKind::Link => "link",
            IdKind::Report => "report",
            IdKind::Group => "group",
            IdKind::Workspace => "workspace",
        }
    }
}

/// A freshly minted id and the seed it came from: send both, the seed
/// (base64url, 16 bytes) as the create's `idSeed`, `versionIdSeed`,
/// `objectIdSeed`, `linkIdSeed` or `reportIdSeed`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NewId {
    pub id: String,
    pub seed: String,
}

fn uuid_v8(digest: &[u8]) -> String {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// The id `seed` (base64url, exactly 16 bytes) derives for `kind` in
/// `scope_id` (the workspace the item is created in; for a report, the
/// workspace of the reported item): a lowercase hyphenated UUID, version 8,
/// variant `10`.
///
/// ```
/// use hushos_core::{derive_id, IdKind};
/// let seed = "AAECAwQFBgcICQoLDA0ODw".to_string();
/// let id = derive_id(IdKind::Node, "11111111-1111-4111-8111-111111111111".into(), seed.clone())?;
/// assert_eq!(&id[14..15], "8");
/// // Another workspace, or another kind, derives another id from the same seed.
/// assert_ne!(id, derive_id(IdKind::Node, "22222222-2222-4222-8222-222222222222".into(), seed.clone())?);
/// assert_ne!(id, derive_id(IdKind::Version, "11111111-1111-4111-8111-111111111111".into(), seed)?);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn derive_id(kind: IdKind, scope_id: String, seed: String) -> CoreResult<String> {
    decode("id seed", &seed, Some(ID_SEED_BYTES))?;
    if scope_id.is_empty() {
        return Err(input("Invalid scope id."));
    }
    let statement = context(&[
        json!("hushos/id"),
        json!(1),
        json!(kind.as_str()),
        json!(scope_id.to_lowercase()),
        json!(seed),
    ]);
    Ok(uuid_v8(&Sha256::digest(statement)))
}

/// A fresh id for `kind` in `scope_id`: a random seed and the id it derives.
///
/// ```
/// use hushos_core::{derive_id, new_id, IdKind};
/// let ws = "11111111-1111-4111-8111-111111111111".to_string();
/// let made = new_id(IdKind::Object, ws.clone())?;
/// assert_eq!(derive_id(IdKind::Object, ws, made.seed)?, made.id);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn new_id(kind: IdKind, scope_id: String) -> CoreResult<NewId> {
    let seed = encode(&random(ID_SEED_BYTES));
    Ok(NewId { id: derive_id(kind, scope_id, seed.clone())?, seed })
}

/// Refuses an id that `seed` does not derive for `kind` in `scope_id`, with
/// one answer for every cause (a malformed seed, another scope, another kind),
/// as the server refuses it: a client never takes a group or area id it could
/// not derive itself.
///
/// ```
/// use hushos_core::{check_id, new_id, IdKind};
/// let creator = "11111111-1111-4111-8111-111111111111".to_string();
/// let group = new_id(IdKind::Group, creator.clone())?;
/// assert!(check_id(IdKind::Group, creator.clone(), group.seed.clone(), group.id.clone()).is_ok());
/// assert!(check_id(IdKind::Workspace, creator, group.seed, group.id).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_id(kind: IdKind, scope_id: String, seed: String, id: String) -> CoreResult<()> {
    match derive_id(kind, scope_id, seed) {
        Ok(derived) if derived == id => Ok(()),
        _ => Err(input("This id was not made for this workspace or group.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "11111111-1111-4111-8111-111111111111";

    fn seed(fill: u8) -> String {
        encode(&[fill; ID_SEED_BYTES])
    }

    #[test]
    fn the_id_is_the_first_sixteen_bytes_of_the_statement_s_digest_as_a_v8_uuid() {
        let seed = encode(&(0u8..16).collect::<Vec<_>>());
        let statement = format!(r#"["hushos/id",1,"node","{WS}","{seed}"]"#);
        let digest = Sha256::digest(statement.as_bytes());
        let id = derive_id(IdKind::Node, WS.to_uppercase(), seed).unwrap();
        let hex: String = id.chars().filter(|c| *c != '-').collect();
        let mut expected = digest[..16].to_vec();
        expected[6] = (expected[6] & 0x0f) | 0x80;
        expected[8] = (expected[8] & 0x3f) | 0x80;
        assert_eq!(hex, expected.iter().map(|b| format!("{b:02x}")).collect::<String>());
        assert_eq!(id.len(), 36);
        assert_eq!([8, 13, 18, 23].map(|i| id.as_bytes()[i]), [b'-'; 4]);
        assert_eq!(id, id.to_lowercase());
    }

    #[test]
    fn known_answers() {
        // Computed by a third implementation (Python's hashlib), so neither twin pins only itself.
        let seed = encode(&(0u8..16).collect::<Vec<_>>());
        let expected = [
            (IdKind::Node, "a665fe70-cc80-8d51-a9ba-55846dcc512b"),
            (IdKind::Version, "d4fb4a80-b5ea-8b6f-97e3-e2e1bb90c8f0"),
            (IdKind::Object, "6dde5ef0-b985-8abe-8944-97934bb8d8be"),
            (IdKind::Link, "dac762e3-30c4-848b-8683-a0e1a9f3dc03"),
            (IdKind::Report, "58dfe84c-7431-807d-8130-07f8eadb43a7"),
            (IdKind::Group, "42c6fdd2-9543-8b80-91e2-96fabf53d061"),
            (IdKind::Workspace, "6407e0fd-93df-8a89-98a2-3322d10516a8"),
        ];
        for (kind, id) in expected {
            assert_eq!(derive_id(kind, WS.into(), seed.clone()).unwrap(), id, "{kind:?}");
        }
    }

    #[test]
    fn version_and_variant_bits_hold_for_every_digest() {
        for fill in 0..=255u8 {
            let id = derive_id(IdKind::Link, WS.into(), seed(fill)).unwrap();
            assert_eq!(&id[14..15], "8", "{id}");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
        }
    }

    #[test]
    fn scope_kind_and_seed_each_change_the_id() {
        let base = derive_id(IdKind::Node, WS.into(), seed(1)).unwrap();
        assert_ne!(
            base,
            derive_id(IdKind::Node, "22222222-2222-4222-8222-222222222222".into(), seed(1)).unwrap()
        );
        assert_ne!(base, derive_id(IdKind::Node, WS.into(), seed(2)).unwrap());
        let kinds = [
            IdKind::Node,
            IdKind::Version,
            IdKind::Object,
            IdKind::Link,
            IdKind::Report,
            IdKind::Group,
            IdKind::Workspace,
        ];
        let ids: std::collections::HashSet<_> =
            kinds.iter().map(|kind| derive_id(*kind, WS.into(), seed(1)).unwrap()).collect();
        assert_eq!(ids.len(), kinds.len());
        // The scope is lowercased like every id in a statement.
        assert_eq!(base, derive_id(IdKind::Node, WS.to_uppercase(), seed(1)).unwrap());
    }

    #[test]
    fn a_seed_that_is_not_sixteen_canonical_bytes_derives_nothing() {
        assert!(derive_id(IdKind::Node, WS.into(), encode(&[1; 15])).is_err());
        assert!(derive_id(IdKind::Node, WS.into(), encode(&[1; 17])).is_err());
        assert!(derive_id(IdKind::Node, WS.into(), format!("{}=", seed(1))).is_err());
        assert!(derive_id(IdKind::Node, String::new(), seed(1)).is_err());
    }

    #[test]
    fn a_group_or_area_id_not_derived_from_its_seed_and_scope_is_refused() {
        let id = derive_id(IdKind::Group, WS.into(), seed(1)).unwrap();
        assert!(check_id(IdKind::Group, WS.into(), seed(1), id.clone()).is_ok());
        for (kind, scope, seed, id) in [
            (IdKind::Group, "22222222-2222-4222-8222-222222222222".to_string(), seed(1), id.clone()),
            (IdKind::Workspace, WS.to_string(), seed(1), id.clone()),
            (IdKind::Group, WS.to_string(), seed(2), id.clone()),
            (IdKind::Group, WS.to_string(), "not a seed".to_string(), id.clone()),
            (IdKind::Group, WS.to_string(), seed(1), id.to_uppercase()),
        ] {
            let refused = check_id(kind, scope, seed, id).unwrap_err();
            assert_eq!(refused.to_string(), "This id was not made for this workspace or group.");
        }
    }

    #[test]
    fn new_ids_are_fresh_and_rederive() {
        let a = new_id(IdKind::Report, WS.into()).unwrap();
        let b = new_id(IdKind::Report, WS.into()).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(derive_id(IdKind::Report, WS.into(), a.seed.clone()).unwrap(), a.id);
        assert_ne!(derive_id(IdKind::Node, WS.into(), a.seed).unwrap(), a.id);
    }
}
