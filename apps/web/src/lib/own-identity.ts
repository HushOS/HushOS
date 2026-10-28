import type { AuthApi } from '@hushos/auth/api';
import { IDENTITY_ROLLED_BACK, identityRolledBack } from '@/lib/rollback-marks';

/* The account's identity envelope as the auth API serves it. */
type IdentityEnvelope = Awaited<ReturnType<AuthApi['identity']>>['identity'];

/*
 * Opening this account's own identity, and upgrading a version 1 one before
 * anything is signed (docs/identity-pq-design.md 2). Pure apart from what it
 * is given, so the order of steps and every refusal are tested on their own.
 */

/* What the worker reports for an opened identity (identityOpen). */
export type OpenedIdentity = {
    keyVersion: number;
    identityVersion: 1 | 2;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string | null;
    kemPublicKey: string | null;
};

export type OwnIdentity = {
    keyVersion: number;
    identityVersion: 2;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string;
    kemPublicKey: string;
    /* The envelope opened, which is what a succession must be signed over. */
    envelope: IdentityEnvelope;
};

export type OwnIdentitySteps = {
    /*
     * The served identity and its history (GET /api/auth/identity and
     * /identity/history); read again after another device won the upgrade, since
     * it may also have replaced the identity since.
     */
    fetch(): Promise<{ identity: IdentityEnvelope; history: IdentityEnvelope[] }>;
    /* Opens an envelope in the worker; `refresh` reopens what is already open. */
    open(
        identity: IdentityEnvelope,
        history: IdentityEnvelope[],
        refresh: boolean,
    ): Promise<OpenedIdentity>;
    /* The worker's upgrade of a version 1 envelope: same keys, plus ML-DSA and the keys statement. */
    upgrade(identity: IdentityEnvelope): Promise<IdentityEnvelope>;
    /* POST /api/auth/identity/upgrade, answering the identity stored. */
    store(identity: IdentityEnvelope): Promise<IdentityEnvelope>;
    /* This device's marks for the account, and raising them. */
    seen(): Promise<{ keyVersion: number; identityVersion: number }>;
    remember(keyVersion: number, identityVersion: number): Promise<void>;
};

/* Whether an error from storing the upgrade means another device stored one first. */
function lostTheRace(error: unknown) {
    return (error as { status?: number } | null)?.status === 409;
}

async function refuseRollback(
    served: { keyVersion: number; identityVersion: number },
    steps: OwnIdentitySteps,
) {
    // An older identity served as current is refused, as older settings are: it would bring
    // back keys this account replaced, and records they signed. Once this device has seen
    // version 2, the version 1 form is a rollback too, and upgrading it again would mint a
    // second ML-DSA key.
    if (identityRolledBack(served, await steps.seen())) throw new Error(IDENTITY_ROLLED_BACK);
}

/*
 * Checked before the worker opens an envelope, not only after: opening one
 * makes it the worker's identity, and a replaced identity, still sealed under
 * this account's root, opens fine and would sign from then on.
 */
const servedForm = (identity: IdentityEnvelope) => ({
    keyVersion: identity.keyVersion,
    identityVersion: identity.version,
});

export async function openOwnIdentity(
    steps: OwnIdentitySteps,
    refresh = false,
): Promise<OwnIdentity> {
    let { identity, history } = await steps.fetch();
    await refuseRollback(servedForm(identity), steps);
    let opened = await steps.open(identity, history, refresh);
    await refuseRollback(opened, steps);
    if (opened.identityVersion === 1) {
        const upgraded = await steps.upgrade(identity);
        try {
            identity = await steps.store(upgraded);
        } catch (error) {
            if (!lostTheRace(error)) throw error;
            ({ identity, history } = await steps.fetch());
        }
        await refuseRollback(servedForm(identity), steps);
        opened = await steps.open(identity, history, true);
        // The identity adopted after a race, or answered by the server, is checked as any other.
        await refuseRollback(opened, steps);
    }
    if (opened.identityVersion !== 2 || !opened.mlDsaPublicKey || !opened.kemPublicKey)
        throw new Error('Your keys could not be upgraded. Try again.');
    await steps.remember(opened.keyVersion, 2);
    return {
        keyVersion: opened.keyVersion,
        identityVersion: 2,
        encryptionPublicKey: opened.encryptionPublicKey,
        signingPublicKey: opened.signingPublicKey,
        mlDsaPublicKey: opened.mlDsaPublicKey,
        kemPublicKey: opened.kemPublicKey,
        envelope: identity,
    };
}
