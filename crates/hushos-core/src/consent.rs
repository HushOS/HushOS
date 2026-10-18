//! The successor's consent for this account's own earlier successions that
//! landed without it (flag F8; docs/groups-server.md 5, the backfill): the twin
//! of `linksNeedingConsent` (`packages/crypto/src/consent-due.ts`, which the web's
//! `apps/web/src/lib/consent-backfill.ts` calls) and of the worker's
//! `identityConsent` (`packages/crypto/src/session-groups.ts`). Group verdicts
//! ask consent of the links a member's entry walks, so a link uploaded before
//! the apps sent consent leaves this person's own records unchecked in their
//! families until it is filled.
//!
//! The app runs it once per unlock: [`links_needing_consent`] over the
//! account's own links (as contacts are served them, from key version 1) and
//! its identities (the current one and its history), then
//! [`AreaLedger::succession_consent_sign`] for each, and uploads each consent at its link's
//! old key version (`POST /api/auth/identity/succession/consent`). The server
//! stores consent only where none is, so a second pass, or another device's,
//! changes nothing.
//!
//! The shared fixtures (`consents` in `fixtures/web-join.json` and
//! `packages/crypto/src/__fixtures__/core-join.json`) hold the twins to each
//! other; `packages/db/src/auth.consent.test.ts` checks the core's consent
//! with the server's own verifier. The fuzz kinds `consent_due` and
//! `consent_sign` in `succession` compare the twins on any input.

use crate::area_ledger::{AreaLedger, NO_ACCOUNT};
use crate::bytes::encode;
use crate::device_record::OPEN_IDENTITY;
use crate::error::{input, CoreResult};
use crate::group_trust::OwnIdentities;
use crate::identity::{
    identity_open, succession_verify, IdentityEnvelope, ServedKeys, SuccessionLink, SuccessionSigner,
};
use crate::signatures::{sign_hybrid, succession_consent_statement, ConsentRole};

const UPGRADED_ONLY: &str = "Only a link between two upgraded identities takes consent.";
const NOT_OWN_IDENTITY: &str = "This identity does not open on this account.";
const NOT_CONSECUTIVE: &str = "These are not two identities this device opened one after the other.";
const NOT_THIS_LINK: &str = "This link is not one this account made.";

/// A link of this account's that needs the successor's consent, with the two
/// identities of the account's own that it joins.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ConsentDue {
    /// Upload the consent at `link.old_key_version`.
    pub link: SuccessionLink,
    pub old_identity: IdentityEnvelope,
    pub next_identity: IdentityEnvelope,
}

/* The public keys of a version 2 envelope that has them all; none otherwise. */
fn served_keys_of(envelope: &IdentityEnvelope) -> Option<ServedKeys> {
    match (envelope.version, &envelope.ml_dsa, &envelope.kem) {
        (2, Some(ml_dsa), Some(kem)) => Some(ServedKeys {
            key_version: envelope.key_version,
            encryption_public_key: envelope.encryption_public_key.clone(),
            signing_public_key: envelope.signing_public_key.clone(),
            ml_dsa_public_key: ml_dsa.public_key.clone(),
            kem_public_key: kem.public_key.clone(),
        }),
        _ => None,
    }
}

/* Whether `envelope` is the identity a link names on its old side: every public key the consent covers, at its key version. */
fn names_old(envelope: &IdentityEnvelope, link: &SuccessionLink) -> bool {
    served_keys_of(envelope).is_some_and(|keys| {
        keys.key_version == link.old_key_version
            && keys.encryption_public_key == link.old_encryption_public_key
            && keys.signing_public_key == link.old_signing_public_key
            && keys.ml_dsa_public_key == link.old_ml_dsa_public_key
    })
}

