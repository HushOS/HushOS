import type {
    AreaRotationInput,
    CryptoRequests,
    CryptoResults,
    GroupPin,
    GroupWriter,
} from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import { askPersistentStorage, type FamilyGuardStore } from '@/lib/contact-guard';
import type { LoadedSettings } from '@/lib/contacts';
import type { GroupsApi } from './api';
import type { GroupStore } from './store';
import type { AreaState } from './sync';

/*
 * What the families data layer runs on, gathered so each module takes it as
 * one argument and a test can stand every part in for the real one: the group
 * routes, the crypto worker (where every accepted chain, seed and area key
 * lives; this side gets plain views and sealed records), the device store,
 * the settings document (where the cross-device pin lives), and the Web Lock
 * that keeps one tab writing a family's member list at a time.
 */

/* The worker operations this layer calls. */
export type GroupOperation =
    | 'groupCreate'
    | 'groupAccept'
    /* The join code a newcomer compares, over what route 5 serves: nothing kept. */
    | 'groupJoinPreview'
    | 'groupJoinCheck'
    | 'groupOpenSeal'
    | 'groupOpenArea'
    | 'groupStage'
    | 'groupRestage'
    | 'groupDrop'
    | 'groupGrants'
    /* The current family key sealed again to holders whose keys were folded in (route 9). */
    | 'groupReseal'
    /* A family folder's previous top-folder key checked, and repaired when it does not open (route 28). */
    | 'groupPreviousRoot'
    /* Folders the family's member list names that aren't its own, which the worker ignored. */
    | 'groupForeignListings'
    | 'groupForget'
    /* A member's join code over the committed chain, read to an older app's newcomer (one way). */
    | 'groupJoinCode'
    /* The newcomer's join on first use: the joins record of the head that lets them in. */
    | 'groupJoinFirstUse'
    /* The family check: the pair code with one member, and what "They match" writes. */
    | 'groupPairCode'
    | 'groupPairMatch'
    | 'groupStoreSeal'
    | 'groupStoreOpen'
    | 'identityConsent'
    | 'driveOpenNodes';
export type GroupRpc = <K extends GroupOperation>(
    operation: K,
    input: CryptoRequests[K],
) => Promise<CryptoResults[K]>;

/*
 * What the data layer did on its own that the person should hear about. The
 * UI words them; folder names are sealed, so a folder is named by its id.
 */
export type GroupNotice =
    /* A workspace document did not open, even read again, and went on empty in a rotation. */
    | { kind: 'documents-cleared'; workspaceId: string; document: string }
    /* This device's saved check did not open (a master-key rotation): checked again from version 1. */
    | { kind: 'record-reset'; groupId: string }
    /* Changes that had not reached the server did not open on this device and were dropped. */
    | { kind: 'changes-lost'; groupId: string; count: number }
    /* An earlier version's held-back admission of this person, never sent, was dropped. */
    | { kind: 'admission-dropped'; groupId: string; userId: string }
    /*
     * The family's member list names folders that aren't its own: `owner`'s (another family
     * opened them here), or this account's own files when null. Ignored, never trusted; said
     * on the family's page (lib/families.ts, foreignListingsQueryOptions), and for good, since a
     * member list keeps everything it names.
     */
    | { kind: 'foreign-listing'; groupId: string; owner: string | null; count: number };

/*
 * A family check (docs/optional-verification.md 3.4, 7.2), as filed in the
 * settings: a pair check (`with`, `code`), or an anchor this person vouched
 * for without one (`how`: created, a join code compared, or `before`, a
 * family accepted before first use existed). Any record means checked.
 */
export type FamilyCheck = NonNullable<LoadedSettings['settings']['familyChecks']>[string];

export type GroupSettings = LoadedSettings['settings'] & { groups?: Record<string, GroupPin> };

/*
 * This device's family guard (docs/optional-verification.md 2.8): the latest
 * pin it accepted for each family, kept apart from the device record and the
 * settings, never cleared by anything the server answers. `read` throws when
 * it could not be read (never "none"); `keep` merges a pin in, never lower,
 * and throws when nothing was written.
 */
