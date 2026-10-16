import type { SuccessionLink } from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';

/*
 * The successor's consent for this account's own earlier successions that
 * landed without it (F8; docs/groups-server.md 5, the 1c plan "Consent upload
 * and backfill"). Group verdicts ask consent of the links a member's entry
 * walks, so a link uploaded before the web sent consent would leave this
 * person's own records unchecked in their families until it is filled.
 *
 * For each of the account's links served without consent, both identities
 * are looked up among the account's own envelopes; only a link whose two
 * sides are version 2 identities (an ML-DSA key each) and whose keys are
 * exactly the envelopes' is signed, by the worker, with both identities'
 * keys, and uploaded. Links from version 1 identities cannot take consent
 * and are left alone. The server stores consent only where none is, so a
 * second pass, or another device's, changes nothing.
 */

export type ConsentBackfill = {
    /* This account's own succession links, as contacts are served them (from key version 1). */
    links(): Promise<SuccessionLink[]>;
    /* The account's identity and its earlier ones, sealed under the root. */
    identities(): Promise<{ identity: IdentityEnvelope; history: IdentityEnvelope[] }>;
    /* The worker's identityConsent: both halves, signed by each identity's opened keys. */
    consent(old: IdentityEnvelope, next: IdentityEnvelope): Promise<string>;
    /* POST /api/auth/identity/succession/consent. */
    upload(oldKeyVersion: number, consent: string): Promise<{ stored: boolean }>;
};

/* Whether `envelope` is the identity a link names on that side: every public key the consent covers. */
function names(envelope: IdentityEnvelope, link: SuccessionLink, side: 'old' | 'new') {
    if (envelope.version !== 2) return false;
    if (side === 'old')
        return (
            envelope.keyVersion === link.oldKeyVersion &&
            envelope.encryptionPublicKey === link.oldEncryptionPublicKey &&
            envelope.signingPublicKey === link.oldSigningPublicKey &&
            envelope.mlDsa.publicKey === link.oldMlDsaPublicKey
        );
    return (
        envelope.keyVersion === link.newKeyVersion &&
        envelope.encryptionPublicKey === link.newEncryptionPublicKey &&
        envelope.signingPublicKey === link.newSigningPublicKey &&
        envelope.mlDsa.publicKey === link.newMlDsaPublicKey &&
        envelope.kem.publicKey === link.newKemPublicKey
    );
}

export async function backfillConsent(deps: ConsentBackfill) {
    const missing = (await deps.links()).filter((link) => !link.consent);
    if (missing.length === 0) return { stored: 0 };
    const { identity, history } = await deps.identities();
    const own = [...history, identity];
    let stored = 0;
    for (const link of missing) {
        const old = own.find((envelope) => names(envelope, link, 'old'));
        const next = own.find((envelope) => names(envelope, link, 'new'));
        // A version 1 side, or keys that are not this account's envelopes: nothing to consent to.
        if (!old || !next) continue;
        const consent = await deps.consent(old, next);
        if ((await deps.upload(link.oldKeyVersion, consent)).stored) stored++;
    }
    return { stored };
}
