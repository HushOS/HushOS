import type { AcceptedRosters } from './group-trust';
import { areaWriteVersion, checkAreaRoot } from './groups';
import { CryptoError } from './errors';
import { decode } from './keys';
import { generateKey, openNodeKey, openPreviousRootKey, wrapNodeKey } from './drive';
import { KEY_CHANGE_PENDING, NOT_CARRIED } from './protocol';

/*
 * The crypto worker's Drive keys and the family write rules that hold them
 * (docs/groups-design.md 2.6 and 2.10, flags F9 and F14): every workspace key
 * and node key the session opened, which of them a write may use, and, for a
 * group area, the version it is written under. Moved out of session.ts and
 * session-groups.ts unchanged so the Rust core has a twin to be held to
 * (crates/hushos-core/src/area_ledger.rs): the shared fixtures run the same
 * scenarios through both (scripts/area-ledger-fixtures.ts,
 * examples/area_ledger_fixtures.rs), and the fuzz target `area_ledger`
 * compares them on any sequence of steps.
 *
 * Nothing here talks to the server. The group session tells it what it knows
 * of the families (`host`): which workspaces are areas of a committed chain or
 * opened on this device, and the committed chain that lists an area.
 */

export const KEYS_CHANGED = 'This folder’s keys changed. Reload to continue.';
export const NOT_CHECKED_KEYS = 'Couldn’t check this folder’s keys. Reload to continue.';
export const AREA_ROOT = 'A family folder’s top level changes only with the family’s member list.';
export const NOT_COMMITTED_ROOT =
    'This folder’s key is not the one the family’s member list names.';

/* Why a group area may not be written (groupOpenArea's `reason`). */
export type AreaBlock =
    | 'no-grant-at-latest'
    | 'server-behind'
    | 'server-ahead'
    | 'root-unknown'
    | 'root-behind';

export type AreaLedgerHost = {
    /* Whether the group session knows the workspace as an area: opened here, or on a committed chain. */
    knownArea(workspaceId: string): boolean;
    /* The committed chain that lists the area, if any. */
    chainOf(workspaceId: string): AcceptedRosters | undefined;
};

/* A node key envelope as a listing serves it, with its previous one while a rotation runs. */
export type ServedNodeKey = {
    id: string;
    parentId: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    keyEnvelope: string;
    prevKeyEnvelope?: string | null;
    prevKeyEpoch?: number | null;
    prevParentKeyEpoch?: number | null;
};

/* A node as rotation work serves it, as far as its key goes. */
export type RotatingNodeKey = {
    id: string;
    parentId: string;
    /* The parent's key epoch to wrap the new key under. */
    parentKeyEpoch: number;
    /* The node's key epoch now, and the parent epoch its envelope was wrapped under. */
    keyEpoch: number;
    wrappedParentKeyEpoch: number;
    keyEnvelope: string;
};

/*
 * `own`: a previous key this device opened itself as the node's current key
 * (before it was re-keyed), not one a served previous envelope gave it. Only
 * an own key outranks, or repairs, what the server serves (groupPreviousRoot).
 */
type NodeKeys = Map<string, { key: Uint8Array<ArrayBuffer>; epoch: number; own?: boolean }>;

/*
 * Keys a rotation batch made and the server has not confirmed: the fresh
 * key children are wrapped under in the same walk, and the key it
 * replaces. They become the node's keys only on driveRotateCommit, so a
 * refused batch never leaves the device holding a key the server never
 * stored as current, nor the replaced key passing as a mere previous one.
 */
export type PendingKey = {
    fresh: Uint8Array<ArrayBuffer>;
    epoch: number;
    old: Uint8Array<ArrayBuffer>;
    oldEpoch: number;
    /* What the parent key the fresh one is wrapped under is rooted at (`lineage`). */
    rootedAt: number | null;
};

