import type { IdentityEnvelope, SuccessionLink } from './identity';

/* A link of this account's that needs the successor's consent, with the two identities it joins. */
export type ConsentDue = { link: SuccessionLink; old: IdentityEnvelope; next: IdentityEnvelope };

/* The public keys of a version 2 envelope that has them all; null otherwise (a version 1 identity). */
function upgradedKeys(envelope: IdentityEnvelope) {
    if (envelope.version !== 2 || !envelope.mlDsa || !envelope.kem) return null;
    return {
        keyVersion: envelope.keyVersion,
        encryptionPublicKey: envelope.encryptionPublicKey,
        signingPublicKey: envelope.signingPublicKey,
        mlDsaPublicKey: envelope.mlDsa.publicKey,
        kemPublicKey: envelope.kem.publicKey,
    };
}

/* Whether `envelope` is the identity a link names on that side: every public key the consent covers, at its key version. */
export function namesSide(envelope: IdentityEnvelope, link: SuccessionLink, side: 'old' | 'new') {
    const keys = upgradedKeys(envelope);
    if (!keys) return false;
    if (side === 'old')
        return (
            keys.keyVersion === link.oldKeyVersion &&
            keys.encryptionPublicKey === link.oldEncryptionPublicKey &&
            keys.signingPublicKey === link.oldSigningPublicKey &&
            keys.mlDsaPublicKey === link.oldMlDsaPublicKey
        );
    return (
        keys.keyVersion === link.newKeyVersion &&
        keys.encryptionPublicKey === link.newEncryptionPublicKey &&
        keys.signingPublicKey === link.newSigningPublicKey &&
        keys.mlDsaPublicKey === link.newMlDsaPublicKey &&
        keys.kemPublicKey === link.newKemPublicKey
    );
}

/*
 * The links among `links` (this account's own, as contacts are served them)
 * that carry no consent (none, or empty) and join two of its version 2
 * identities among `identities`, each found at its own key version with
 * exactly the keys the link names on that side (the first such identity, in
 * the order given). A link from a version 1 identity is never offered: it has
 * no ML-DSA key to consent with (the server answers it `not-upgraded`). Nor is
 * a link whose keys are not the account's own envelopes. Nothing is verified
 * here: the worker's identityConsent checks what it signs. The twin is the
 * Rust core's links_needing_consent (crates/hushos-core/src/consent.rs);
 * apps/web/src/lib/consent-backfill.ts calls this one. Types only from
 * identity.ts, so the web's main thread imports it without libsodium.
 */
export function linksNeedingConsent(
    links: readonly SuccessionLink[],
    identities: readonly IdentityEnvelope[],
): ConsentDue[] {
    const out: ConsentDue[] = [];
    for (const link of links) {
        if (link.consent) continue;
        const old = identities.find((envelope) => namesSide(envelope, link, 'old'));
        const next = identities.find((envelope) => namesSide(envelope, link, 'new'));
        if (old && next) out.push({ link, old, next });
    }
    return out;
}