/* The same for the new side, its ML-KEM key included. */
fn names_new(envelope: &IdentityEnvelope, link: &SuccessionLink) -> bool {
    served_keys_of(envelope).is_some_and(|keys| {
        keys.key_version == link.new_key_version
            && keys.encryption_public_key == link.new_encryption_public_key
            && keys.signing_public_key == link.new_signing_public_key
            && keys.ml_dsa_public_key == link.new_ml_dsa_public_key
            && keys.kem_public_key == link.new_kem_public_key
    })
}

/// The links among `links` (this account's own, as served) that carry no
/// consent (none, or empty) and join two of its version 2 identities among
/// `identities`, each found at its own key version with exactly the keys the
/// link names on that side (the first such identity in `identities`, in the
/// order given). A link from a version 1 identity is never offered: it has no
/// ML-DSA key to consent with, and the server answers it `not-upgraded`. Nor
/// is a link whose keys are not the account's own envelopes. Nothing is
/// verified here: [`AreaLedger::succession_consent_sign`] checks what it signs.
///
/// ```
/// use hushos_core::*;
/// let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
/// let first = identity_create(user.clone(), root.clone(), 1)?;
/// let next = identity_succeed(user.clone(), root, first.clone())?;
/// let ml = |e: &IdentityEnvelope| e.ml_dsa.clone().unwrap().public_key;
/// let link = SuccessionLink {
///     old_key_version: 1, new_key_version: 2,
///     old_encryption_public_key: first.encryption_public_key.clone(), old_signing_public_key: first.signing_public_key.clone(),
///     old_ml_dsa_public_key: ml(&first),
///     new_encryption_public_key: next.identity.encryption_public_key.clone(), new_signing_public_key: next.identity.signing_public_key.clone(),
///     new_ml_dsa_public_key: ml(&next.identity),
///     new_kem_public_key: next.identity.kem.clone().unwrap().public_key,
///     signature: next.signature.clone(), consent: None,
/// };
/// let identities = vec![first.clone(), next.identity.clone()];
/// let due = links_needing_consent(vec![link.clone()], identities.clone());
/// assert_eq!((due.len(), due[0].old_identity.key_version, due[0].next_identity.key_version), (1, 1, 2));
/// // Consent already there: nothing to do.
/// let consented = SuccessionLink { consent: Some(next.consent), ..link.clone() };
/// assert!(links_needing_consent(vec![consented], identities).is_empty());
/// // The old side a version 1 identity: never offered.
/// let legacy = IdentityEnvelope { version: 1, ml_dsa: None, keys_signature: None, ..first };
/// assert!(links_needing_consent(vec![link], vec![legacy, next.identity]).is_empty());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn links_needing_consent(
    links: Vec<SuccessionLink>,
    identities: Vec<IdentityEnvelope>,
) -> Vec<ConsentDue> {
    links
        .into_iter()
        .filter(|link| link.consent.as_deref().is_none_or(str::is_empty))
        .filter_map(|link| {
            let old = identities.iter().find(|envelope| names_old(envelope, &link))?.clone();
            let next = identities.iter().find(|envelope| names_new(envelope, &link))?.clone();
            Some(ConsentDue { link, old_identity: old, next_identity: next })
        })
        .collect()
}