export function createAreaLedger(host: AreaLedgerHost) {
    /*
     * Drive keys, opened on demand and kept for the session; every one dies
     * with a lock. Each workspace keeps every key version this session opened:
     * after a group area's rotation, documents not yet re-sealed and anything a
     * walk has not reached are under an earlier one. Any held version opens;
     * only the version the workspace is written under (`writeKeyFor`) wraps.
     */
    const workspaceKeys = new Map<
        string,
        { current: number; keys: Map<number, Uint8Array<ArrayBuffer>> }
    >();
    /*
     * Node keys by workspace and node, in two pools: the account's own
     * workspaces (whose grants this worker opened) and everything reached
     * through a share, a link or a report. A key from a share, link or report
     * arrives under a workspace and node the server named, so it must never
     * stand in for a key of the person's own tree, where it would wrap every new
     * child and upload under a key the server chose.
     */
    const ownNodeKeys: NodeKeys = new Map();
    const guestNodeKeys: NodeKeys = new Map();
    /*
     * In a group area, the area key version each held node key's path is
     * rooted at: the root opened under the area key at that version, then
     * each child opened under its parent's current key (design 2.10, F14).
     * Null (or absent) for a key reached through any previous key on the way
     * (option A's previous-root envelope, a parent's previous key, a walk's
     * old key): such a key is the one a removed member may hold, so it reads
     * and never writes. A write in a group area needs a parent whose path is
     * rooted at the area's write version, so keys cached under an earlier
     * root take nothing new after a rotation either.
     */
    const lineage = new Map<string, number | null>();
    /* Previous node keys while a rotation runs: what children not yet rotated are still wrapped under. */
    const ownPrevNodeKeys: NodeKeys = new Map();
    const guestPrevNodeKeys: NodeKeys = new Map();
    const pendingNodeKeys = new Map<string, PendingKey>();
    /* The area key version each cached group area root key was opened under (driveOpenNodes). */
    const rootOpenedUnder = new Map<string, number>();
    /* Each area's write version, from the committed chain only (F9). */
    const areaWrite = new Map<string, number>();
    /*
     * Areas the last groupOpenArea found unwritable, and why: the server
     * behind or ahead of the chain, or no grant at the latest version.
     */
    const blocked = new Map<string, AreaBlock>();
    /*
     * The area key version each area's root was last opened under, by a real
     * open of its envelope in a listing (rootSeen): the area is written only
     * while that is its write version. Nothing a caller says sets it.
     */
    const rootSeenAt = new Map<string, number>();

    const slot = (workspaceId: string, nodeId: string) => `${workspaceId}/${nodeId}`;
    function zeroPending(pending: PendingKey) {
        pending.fresh.fill(0);
        pending.old.fill(0);
    }

    /* ---------------------------------------------------------------- */
    /* Group areas: which are, and the version each is written under     */
    /* ---------------------------------------------------------------- */

    function isArea(workspaceId: string) {
        if (areaWrite.has(workspaceId) || blocked.has(workspaceId) || rootSeenAt.has(workspaceId))
            return true;
        return host.knownArea(workspaceId);
    }
    /* The version a group area is read under (its write version), null for a workspace that is no group's area. */
    function readVersion(workspaceId: string): number | null {
        if (!isArea(workspaceId)) return null;
        const version = areaWrite.get(workspaceId);
        if (version === undefined) throw new CryptoError(NOT_CHECKED_KEYS);
        return version;
    }
    /* The version a group area is written under, null for a workspace that is no group's area. */
    function writeVersion(workspaceId: string): number | null {
        if (!isArea(workspaceId)) return null;
        if (blocked.has(workspaceId)) throw new CryptoError(KEYS_CHANGED);
        const version = readVersion(workspaceId)!;
        // Only once a root wrapped under this very version was opened here.
        if (rootSeenAt.get(workspaceId) !== version) throw new CryptoError(KEYS_CHANGED);
        return version;
    }
    /* Why an area may not be written, or null. */
    function unwritable(workspaceId: string, latest: number): AreaBlock | null {
        const reason = blocked.get(workspaceId);
        if (reason) return reason;
        const seen = rootSeenAt.get(workspaceId);
        return seen === latest ? null : seen === undefined ? 'root-unknown' : 'root-behind';
    }
    /*
     * Refuses any write into a group area the worker has not found writable:
     * blocked, not checked against a committed chain, or without the key at
     * the write version (F9). Every Drive write in the session calls it.
     */
    function requireWritable(workspaceId: string) {
        const version = writeVersion(workspaceId);
        if (version !== null && !workspaceKeys.get(workspaceId)?.keys.get(version))
            throw new CryptoError(KEYS_CHANGED);
    }
    /*
     * An area root a listing has just opened, its envelope opened under the
     * area key at `parentKeyEpoch` (never a cached key the row only claims):
     * the area is writable only while that is its write version, and only
     * when the committed chain committed to this root key at that version
     * (design 2.10, F14; a version a format 1 roster listed keeps the
     * envelope rule). False when the key is not the committed one: the caller
     * drops it, and the root reads as couldn't-check.
     */
    async function rootSeen(workspaceId: string, parentKeyEpoch: number, rootKey: Uint8Array) {
        if (!isArea(workspaceId)) return true;
        const chain = host.chainOf(workspaceId);
        // Without a committed chain nothing says which root is current: no write until one.
        if (!chain) return true;
        try {
            await checkAreaRoot(chain, workspaceId, parentKeyEpoch, rootKey);
        } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
            if (rootSeenAt.get(workspaceId) === parentKeyEpoch) rootSeenAt.delete(workspaceId);
            return false;
        }
        rootSeenAt.set(workspaceId, parentKeyEpoch);
        return true;
    }
    /*
     * A committed chain's areas: each one's write version. A new write version
     * needs its root seen again (rootSeenAt no longer matches it). A retired
     * area (a deleted family folder, design 2.10) is written no more.
     */
    function commitAreas(chain: AcceptedRosters) {
        for (const workspaceId of Object.keys(chain.areaKeys)) {
            const version = areaWriteVersion(chain, workspaceId);
            if (version === null) {
                areaWrite.delete(workspaceId);
                rootSeenAt.delete(workspaceId);
            } else areaWrite.set(workspaceId, version);
        }
    }
    /* A refusal or a fork: these areas are not written until a chain is committed again. */
    function uncommitAreas(workspaceIds: Iterable<string>) {
        for (const workspaceId of workspaceIds) areaWrite.delete(workspaceId);
    }
    /* A group the person no longer reads: its areas' keys and everything about them. */
    function forgetAreas(workspaceIds: Iterable<string>) {
        for (const workspaceId of workspaceIds) {
            dropWorkspace(workspaceId);
            areaWrite.delete(workspaceId);
            blocked.delete(workspaceId);
            rootSeenAt.delete(workspaceId);
        }
    }
    /* Every area: what forgetting every group drops. */
    function forgetAllAreas() {
        for (const workspaceId of areaWrite.keys()) dropWorkspace(workspaceId);
        areaWrite.clear();
        blocked.clear();
        rootSeenAt.clear();
    }
    /*
     * An area key a grant (or self-grant) opened at `version`, the latest
     * version the chain lists being `latest` and the server's `served`: held,
     * and the area blocked when it is behind the chain or either side
     * disagrees. Writable only once a root at the latest version is seen too.
     */
    function admitAreaKey(
        workspaceId: string,
        version: number,
        key: Uint8Array<ArrayBuffer>,
        served: number,
        latest: number,
    ): AreaBlock | null {
        const reason: AreaBlock | null =
            version < latest
                ? 'no-grant-at-latest'
                : served < latest
                  ? 'server-behind'
                  : served > latest
                    ? 'server-ahead'
                    : null;
        holdWorkspaceKey(workspaceId, version, key);
        if (reason) blocked.set(workspaceId, reason);
        else blocked.delete(workspaceId);
        // The root is the listing's to decide (rootSeen): until one is opened at the latest
        // version, the area reads 'root-unknown' (or 'root-behind') and is not written.
        return unwritable(workspaceId, latest);
    }

    /* ---------------------------------------------------------------- */
    /* Workspace and node keys                                           */
    /* ---------------------------------------------------------------- */

    function holdWorkspaceKey(workspaceId: string, version: number, key: Uint8Array<ArrayBuffer>) {
        const entry = workspaceKeys.get(workspaceId) ?? { current: version, keys: new Map() };
        entry.keys.get(version)?.fill(0);
        entry.keys.set(version, key);
        entry.current = Math.max(entry.current, version);
        workspaceKeys.set(workspaceId, entry);
    }
    function workspaceKey(workspaceId: string, version: number) {
        return workspaceKeys.get(workspaceId)?.keys.get(version);
    }
    /* Every key version held for a workspace, newest first; undefined when none is. */
    function workspaceVersions(workspaceId: string) {
        const workspace = workspaceKeys.get(workspaceId);
        return workspace ? [...workspace.keys.keys()].sort((a, b) => b - a) : undefined;
    }
    function hasWorkspace(workspaceId: string) {
        return workspaceKeys.has(workspaceId);
    }
    /* A workspace's keys and every node key under it, zeroed: a group area the person no longer reads. */
    function dropWorkspace(workspaceId: string) {
        const entry = workspaceKeys.get(workspaceId);
        for (const key of entry?.keys.values() ?? []) key.fill(0);
        workspaceKeys.delete(workspaceId);
        for (const pool of [ownNodeKeys, guestNodeKeys, ownPrevNodeKeys, guestPrevNodeKeys])
            for (const [at, held] of pool)
                if (at.startsWith(`${workspaceId}/`)) {
                    held.key.fill(0);
                    pool.delete(at);
                }
        for (const at of rootOpenedUnder.keys())
            if (at.startsWith(`${workspaceId}/`)) rootOpenedUnder.delete(at);
        for (const at of lineage.keys()) if (at.startsWith(`${workspaceId}/`)) lineage.delete(at);
        for (const [at, pending] of pendingNodeKeys)
            if (at.startsWith(`${workspaceId}/`)) {
                zeroPending(pending);
                pendingNodeKeys.delete(at);
            }
    }
    /* Every key, zeroed: a lock. */
    function clear() {
        for (const entry of workspaceKeys.values())
            for (const key of entry.keys.values()) key.fill(0);
        for (const pool of [ownNodeKeys, guestNodeKeys, ownPrevNodeKeys, guestPrevNodeKeys]) {
            for (const entry of pool.values()) entry.key.fill(0);
            pool.clear();
        }
        for (const pending of pendingNodeKeys.values()) zeroPending(pending);
        pendingNodeKeys.clear();
        rootOpenedUnder.clear();
        lineage.clear();
        workspaceKeys.clear();
    }
    function nodeKeysOf(workspaceId: string) {
        return workspaceKeys.has(workspaceId) ? ownNodeKeys : guestNodeKeys;
    }
    function prevNodeKeysOf(workspaceId: string) {
        return workspaceKeys.has(workspaceId) ? ownPrevNodeKeys : guestPrevNodeKeys;
    }
    function nodeKey(workspaceId: string, nodeId: string) {
        return nodeKeysOf(workspaceId).get(slot(workspaceId, nodeId));
    }
    /* The previous key held for a node (and whether this device opened it itself). */
    function prevNodeKey(workspaceId: string, nodeId: string) {
        return prevNodeKeysOf(workspaceId).get(slot(workspaceId, nodeId));
    }
    /* A node key made in a batch that failed: dropped (the caller zeroes it). */
    function forgetNodeKey(workspaceId: string, nodeId: string) {
        nodeKeysOf(workspaceId).delete(slot(workspaceId, nodeId));
    }
    /*
     * The node's key at `epoch` as this session holds it (its current key, or
     * the previous one a rotation in progress keeps), for a re-keyed record's
     * check; null when it holds neither at that epoch, which reads unchecked.
     */
    function keyAtEpoch(workspaceId: string, nodeId: string, epoch: number) {
        const current = nodeKey(workspaceId, nodeId);
        if (current?.epoch === epoch) return current.key;
        const previous = prevNodeKeysOf(workspaceId).get(slot(workspaceId, nodeId));
        return previous?.epoch === epoch ? previous.key : null;
    }
    /* A share, link or report naming one of this account's own workspaces: a key planted, never taken. */
    function refuseOwnWorkspace(workspaceId: string) {
        if (workspaceKeys.has(workspaceId))
            throw new CryptoError('This was refused: it claims to be a folder of your own.');
    }
    /*
     * The key a node is wrapped under, to open it: the workspace key at that
     * version for the root (any version held), else its parent's key or, while
     * a rotation runs, its parent's previous key, or the parent's key a
     * rotation batch made and the server has not confirmed yet.
     */
    function parentKeyFor(workspaceId: string, parentId: string, parentKeyEpoch: number) {
        return parentKeyAndRoot(workspaceId, parentId, parentKeyEpoch).key;
    }
    /*
     * The same, with the area key version the key's path is rooted at (null
     * through any previous key: see `lineage`): what a node opened under it
     * is rooted at too.
     */
    function parentKeyAndRoot(
        workspaceId: string,
        parentId: string,
        parentKeyEpoch: number,
    ): { key: Uint8Array<ArrayBuffer>; rootedAt: number | null } {
        if (parentId === workspaceId) {
            const workspace = workspaceKeys.get(workspaceId);
            if (!workspace) throw new CryptoError('Open Drive again to continue.');
            const key = workspace.keys.get(parentKeyEpoch);
            if (!key)
                throw new CryptoError('This folder was wrapped under an older workspace key.');
            return { key, rootedAt: parentKeyEpoch };
        }
        const pending = pendingNodeKeys.get(slot(workspaceId, parentId));
        if (pending?.epoch === parentKeyEpoch)
            return { key: pending.fresh, rootedAt: pending.rootedAt };
        if (pending?.oldEpoch === parentKeyEpoch) return { key: pending.old, rootedAt: null };
        const parent = nodeKey(workspaceId, parentId);
        if (!parent) throw new CryptoError('Open the containing folder first.');
        if (parent.epoch === parentKeyEpoch)
            return { key: parent.key, rootedAt: lineage.get(slot(workspaceId, parentId)) ?? null };
        const previous = prevNodeKeysOf(workspaceId).get(slot(workspaceId, parentId));
        if (previous && previous.epoch === parentKeyEpoch)
            return { key: previous.key, rootedAt: null };
        throw new CryptoError('This item was wrapped under an older folder key.');
    }
    /*
     * What a node made under `parentId` at `parentKeyEpoch` is rooted at: what
     * that parent key is rooted at, a walk's pending key included (as for
     * driveOpenNodes), or the version for a root.
     */
    function rootOf(workspaceId: string, parentId: string, parentKeyEpoch: number) {
        return parentKeyAndRoot(workspaceId, parentId, parentKeyEpoch).rootedAt;
    }
    /*
     * A node's key for a write that puts something under it (its metadata, a
     * version, a share, a re-wrap): in a group area only one whose path is
     * rooted at the area's write version (`lineage`), never one reached
     * through a previous key a removed member may hold.
     */
    function writableNodeKey(workspaceId: string, nodeId: string) {
        const node = nodeKey(workspaceId, nodeId);
        if (node && isArea(workspaceId) && !rootedAtWriteVersion(workspaceId, nodeId))
            throw new CryptoError(KEY_CHANGE_PENDING);
        return node;
    }
    function rootedAtWriteVersion(workspaceId: string, nodeId: string) {
        return rootedNow(workspaceId, lineage.get(slot(workspaceId, nodeId)) ?? null);
    }
    /* Whether a key rooted at `rootedAt` is rooted at the area's write version now. */
    function rootedNow(workspaceId: string, rootedAt: number | null) {
        return rootedAt !== null && rootedAt === writeVersion(workspaceId);
    }
    /*
     * The workspace key version new things are wrapped under: a group area's
     * latest on its accepted member list (areaWriteVersion, refused while the
     * area cannot be written), else the newest this session opened.
     */
    function writeVersionOf(workspaceId: string) {
        const workspace = workspaceKeys.get(workspaceId);
        if (!workspace) throw new CryptoError('Open Drive again to continue.');
        const version = writeVersion(workspaceId) ?? workspace.current;
        const key = workspace.keys.get(version);
        if (!key) throw new CryptoError(KEYS_CHANGED);
        return { version, key };
    }
    /*
     * The key a new or re-wrapped node goes under. For the root, only the
     * workspace key at the version the workspace is written under, never an
     * older one held for reading (a group area's rule F9: a withheld rotation
     * must not keep anyone writing under a key a removed member holds). In a
     * group area, never a parent's previous key either: that is the key the
     * rotation is taking away.
     */
    function wrapKeyFor(workspaceId: string, parentId: string, parentKeyEpoch: number) {
        if (parentId === workspaceId) {
            // A family folder has one root, made and re-keyed only with its roster (groupCreate,
            // groupStage): nothing in Drive wraps a key directly under its area key.
            if (isArea(workspaceId)) throw new CryptoError(AREA_ROOT);
            const { version, key } = writeVersionOf(workspaceId);
            if (version !== parentKeyEpoch) throw new CryptoError(KEYS_CHANGED);
            return key;
        }
        if (!isArea(workspaceId)) return parentKeyFor(workspaceId, parentId, parentKeyEpoch);
        // A write needs a parent whose key path is rooted at the area's write version (F14): never
        // one opened through a previous key, or cached under a root a rotation has replaced, nor
        // a walk's pending key made before the area's next roster landed. A walk is held to it
        // too, its re-wraps included.
        const pending = pendingNodeKeys.get(slot(workspaceId, parentId));
        if (pending?.epoch === parentKeyEpoch) {
            if (!rootedNow(workspaceId, pending.rootedAt))
                throw new CryptoError(KEY_CHANGE_PENDING);
            return pending.fresh;
        }
        const parent = nodeKey(workspaceId, parentId);
        if (!parent) throw new CryptoError('Open the containing folder first.');
        if (!rootedAtWriteVersion(workspaceId, parentId)) throw new CryptoError(KEY_CHANGE_PENDING);
        if (parent.epoch === parentKeyEpoch && pending?.oldEpoch !== parentKeyEpoch)
            return parent.key;
        throw new CryptoError(KEYS_CHANGED);
    }
    function rememberNodeKey(
        workspaceId: string,
        nodeId: string,
        key: Uint8Array<ArrayBuffer>,
        epoch: number,
        rootedAt: number | null = null,
    ) {
        const pool = nodeKeysOf(workspaceId);
        pool.get(slot(workspaceId, nodeId))?.key.fill(0);
        pool.set(slot(workspaceId, nodeId), { key, epoch });
        lineage.set(slot(workspaceId, nodeId), rootedAt);
        // Whatever opened it before, this key was not opened from a root row here.
        rootOpenedUnder.delete(slot(workspaceId, nodeId));
    }
    function rememberPrevNodeKey(
        workspaceId: string,
        nodeId: string,
        key: Uint8Array<ArrayBuffer>,
        epoch: number,
        own = false,
    ) {
        const pool = prevNodeKeysOf(workspaceId);
        pool.get(slot(workspaceId, nodeId))?.key.fill(0);
        pool.set(slot(workspaceId, nodeId), { key, epoch, own });
    }

    /* ---------------------------------------------------------------- */
    /* Listings, new nodes and rotations                                  */
    /* ---------------------------------------------------------------- */

    /*
     * A listed node's key, opened (or taken from the session) and held with
     * what its path is rooted at, with its previous key while a rotation runs.
     * A group area's root also decides whether the area may be written
     * (rootSeen); one whose key is not the committed one is dropped and
     * refused. Returns the node's key, held by the session.
     */
    async function openListedNode(workspaceId: string, node: ServedNodeKey) {
        const cached = nodeKey(workspaceId, node.id);
        const at = slot(workspaceId, node.id);
        // A group area's root is taken from the cache only under the area key
        // version it was opened under: a row that names another is opened again.
        const areaRoot = node.parentId === workspaceId && isArea(workspaceId);
        let key =
            cached &&
            cached.epoch === node.keyEpoch &&
            (!areaRoot || rootOpenedUnder.get(at) === node.parentKeyEpoch)
                ? cached.key
                : undefined;
        // An area root re-keyed since this device opened it: the key it held is
        // the root's previous one, kept if the served previous envelope does not
        // open (a holder repairs that envelope with it: groupPreviousRoot).
        let heldPrevious: Uint8Array<ArrayBuffer> | null =
            areaRoot &&
            !key &&
            cached &&
            node.prevKeyEpoch !== null &&
            node.prevKeyEpoch !== undefined &&
            cached.epoch === node.prevKeyEpoch &&
            cached.epoch !== node.keyEpoch
                ? cached.key.slice()
                : null;
        if (!key) {
            let rootedAt: number | null;
            try {
                const parent = parentKeyAndRoot(workspaceId, node.parentId, node.parentKeyEpoch);
                rootedAt = parent.rootedAt;
                key = (await openNodeKey(decode(node.keyEnvelope, 72), parent.key, {
                    workspaceId,
                    nodeId: node.id,
                    parentId: node.parentId,
                    parentKeyEpoch: node.parentKeyEpoch,
                    keyEpoch: node.keyEpoch,
                })) as Uint8Array<ArrayBuffer>;
            } catch (error) {
                heldPrevious?.fill(0);
                throw error;
            }
            rememberNodeKey(workspaceId, node.id, key, node.keyEpoch, rootedAt);
            if (areaRoot) rootOpenedUnder.set(at, node.parentKeyEpoch);
        }
        // A group area's root decides whether the area may be written: only one
        // whose envelope opened under the area's write version (a withheld root
        // rotation's does not, nor does option A's previous-root envelope), and
        // whose key is the one the roster committed to at that version (design
        // 2.10: a root rolled back under the same area key is not current).
        if (areaRoot && !(await rootSeen(workspaceId, node.parentKeyEpoch, key))) {
            const pool = nodeKeysOf(workspaceId);
            pool.get(at)?.key.fill(0);
            pool.delete(at);
            rootOpenedUnder.delete(at);
            heldPrevious?.fill(0);
            throw new CryptoError(NOT_COMMITTED_ROOT);
        }
        // Mid-rotation: the same key under the previous parent key opens
        // children the rotation has not reached; failure to open it is
        // not failure to open the node.
        if (node.prevKeyEnvelope && node.prevParentKeyEpoch && node.prevKeyEpoch) {
            let previous: Uint8Array<ArrayBuffer> | null = null;
            try {
                const previousParent = parentKeyFor(
                    workspaceId,
                    node.parentId,
                    node.prevParentKeyEpoch,
                );
                const ctx = {
                    workspaceId,
                    nodeId: node.id,
                    parentId: node.parentId,
                    parentKeyEpoch: node.prevParentKeyEpoch,
                    keyEpoch: node.prevKeyEpoch,
                };
                const envelope = decode(node.prevKeyEnvelope, 72);
                // An area root's previous key under the new area key is option A's,
                // under its own label; one a Drive batch kept is a plain node key.
                previous = (
                    areaRoot
                        ? await openPreviousRootKey(envelope, previousParent, ctx).catch(() =>
                              openNodeKey(envelope, previousParent, ctx),
                          )
                        : await openNodeKey(envelope, previousParent, ctx)
                ) as Uint8Array<ArrayBuffer>;
            } catch {
                /* The previous parent key is not held here; only rotated nodes open. */
            }
            // An area root's old key this device opened itself, held now or kept
            // from an earlier open, outranks whatever the served envelope opens to:
            // a previous envelope holding another key would otherwise replace it and
            // shut the unrotated part for everyone (groupPreviousRoot repairs it).
            const kept = prevNodeKeysOf(workspaceId).get(at);
            const own =
                heldPrevious ??
                (areaRoot && kept?.own && kept.epoch === node.prevKeyEpoch
                    ? kept.key.slice()
                    : null);
            heldPrevious = null;
            if (own) {
                previous?.fill(0);
                rememberPrevNodeKey(workspaceId, node.id, own, node.prevKeyEpoch, true);
            } else if (previous)
                rememberPrevNodeKey(workspaceId, node.id, previous, node.prevKeyEpoch);
        }
        heldPrevious?.fill(0);
        return key;
    }
    /*
     * A new node's key, made and wrapped under its parent (wrapKeyFor's rules),
     * and held rooted where its parent is. The caller seals and signs what goes
     * under it; on a failed batch it calls forgetNodeKey and zeroes the key.
     */
    async function newNodeKey(
        workspaceId: string,
        node: { id: string; parentId: string; parentKeyEpoch: number; keyEpoch: number },
    ) {
        const parentKey = wrapKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
        const key = generateKey();
        try {
            const keyEnvelope = await wrapNodeKey(key, parentKey, {
                workspaceId,
                nodeId: node.id,
                parentId: node.parentId,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: node.keyEpoch,
            });
            // Later nodes in a batch may be children of this one. Rooted where its
            // parent is (wrapKeyFor saw to it).
            rememberNodeKey(
                workspaceId,
                node.id,
                key,
                node.keyEpoch,
                rootOf(workspaceId, node.parentId, node.parentKeyEpoch),
            );
            return { key, keyEnvelope };
        } catch (error) {
            key.fill(0);
            throw error;
        }
    }
    /*
     * A node's key as it is now, the caller's to zero: cached from a listing,
     * or opened under the parent key its envelope was wrapped under (a
     * previous one, when the parent rotated first).
     */
    async function currentKeyOf(workspaceId: string, node: RotatingNodeKey) {
        const cached = nodeKey(workspaceId, node.id);
        if (cached && cached.epoch === node.keyEpoch) return cached.key.slice();
        return (await openNodeKey(
            decode(node.keyEnvelope, 72),
            parentKeyFor(workspaceId, node.parentId, node.wrappedParentKeyEpoch),
            {
                workspaceId,
                nodeId: node.id,
                parentId: node.parentId,
                parentKeyEpoch: node.wrappedParentKeyEpoch,
                keyEpoch: node.keyEpoch,
            },
        )) as Uint8Array<ArrayBuffer>;
    }
    /*
     * The key a walk replaces (or re-wraps), the caller's to zero. A family
     * folder's root is re-keyed only by its roster rotation (groupStage), never
     * by a Drive walk: a walk would open whatever root envelope it is served
     * under an older area key and wrap that key, or cache it, as the root's
     * current one.
     */
    async function rotationOldKey(workspaceId: string, node: RotatingNodeKey) {
        if (node.parentId === workspaceId && isArea(workspaceId)) throw new CryptoError(AREA_ROOT);
        return currentKeyOf(workspaceId, node);
    }
    /*
     * A walk's node already at its target, only wrapped under an unrotated
     * parent: the same key, re-wrapped under the parent's key at
     * `parentKeyEpoch`. Takes `old` (the node's current key, currentKeyOf) and
     * keeps it when the session did not hold it, else zeroes it.
     */
    async function rewrapAtTarget(
        workspaceId: string,
        node: RotatingNodeKey,
        old: Uint8Array<ArrayBuffer>,
    ) {
        const cached = nodeKey(workspaceId, node.id);
        try {
            // What the key is rooted at: this device's own copy, or the envelope's path.
            const rootedAt =
                cached && cached.epoch === node.keyEpoch
                    ? (lineage.get(slot(workspaceId, node.id)) ?? null)
                    : parentKeyAndRoot(workspaceId, node.parentId, node.wrappedParentKeyEpoch)
                          .rootedAt;
            // In a group area, a key reached through one the rotation replaces is anyone's who
            // held that key: a removed member and the server can plant a node under a folder's
            // old key already at the target, and re-wrapping it would carry their key into the
            // new tree. Only a key rooted at the write version is carried. An honest walk never
            // needs more: the target is above every epoch a node carries, and the server
            // refuses nodes made or moved under a folder the walk has not reached.
            if (isArea(workspaceId) && !rootedNow(workspaceId, rootedAt))
                throw new CryptoError(NOT_CARRIED);
            const parentKey = wrapKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
            const keyEnvelope = await wrapNodeKey(old, parentKey, {
                workspaceId,
                nodeId: node.id,
                parentId: node.parentId,
                parentKeyEpoch: node.parentKeyEpoch,
                keyEpoch: node.keyEpoch,
            });
            // The same key, still, rooted where it was: never vouched for by this re-wrap.
            if (!cached) rememberNodeKey(workspaceId, node.id, old, node.keyEpoch, rootedAt);
            else old.fill(0);
            return keyEnvelope;
        } catch (error) {
            old.fill(0);
            throw error;
        }
    }
    /*
     * The parent key a walk's fresh key is wrapped under, and what it is
     * rooted at. A fresh key is a write like any other (F14): its parent is
     * pending in this walk or rooted at the write version, never a key reached
     * through a previous one, which a removed member may hold and would then
     * hold the fresh key under.
     */
    function freshKeyParent(workspaceId: string, node: RotatingNodeKey) {
        const key = wrapKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
        const { rootedAt } = parentKeyAndRoot(workspaceId, node.parentId, node.parentKeyEpoch);
        return { key, rootedAt };
    }
    /*
     * A walk's fresh key and the key it replaces, pending until the server
     * confirms the batch (commitPending): children in the walk wrap under the
     * fresh key meanwhile, and nothing else takes it as the node's.
     */
    function setPending(workspaceId: string, nodeId: string, pending: PendingKey) {
        const at = slot(workspaceId, nodeId);
        const before = pendingNodeKeys.get(at);
        if (before) zeroPending(before);
        pendingNodeKeys.set(at, pending);
    }
    /* The server took the batch: each node's fresh key is its own, the old one its previous. */
    function commitPending(workspaceId: string, nodeIds: string[]) {
        let count = 0;
        for (const nodeId of nodeIds) {
            const at = slot(workspaceId, nodeId);
            const pending = pendingNodeKeys.get(at);
            if (!pending) continue;
            pendingNodeKeys.delete(at);
            count++;
            rememberPrevNodeKey(workspaceId, nodeId, pending.old, pending.oldEpoch, true);
            // A fresh key: rooted where the parent it was wrapped under was (rotateOne).
            rememberNodeKey(workspaceId, nodeId, pending.fresh, pending.epoch, pending.rootedAt);
        }
        return count;
    }
    /* The server refused the batch: its fresh keys and the keys they replaced are dropped. */
    function dropPending(workspaceId: string, nodeIds: string[]) {
        let count = 0;
        for (const nodeId of nodeIds) {
            const at = slot(workspaceId, nodeId);
            const pending = pendingNodeKeys.get(at);
            if (!pending) continue;
            pendingNodeKeys.delete(at);
            count++;
            zeroPending(pending);
        }
        return count;
    }

    return {
        isArea,
        readVersion,
        writeVersion,
        unwritable,
        requireWritable,
        rootSeen,
        commitAreas,
        uncommitAreas,
        forgetAreas,
        forgetAllAreas,
        admitAreaKey,
        holdWorkspaceKey,
        workspaceKey,
        workspaceVersions,
        hasWorkspace,
        dropWorkspace,
        clear,
        nodeKey,
        prevNodeKey,
        forgetNodeKey,
        keyAtEpoch,
        refuseOwnWorkspace,
        parentKeyFor,
        parentKeyAndRoot,
        rootOf,
        writableNodeKey,
        writeVersionOf,
        wrapKeyFor,
        rememberNodeKey,
        rememberPrevNodeKey,
        openListedNode,
        newNodeKey,
        currentKeyOf,
        rotationOldKey,
        rewrapAtTarget,
        freshKeyParent,
        setPending,
        commitPending,
        dropPending,
    };
}

export type AreaLedger = ReturnType<typeof createAreaLedger>;
