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
    'groupJoinCheck',
    'groupJoinFirstUse',
    'groupPairCode',
    'groupPairMatch',
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
    'groupForeignListings',
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
 * What the worker (and the Rust core) answers a walk of a family-folder node
 * that has shares or links (design 3.4): sharing is hidden there until share
 * records signed at family level exist, so any share is one the server listed,
 * and re-sealing it would hand the fresh node key to whoever it names.
 */
export const SHARED_IN_FAMILY =
    'This item has shares or links, which a family folder never has, so it was not re-keyed.';

/*
 * What the worker answers a share or link sealed in a family folder, and what
 * the server answers one made or changed there (code `family-sharing`):
 * sharing is not offered there until share records signed at family level
 * exist (design 3.4).
 */
export const FAMILY_SHARING = 'Sharing isn’t available in family folders.';

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

/*
 * An acceptance whose session was forgotten (a lock, a sign-out) or whose
 * account changed before it ended, or one run before the account was unlocked
 * or its settings opened: nothing of it is kept, and the order of attempts
 * (record-acceptance.ts) passes it straight to the caller. The core's
 * NOT_THIS_ACCOUNT, NO_ACCOUNT and its settings refusal say the same.
 */
export const NOT_THIS_ACCOUNT = "These keys are not this account's. Unlock again and retry.";
export const NO_ACCOUNT = 'Unlock your account first.';
/* An acceptance before the account's settings were opened in this session. */
export const OPEN_SETTINGS = 'Open your settings first.';
/*
 * An acceptance of a family this session let go of (groupForget) after the
 * acceptance began: what it verified was against what the wipe dropped, so
 * nothing of it is committed, uncommitted or kept, and the order of attempts
 * passes it straight to the caller, as an account error. The core's
 * FAMILY_FORGOTTEN says the same.
 */
export const FAMILY_FORGOTTEN =
    'This family was removed from this device while it was being checked. Sync again.';
/*
 * A wipe (groupForget) whose held guard disagrees with the session's floor
 * (other first keys, or another roster or group key at one version): two
 * histories this device accepted. Nothing is dropped, so the floor stays a mark
 * and the next acceptance of either says what it is. The core's
 * GUARD_CONFLICT says the same.
 */
export const GUARD_CONFLICT =
    'This family looks different from what this device already checked, so nothing of it was removed.';
/*
 * A wipe (groupForget) whose held guard is past the session's floor (a later
 * roster or group key, as another tab or an earlier session accepted): the
 * guard holds digests only at its own versions, so it cannot show the floor is
 * on its history, and dropping the floor could erase a fork's only evidence.
 * Nothing is dropped; the caller brings the floor up to the guard through
 * acceptance (which checks the history between them, and reports a fork),
 * then wipes again. The core's GUARD_AHEAD says the same.
 */
export const GUARD_AHEAD =
    'This device already checked a later member list for this family. Sync it first, then remove it.';

/*
 * The worker's refusal to give the role that holds the family's key (managing
 * the family) to keys this account never checked: its own verified pin of
 * them, over the very keys their entry names (docs/optional-verification.md
 * 3.6). The family page asks for the check before it gets here.
 */
export const CHECK_MANAGER_FIRST =
    'Check it’s them first. Managers are checked before they get the role.';
