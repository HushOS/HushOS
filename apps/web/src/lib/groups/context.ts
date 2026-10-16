import type {
    AreaRotationInput,
    CryptoRequests,
    CryptoResults,
    GroupPin,
    GroupWriter,
} from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import type { LoadedSettings } from '@/lib/contacts';
import type { GroupsApi } from './api';
import type { GroupStore } from './store';

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
    | 'groupWords'
    | 'groupAccept'
    | 'groupOpenSeal'
    | 'groupOpenArea'
    | 'groupStage'
    | 'groupRestage'
    | 'groupDrop'
    | 'groupGrants'
    | 'groupForget'
    /* A committed roster's join code, shown again to the person letting someone in. */
    | 'groupJoinCode'
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
    | { kind: 'changes-lost'; groupId: string; count: number };

export type GroupSettings = LoadedSettings['settings'] & { groups?: Record<string, GroupPin> };

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
    /* Walks a running Drive rotation in an area to its end (409 rotating). */
    finish(
        groupId: string,
        rotation: { workspaceId: string; rotationId: string; nodeId: string; targetEpoch: number },
    ): Promise<void>;
};

export type GroupContext = {
    userId: string;
    api: GroupsApi;
    rpc: GroupRpc;
    store: GroupStore;
    settings: SettingsAccess;
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