fn same_keys(a: &ServedKeys, b: &ServedKeys) -> bool {
    a.key_version == b.key_version
        && a.encryption_public_key == b.encryption_public_key
        && a.signing_public_key == b.signing_public_key
        && a.ml_dsa_public_key == b.ml_dsa_public_key
        && a.kem_public_key == b.kem_public_key
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// The successor's consent for `link`, from `old_identity` to
    /// `next_identity`, two of the unlocked account's identities, under the
    /// account root [`AreaLedger::open_account`] holds (no key crosses the
    /// FFI): the consent statement signed with the old identity's hybrid key
    /// as "old", then with the next one's as "new" (6746 bytes, base64url), as
    /// `identity_succeed` signs it for a new link. Refused, in this order,
    /// unless:
    ///
    /// - `me` is the account the ledger opened (`Unlock your account first.`)
    ///   and holds its current signing key (`Open your identity first.`);
    /// - both are version 2 identities and the next one's key version is higher
    ///   (`Only a link between two upgraded identities takes consent.`);
    /// - both open under the account root, every private half matching its
    ///   public key and each keys statement holding (`This identity does not
    ///   open on this account.`);
    /// - `link` names exactly their keys at their key versions and carries the
    ///   old identity's own version 2 signature over that succession (`This
    ///   link is not one this account made.`): only the account's old key can
    ///   make that signature, so no link a server made up, from a to c past b,
    ///   gets consent, whatever `me` lists;
    /// - the next one follows the old one directly among `me.identities` (the
    ///   account's whole opened history, version 2) sorted by key version
    ///   (`These are not two identities this device opened one after the
    ///   other.`).
    ///
    /// The statement is built from the two envelopes.
    ///
    /// ```
    /// use hushos_core::*;
    /// let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
    /// let first = identity_create(user.clone(), root.clone(), 1)?;
    /// let made = identity_succeed(user.clone(), root.clone(), first.clone())?;
    /// let next = made.identity.clone();
    /// let served = |e: &IdentityEnvelope| {
    ///     let p = public_identity(e.clone()).unwrap();
    ///     ServedKeys { key_version: p.key_version, encryption_public_key: p.encryption_public_key, signing_public_key: p.signing_public_key, ml_dsa_public_key: p.ml_dsa_public_key, kem_public_key: p.kem_public_key }
    /// };
    /// let ml = |e: &IdentityEnvelope| e.ml_dsa.clone().unwrap().public_key;
    /// let link = SuccessionLink {
    ///     old_key_version: 1, new_key_version: 2,
    ///     old_encryption_public_key: first.encryption_public_key.clone(), old_signing_public_key: first.signing_public_key.clone(),
    ///     old_ml_dsa_public_key: ml(&first),
    ///     new_encryption_public_key: next.encryption_public_key.clone(), new_signing_public_key: next.signing_public_key.clone(),
    ///     new_ml_dsa_public_key: ml(&next), new_kem_public_key: next.kem.clone().unwrap().public_key,
    ///     signature: made.signature.clone(), consent: None,
    /// };
    /// let ledger = AreaLedger::new();
    /// ledger.open_account(user.clone(), base64url_decode(next.signing_public_key.clone())?, root)?;
    /// let me = OwnIdentities { user_id: user.clone(), identities: vec![served(&first), served(&next)] };
    /// let consent = ledger.succession_consent_sign(me.clone(), link.clone(), first.clone(), next.clone())?;
    /// assert!(succession_consent_verify(user, SuccessionLink { consent: Some(consent), ..link.clone() }));
    /// // Backwards, or a link whose signature is not the old identity's: nothing signed.
    /// assert!(ledger.succession_consent_sign(me.clone(), link.clone(), next.clone(), first.clone()).is_err());
    /// let forged = SuccessionLink { signature: base64url_encode(vec![0u8; 3373]), ..link };
    /// assert!(ledger.succession_consent_sign(me, forged, first, next).is_err());
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn succession_consent_sign(
        &self,
        me: OwnIdentities,
        link: SuccessionLink,
        old_identity: IdentityEnvelope,
        next_identity: IdentityEnvelope,
    ) -> CoreResult<String> {
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        let root = self.account_root().ok_or_else(|| input(NO_ACCOUNT))?;
        if !me.user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(NO_ACCOUNT));
        }
        let own_key = encode(&account.signing_public_key);
        if !me.identities.iter().any(|keys| keys.signing_public_key == own_key) {
            return Err(input(OPEN_IDENTITY));
        }
        if old_identity.version != 2
            || next_identity.version != 2
            || next_identity.key_version <= old_identity.key_version
        {
            return Err(input(UPGRADED_ONLY));
        }
        // Every key the consent names, not only the two that sign: each private half opens under this
        // account and derives its public key, and each keys statement holds. The opened keys wipe
        // themselves when dropped.
        let user_id = account.user_id.clone();
        let open = |envelope: &IdentityEnvelope| {
            identity_open(user_id.clone(), root.to_vec(), envelope.clone())
                .map_err(|_| input(NOT_OWN_IDENTITY))
        };
        let old_keys = open(&old_identity)?;
        let next_keys = open(&next_identity)?;
        // An opened version 2 identity has all its public keys.
        let (Some(old), Some(next)) = (served_keys_of(&old_identity), served_keys_of(&next_identity)) else {
            return Err(input(UPGRADED_ONLY));
        };
        // The succession is the account's own: its old key signed exactly this step.
        let signer = SuccessionSigner {
            signing_public_key: old.signing_public_key.clone(),
            ml_dsa_public_key: old.ml_dsa_public_key.clone(),
        };
        if !names_old(&old_identity, &link)
            || !names_new(&next_identity, &link)
            || !succession_verify(user_id.clone(), link.clone(), signer)
        {
            return Err(input(NOT_THIS_LINK));
        }
        // And the two are one step of this account's own history, as the app opened it.
        let mut ordered = me.identities.clone();
        ordered.sort_by_key(|keys| keys.key_version);
        let at = ordered.iter().position(|keys| same_keys(keys, &old));
        if !at.and_then(|at| ordered.get(at + 1)).is_some_and(|keys| same_keys(keys, &next)) {
            return Err(input(NOT_CONSECUTIVE));
        }
        let statement_link = SuccessionLink {
            old_key_version: old.key_version,
            new_key_version: next.key_version,
            old_encryption_public_key: old.encryption_public_key,
            old_signing_public_key: old.signing_public_key,
            old_ml_dsa_public_key: old.ml_dsa_public_key,
            new_encryption_public_key: next.encryption_public_key,
            new_signing_public_key: next.signing_public_key,
            new_ml_dsa_public_key: next.ml_dsa_public_key,
            new_kem_public_key: next.kem_public_key,
            signature: String::new(),
            consent: None,
        };
        let statement = |role| succession_consent_statement(user_id.clone(), statement_link.clone(), role);
        let mut consent =
            sign_hybrid(&old_keys.signing_seed, &old_keys.ml_dsa_seed, &statement(ConsentRole::Old)?)?;
        consent.extend(sign_hybrid(
            &next_keys.signing_seed,
            &next_keys.ml_dsa_seed,
            &statement(ConsentRole::New)?,
        )?);
        Ok(encode(&consent))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::decode;
    use crate::groups::tests::Person;
    use crate::identity::succession_consent_verify;

    /* An account with three version 2 identities, a → b → c, and its two links served without consent. */
    struct Account {
        a: Person,
        b: Person,
        c: Person,
        ab: SuccessionLink,
        bc: SuccessionLink,
    }

    fn account() -> Account {
        let a = Person::new(1);
        let (b, ab) = a.succeed();
        let (c, bc) = b.succeed();
        let bare = |link: SuccessionLink| SuccessionLink { consent: None, ..link };
        Account { a, b, c, ab: bare(ab), bc: bare(bc) }
    }

    impl Account {
        fn envelopes(&self) -> Vec<IdentityEnvelope> {
            vec![self.a.envelope.clone(), self.b.envelope.clone(), self.c.envelope.clone()]
        }

        fn me(&self) -> OwnIdentities {
            OwnIdentities {
                user_id: self.a.user_id.clone(),
                identities: vec![self.a.served_keys(), self.b.served_keys(), self.c.served_keys()],
            }
        }

        /* The account unlocked on a ledger: its root held, its current identity (c) open. */
        fn ledger(&self) -> std::sync::Arc<AreaLedger> {
            let ledger = AreaLedger::new();
            let signing = decode("k", &self.c.keys.signing_public_key, None).unwrap();
            ledger.open_account(self.a.user_id.clone(), signing, self.a.root.clone()).unwrap();
            ledger
        }

        fn sign_as(
            &self,
            me: OwnIdentities,
            link: &SuccessionLink,
            old: &Person,
            next: &Person,
        ) -> CoreResult<String> {
            self.ledger().succession_consent_sign(
                me,
                link.clone(),
                old.envelope.clone(),
                next.envelope.clone(),
            )
        }

        fn sign(&self, link: &SuccessionLink, old: &Person, next: &Person) -> CoreResult<String> {
            self.sign_as(self.me(), link, old, next)
        }

        /* A link from `old` to `next` signed with `old`'s own keys: one only the account could make. */
        fn signed_link(&self, old: &Person, next: &Person) -> SuccessionLink {
            let (o, n) = (old.served(), next.served());
            let mut link = SuccessionLink {
                old_key_version: o.key_version,
                new_key_version: n.key_version,
                old_encryption_public_key: o.encryption_public_key,
                old_signing_public_key: o.signing_public_key,
                old_ml_dsa_public_key: o.ml_dsa_public_key,
                new_encryption_public_key: n.encryption_public_key,
                new_signing_public_key: n.signing_public_key,
                new_ml_dsa_public_key: n.ml_dsa_public_key,
                new_kem_public_key: n.kem_public_key,
                signature: String::new(),
                consent: None,
            };
            let statement =
                crate::signatures::succession_statement(old.user_id.clone(), link.clone()).unwrap();
            link.signature =
                encode(&sign_hybrid(&old.keys.signing_seed, &old.keys.ml_dsa_seed, &statement).unwrap());
            link
        }
    }

    /* The a → c link a server could serve: a's and c's keys, with b → c's signature (not a's). */
    fn served_a_to_c(x: &Account) -> SuccessionLink {
        SuccessionLink { signature: x.bc.signature.clone(), ..x.signed_link(&x.a, &x.c) }
    }

    impl Account {}

    fn legacy(envelope: &IdentityEnvelope) -> IdentityEnvelope {
        IdentityEnvelope { version: 1, ml_dsa: None, keys_signature: None, ..envelope.clone() }
    }

    fn offered(links: Vec<SuccessionLink>, identities: Vec<IdentityEnvelope>) -> Vec<(u64, u64)> {
        links_needing_consent(links, identities)
            .iter()
            .map(|due| (due.old_identity.key_version, due.next_identity.key_version))
            .collect()
    }

    #[test]
    fn only_links_without_consent_between_two_upgraded_identities_of_this_account_are_offered() {
        let x = account();
        let consented = SuccessionLink { consent: Some("AA".into()), ..x.bc.clone() };
        assert_eq!(offered(vec![x.ab.clone(), consented], x.envelopes()), vec![(1, 2)]);
        // Consent served empty is no consent.
        let empty = SuccessionLink { consent: Some(String::new()), ..x.bc.clone() };
        assert_eq!(offered(vec![empty], x.envelopes()), vec![(2, 3)]);
        // A version 1 identity on either side: never offered.
        let old_legacy = vec![legacy(&x.a.envelope), x.b.envelope.clone(), x.c.envelope.clone()];
        assert_eq!(offered(vec![x.ab.clone(), x.bc.clone()], old_legacy), vec![(2, 3)]);
        let new_legacy = vec![x.a.envelope.clone(), legacy(&x.b.envelope), x.c.envelope.clone()];
        assert!(offered(vec![x.ab.clone(), x.bc.clone()], new_legacy).is_empty());
        // Each identity at its own key version, with every key the link names on its side.
        let moved = IdentityEnvelope { key_version: 7, ..x.b.envelope.clone() };
        assert!(offered(vec![x.ab.clone()], vec![x.a.envelope.clone(), moved]).is_empty());
        let moved = IdentityEnvelope { key_version: 7, ..x.a.envelope.clone() };
        assert!(offered(vec![x.ab.clone()], vec![moved, x.b.envelope.clone()]).is_empty());
        // Version 1 says so even when an ML-DSA key is served beside it.
        let claims = IdentityEnvelope { version: 1, ..x.a.envelope.clone() };
        assert!(offered(vec![x.ab.clone()], vec![claims, x.b.envelope.clone()]).is_empty());
        let kem = SuccessionLink { new_kem_public_key: x.c.served().kem_public_key, ..x.ab.clone() };
        assert!(offered(vec![kem], x.envelopes()).is_empty());
        let ml_dsa = SuccessionLink { old_ml_dsa_public_key: x.c.served().ml_dsa_public_key, ..x.ab.clone() };
        assert!(offered(vec![ml_dsa], x.envelopes()).is_empty());
        // An identity the account does not have: nothing to consent with.
        assert!(offered(vec![x.ab.clone()], vec![x.a.envelope.clone(), x.c.envelope.clone()]).is_empty());
    }

    #[test]
    fn the_first_of_the_account_s_copies_of_an_identity_is_the_one_offered() {
        let x = account();
        let rewrapped = crate::identity::identity_rewrap(
            x.a.user_id.clone(),
            x.a.root.clone(),
            vec![3; 32],
            x.a.envelope.clone(),
        )
        .unwrap();
        let due = links_needing_consent(
            vec![x.ab.clone()],
            vec![rewrapped.clone(), x.a.envelope.clone(), x.b.envelope.clone()],
        );
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].old_identity, rewrapped);
        assert_eq!(due[0].link, x.ab);
    }

    #[test]
    fn consent_signed_here_holds_for_its_link_in_both_roles_and_for_no_other() {
        let x = account();
        let consent = x.sign(&x.ab, &x.a, &x.b).unwrap();
        assert_eq!(
            decode("consent", &consent, None).unwrap().len(),
            crate::identity::SUCCESSION_CONSENT_BYTES
        );
        let user = x.a.user_id.clone();
        assert!(succession_consent_verify(
            user.clone(),
            SuccessionLink { consent: Some(consent.clone()), ..x.ab.clone() }
        ));
        assert!(!succession_consent_verify(
            user.clone(),
            SuccessionLink { consent: Some(consent.clone()), ..x.bc.clone() }
        ));
        assert!(!succession_consent_verify(
            "00000009-abcd-4abc-8abc-abcdefabcdef".into(),
            SuccessionLink { consent: Some(consent), ..x.ab.clone() }
        ));
        let next = x.sign(&x.bc, &x.b, &x.c).unwrap();
        assert!(succession_consent_verify(user, SuccessionLink { consent: Some(next), ..x.bc.clone() }));
    }

    #[test]
    fn consent_is_signed_only_for_the_account_the_ledger_opened_with_its_identity_open() {
        let x = account();
        let someone = OwnIdentities { user_id: "00000009-abcd-4abc-8abc-abcdefabcdef".into(), ..x.me() };
        assert_eq!(x.sign_as(someone, &x.ab, &x.a, &x.b), Err(input(NO_ACCOUNT)));
        // The account's identities without its current one (c): not the identity the ledger opened.
        let without_current =
            OwnIdentities { identities: vec![x.a.served_keys(), x.b.served_keys()], ..x.me() };
        assert_eq!(x.sign_as(without_current, &x.ab, &x.a, &x.b), Err(input(OPEN_IDENTITY)));
        // A locked ledger holds no root.
        let locked = x.ledger();
        locked.clear();
        let refused =
            locked.succession_consent_sign(x.me(), x.ab.clone(), x.a.envelope.clone(), x.b.envelope.clone());
        assert_eq!(refused, Err(input(NO_ACCOUNT)));
    }

    #[test]
    fn consent_is_refused_unless_both_identities_are_upgraded_and_the_next_is_later() {
        let x = account();
        let refused = |old: IdentityEnvelope, next: IdentityEnvelope| {
            x.ledger().succession_consent_sign(x.me(), x.ab.clone(), old, next)
        };
        assert_eq!(refused(legacy(&x.a.envelope), x.b.envelope.clone()), Err(input(UPGRADED_ONLY)));
        assert_eq!(refused(x.a.envelope.clone(), legacy(&x.b.envelope)), Err(input(UPGRADED_ONLY)));
        assert_eq!(refused(x.b.envelope.clone(), x.a.envelope.clone()), Err(input(UPGRADED_ONLY)));
        assert_eq!(refused(x.a.envelope.clone(), x.a.envelope.clone()), Err(input(UPGRADED_ONLY)));
    }

    #[test]
    fn consent_is_refused_for_an_identity_that_does_not_open_on_this_account() {
        let x = account();
        // Another account root's identity at b's key version.
        let elsewhere = crate::identity::identity_create(x.a.user_id.clone(), vec![4; 32], 2).unwrap();
        let refused =
            x.ledger().succession_consent_sign(x.me(), x.ab.clone(), x.a.envelope.clone(), elsewhere);
        assert_eq!(refused, Err(input(NOT_OWN_IDENTITY)));
        // A keys statement that does not hold.
        let mut signature = decode("s", x.b.envelope.keys_signature.as_ref().unwrap(), None).unwrap();
        signature[100] ^= 1;
        let tampered = IdentityEnvelope { keys_signature: Some(encode(&signature)), ..x.b.envelope.clone() };
        let refused =
            x.ledger().succession_consent_sign(x.me(), x.ab.clone(), x.a.envelope.clone(), tampered);
        assert_eq!(refused, Err(input(NOT_OWN_IDENTITY)));
    }

    #[test]
    fn consent_is_signed_only_for_a_link_the_old_identity_itself_signed() {
        let x = account();
        // A link naming other keys than the two identities.
        assert_eq!(x.sign(&x.bc, &x.a, &x.b), Err(input(NOT_THIS_LINK)));
        // The a → c link a server made up, with someone else's signature: refused whatever `me`
        // lists, b omitted included, so no omission makes a and c one step.
        let a_to_c = served_a_to_c(&x);
        assert_eq!(x.sign(&a_to_c, &x.a, &x.c), Err(input(NOT_THIS_LINK)));
        let without_b = OwnIdentities { identities: vec![x.a.served_keys(), x.c.served_keys()], ..x.me() };
        assert_eq!(x.sign_as(without_b, &a_to_c, &x.a, &x.c), Err(input(NOT_THIS_LINK)));
        // A byte flipped in a's own signature.
        let mut flipped = decode("s", &x.ab.signature, None).unwrap();
        flipped[10] ^= 1;
        let forged = SuccessionLink { signature: encode(&flipped), ..x.ab.clone() };
        assert_eq!(x.sign(&forged, &x.a, &x.b), Err(input(NOT_THIS_LINK)));
    }

    #[test]
    fn consent_is_refused_for_two_identities_that_are_not_one_after_the_other() {
        let x = account();
        // Even a link a itself signed from a to c is no step of the history the app opened.
        let a_to_c = x.signed_link(&x.a, &x.c);
        assert_eq!(x.sign(&a_to_c, &x.a, &x.c), Err(input(NOT_CONSECUTIVE)));
        // b missing from what the app opened: a and c look adjacent, and a → b is not.
        let without_b = OwnIdentities { identities: vec![x.a.served_keys(), x.c.served_keys()], ..x.me() };
        assert_eq!(x.sign_as(without_b, &x.ab, &x.a, &x.b), Err(input(NOT_CONSECUTIVE)));
        // In any order the app lists them, by key version.
        let shuffled = OwnIdentities {
            identities: vec![x.a.served_keys(), x.c.served_keys(), x.b.served_keys()],
            ..x.me()
        };
        assert!(x.sign_as(shuffled.clone(), &x.ab, &x.a, &x.b).is_ok());
        assert_eq!(x.sign_as(shuffled, &a_to_c, &x.a, &x.c), Err(input(NOT_CONSECUTIVE)));
    }
}
