export const OPAQUE_PROFILE_VERSION = 1;
export const ENVELOPE_VERSION = 1;
export const OPAQUE_IDENTIFIERS = { server: 'hushos/opaque/profile/1' };
export const KEY_STRETCHING = {
    'argon2id-custom': { memory: 65_536, iterations: 3, parallelism: 4 },
};

export type AccountKeyEnvelope = {
    envelopeVersion: typeof ENVELOPE_VERSION;
    keyVersion: number;
    credentialVersion: number;
    wrappingSalt: string;
    wrappingNonce: string;
    encryptedKey: string;
};

export function accountKeyContext(userId: string, keyVersion: number, credentialVersion: number) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/account-key/password-wrap',
            ENVELOPE_VERSION,
            userId.toLowerCase(),
            keyVersion,
            credentialVersion,
        ]),
    );
}

export const PASSWORD_WRAPPING_CONTEXT = 'hushos/account-key/password-wrap/v1';
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/*
 * The crypto worker's family operations (session-groups.ts, which checks this
 * list against its own requests at compile time). Their failures leave the
 * session as it was (packages/auth/src/ordinary-failure.ts).
 */
export const GROUP_OPERATIONS = [
    'groupCreate',
    'groupWords',
    'groupAccept',
    'groupJoinPreview',
    'groupOpenSeal',
    'groupOpenArea',
    'groupStage',
    'groupRestage',
    'groupDrop',
    'groupGrants',
    'groupReseal',
    'groupVerify',
    'groupJoinCode',
    'groupTrustAs',
    'identityConsent',
    'groupForget',
    'groupStoreSeal',
    'groupStoreOpen',
    'groupPreviousRoot',
] as const;

/*
 * What the crypto worker answers a write in a family folder under a key whose
 * path is not rooted at the folder's current key (design 2.10, F14): a key
 * change has not reached it yet. Uploads wait it out, as for a server's 409
 * `rotating`, instead of failing; everything else shows it.
 */
export const KEY_CHANGE_PENDING =
    'This folder’s keys changed: the key change has not reached it yet.';
/*
 * What the worker answers a walk handed a key it reached only through one the
 * rotation replaces (design 2.10, F14): the item is not carried into the new
 * tree, and the walk cannot finish while it is there.
 */
export const NOT_CARRIED =
    'This item was added under a key the key change replaces, so it is not carried over.';

/*
 * What the crypto worker answers an acceptance that lost a race with a later
 * one this session already committed (a background sync finishing after the
 * foreground's): nothing of it is kept. The data layer reads the device
 * record again and accepts once more, quietly (lib/groups/sync.ts).
 */
export const OLDER_CHAIN =
    'This device already holds a later member list for this family. Sync again.';
/*
 * What the ledger answers a chain at the very roster version it holds with
 * another digest: never committed. Acceptance with the session's committed
 * chain as a mark reports it as a fork (the hard warning) before this.
 */
export const SPLIT_CHAIN = 'This family’s member list was shown differently to this device.';