export type FamilyGuard = {
    read(groupId: string): Promise<GroupPin | null>;
    keep(groupId: string, pin: GroupPin): Promise<GroupPin>;
};
/* One account's family guard, from the store that keeps every account's (lib/contact-guard.ts). */
export function familyGuardOf(store: () => FamilyGuardStore, userId: string): FamilyGuard {
    return {
        read: (groupId) => store().family(userId, groupId),
        keep: (groupId, pin) => {
            // Best-effort storage may be cleared by the browser: the loss residual of 2.8.
            void askPersistentStorage();
            return store().keepFamily(userId, groupId, pin);
        },
    };
}

export type SettingsAccess = {
    /*
     * The stored settings, opened in the worker. Opening them is how the
     * worker learns the settings pins it takes as marks, so every acceptance
     * reads them through here first.
     */
    read(): Promise<{ settings: GroupSettings; version: number }>;
    /* Compare-and-set over `version`: false when another device saved first. */
    write(version: number, settings: GroupSettings): Promise<boolean>;
};

/*
 * What a roster call's rotations need from Drive, supplied by the family
 * folder clients (plan steps 6 and 7). Without it an answer that needs a
 * rotation rebuilt leaves the call in the outbox for a later open.
 */
export type RotationSource = {
    /*
     * Fresh rotation inputs for these areas: the root as route 29 serves it, a
     * target epoch drawn again, and the workspace documents of every kind
     * this client knows plus `kinds` (the ones a 409 document-stale named).
     */
    read(
        groupId: string,
        areas: { workspaceId: string; kinds: string[] }[],
    ): Promise<AreaRotationInput[]>;
    /* Who wrote what the rotations re-sign, as group verdicts take them. */
    writers(groupId: string): Promise<GroupWriter[]>;
    /*
     * Walks a running Drive rotation in an area to its end (409 rotating, a
     * removal's finish step). The walk keeps every writer's record re-keyed,
     * so it needs no word of who is leaving.
     */
    finish(
        groupId: string,
        rotation: { workspaceId: string; rotationId: string; nodeId: string; targetEpoch: number },
    ): Promise<void>;
    /*
     * A sync opened the family's folders (their keys in the worker, their roots
     * listed): what `finish` walks them with follows the latest of them.
     */
    opened?(groupId: string, areas: AreaState[]): void;
};

export type GroupContext = {
    userId: string;
    api: GroupsApi;
    rpc: GroupRpc;
    store: GroupStore;
    settings: SettingsAccess;
    guard: FamilyGuard;
    /*
     * Which unlock of the account this is: it moves on every lock and unlock.
     * An acceptance whose guard was stored after a lock writes nothing more on
     * its chain (docs/optional-verification.md 2.8: the unstored guard went
     * with the session, so the chain is as if never served).
     */
    session?: () => number;
    /* Runs `work` holding `hushos-group-write:<groupId>`, across this browser's tabs. */
    lock<T>(groupId: string, work: () => Promise<T>): Promise<T>;
    sleep(ms: number): Promise<void>;
    now(): Date;
    /* This account's identities as just fetched, for creation (groupCreate proves each). */
    identities(): Promise<{ identity: IdentityEnvelope; history: IdentityEnvelope[] }>;
    /* Deletes family folders' Drive mirrors, when a family is wiped from this device. */
    deleteMirrors(workspaceIds: readonly string[]): Promise<void>;
    rotations: RotationSource | null;
};

/*
 * navigator.locks where there is one. Without it (an old browser, a test
 * environment) work for one group still runs one at a time in this tab.
 */
const local = new Map<string, Promise<unknown>>();
export function groupWriteLock<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const name = `hushos-group-write:${groupId}`;
    if (typeof navigator !== 'undefined' && navigator.locks)
        return navigator.locks.request(name, { mode: 'exclusive' }, work) as Promise<T>;
    const previous = local.get(name) ?? Promise.resolve();
    const next = previous.then(work, work);
    local.set(
        name,
        next.catch(() => {}),
    );
    return next;
}
