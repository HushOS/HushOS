import { areaKeyCommitment } from './area-keys';
import { uuid } from './canonical';
import type { AcceptedRosters } from './group-trust';
import { areaWriteVersion, checkAreaRoot, sameGroupKey } from './groups';
import { CryptoError } from './errors';
import { checkId } from './ids';
import { decode } from './keys';
import { generateKey, openNodeKey, openPreviousRootKey, wrapNodeKey } from './drive';
import {
    GUARD_NOT_KEPT,
    KEY_CHANGE_PENDING,
    NOT_CARRIED,
    OLDER_CHAIN,
    SPLIT_CHAIN,
} from './protocol';

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
 * Nothing here talks to the server. The group session hands it every chain it
 * commits (`commit`, `uncommit`, `forgetGroup`) and every area key a grant
 * opened (`openArea`). Every piece of area state is kept per family and area:
 * an area is resolved only through the family it was opened under, its id
 * checked as derived under that family, so one family's member list never
 * moves another's area; another family listing it, or listing the account's
 * own workspace (`openPersonalWorkspace`), is ignored and only reported
 * (`foreignListings`).
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

export { OLDER_CHAIN, SPLIT_CHAIN };
const NO_CHAIN = 'Check the family’s member list first.';
const NOT_THE_FAMILYS = 'This folder does not belong to the family.';
const NOT_LISTED = 'This folder is not on the family’s member list.';
const ITEM_CHANGED = 'This item changed since it was opened. Refresh and retry.';
export const FAMILY_FOLDER = 'This was refused: it is a family folder.';

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

/*
 * Why `chain` may not be committed over `held` (a family's floor, or the
 * chain committed now), or null when it extends it: it must reach as far
 * (OLDER_CHAIN otherwise: a roster or a group key short of it) and pass
 * through it, its roster digest at the held roster version and its group key
 * at the held key version (SPLIT_CHAIN otherwise: another history beside it).
 * The roster alone is not enough: two successions to other keys at one
 * roster version leave the roster digest the same. The core's `overtaken_by`
 * is its twin.
 */
function overtakenBy(held: AcceptedRosters, chain: AcceptedRosters) {
    if (held.roster.rosterVersion > chain.roster.rosterVersion) return OLDER_CHAIN;
    if (chain.rosterDigests[held.roster.rosterVersion - 1] !== held.rosterDigest)
        return SPLIT_CHAIN;
    if (held.groupKeyVersion > chain.groupKeyVersion) return OLDER_CHAIN;
    const key = chain.groupKeys[held.groupKeyVersion - 1];
    if (!key || !sameGroupKey(key, held.groupKey)) return SPLIT_CHAIN;
    return null;
}

export function createAreaLedger() {
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
    /*
     * Committed chains by family, and the areas each family opened here (by a
     * grant whose area id checkId derived under that family), with the
     * highest version opened. What the group session committed and opened.
     */
    const chains = new Map<string, AcceptedRosters>();
    /*
     * Per family, the highest chain committed in this session: a refusal's
     * uncommit never drops it (only forgetting the family does), so no chain
     * below it, or beside it, is committed again (the core's `floors`).
     */
    const floors = new Map<string, AcceptedRosters>();
    const opened = new Map<string, Map<string, number>>();
    /* Each area's write version, from its own family's committed chain only (F9), by `${groupId}/${workspaceId}`. */
    const areaWrite = new Map<string, number>();
    /*
     * Areas the last openArea found unwritable, and why: the server behind or
     * ahead of the chain, or no grant at the latest version.
     */
    const blocked = new Map<string, AreaBlock>();
    /*
     * Families whose guard an acceptance handed back and this device has not
     * stored yet (docs/optional-verification.md 2.8): from the commit on,
     * nothing is written into their folders until the app says it is stored.
     * The chain stays committed (it is the floor, never given up), reading
     * goes on.
     */
    const guardOwed = new Set<string>();
    /* Refused for a family folder whose family owes its guard: every key handed out to write checks it. */
    function requireGuardKept(workspaceId: string) {
        if (openedBy(workspaceId).some((groupId) => guardOwed.has(groupId)))
            throw new CryptoError(GUARD_NOT_KEPT);
    }
    /*
     * The area key version each area's root was last opened under, by a real
     * open of its envelope in a listing (rootSeen): the area is written only
     * while that is its write version. Nothing a caller says sets it, and an
     * older root served again never lowers it.
     */
    const rootSeenAt = new Map<string, number>();
    /*
     * Each area's root node: the first top-level row, at the area's write
     * version, whose key the family's chain committed to.
     */
    const rootIds = new Map<string, string>();
    /*
     * The account's own personal workspaces (their grants opened under the
     * account root, a context no family's key opens under): never an area,
     * whatever a family's roster lists.
     */
    const personal = new Set<string>();

    const slot = (workspaceId: string, nodeId: string) => `${workspaceId}/${nodeId}`;
    const areaSlot = (groupId: string, workspaceId: string) => `${groupId}/${workspaceId}`;
    function zeroPending(pending: PendingKey) {
        pending.fresh.fill(0);
        pending.old.fill(0);
    }

    /* ---------------------------------------------------------------- */
    /* Group areas: which are, and the version each is written under     */
    /* ---------------------------------------------------------------- */

    /* The families that opened the area here (one, unless something is badly wrong). */
    function openedBy(workspaceId: string) {
        return [...opened]
            .filter(([, areas]) => areas.has(workspaceId))
            .map(([groupId]) => groupId);
    }
    /* How many committed chains list the area. */
    function listings(workspaceId: string) {
        let count = 0;
        for (const chain of chains.values())
            if (Object.hasOwn(chain.areaKeys, workspaceId)) count++;
        return count;
    }
    /*
     * The family an area is resolved through: the one it was opened under (its
     * id checked as derived under that family), whatever another family's
     * chain lists; another family's listing is only a warning
     * (`foreignListings`). An area no family opened resolves through none.
     */
    function familyOf(workspaceId: string): string | undefined {
        const families = openedBy(workspaceId);
        return families.length === 1 ? families[0] : undefined;
    }
    /*
     * A family folder whose family has no chain committed here now: a refusal
     * or a fork since it was opened (uncommit). None of its keys is handed out
     * or used, held or listed, until a chain is committed again; forgetting
     * the family drops them.
     */
    function heldBack(workspaceId: string) {
        return openedBy(workspaceId).some((groupId) => !chains.has(groupId));
    }
    /*
     * Committed chains listing an area another family opened here, or one of
     * the account's own workspaces: what a hostile family's roster names,
     * ignored for every decision and listed for the person to hear about.
     */
    function foreignListings() {
        const out: { groupId: string; workspaceId: string; openedBy: string | null }[] = [];
        for (const [groupId, chain] of chains)
            for (const workspaceId of Object.keys(chain.areaKeys)) {
                const families = openedBy(workspaceId);
                if (personal.has(workspaceId)) out.push({ groupId, workspaceId, openedBy: null });
                else if (families.length > 0 && !families.includes(groupId))
                    out.push({ groupId, workspaceId, openedBy: families[0]! });
            }
        return out.sort((a, b) =>
            `${a.groupId}/${a.workspaceId}`.localeCompare(`${b.groupId}/${b.workspaceId}`),
        );
    }
    /* Whether a family opened the workspace here as one of its folders (its id derived under it). */
    function openedByFamily(workspaceId: string) {
        return openedBy(workspaceId).length > 0;
    }
    /* The account's own workspace, its key at `version` opened from its grant: never an area. */
    function openPersonalWorkspace(
        workspaceId: string,
        version: number,
        key: Uint8Array<ArrayBuffer>,
    ) {
        // A family folder opened here (its id derived under its family) is never the account's own.
        if (openedByFamily(workspaceId)) throw new CryptoError(FAMILY_FOLDER);
        personal.add(workspaceId);
        holdWorkspaceKey(workspaceId, version, key);
    }
    function isArea(workspaceId: string) {
        if (personal.has(workspaceId)) return false;
        if (openedBy(workspaceId).length > 0 || listings(workspaceId) > 0) return true;
        const suffix = `/${workspaceId}`;
        for (const map of [areaWrite, blocked, rootSeenAt])
            for (const at of map.keys()) if (at.endsWith(suffix)) return true;
        return false;
    }
    /* The family and version a group area is read under, null for a workspace that is no group's area. */
    function readAt(workspaceId: string) {
        if (!isArea(workspaceId)) return null;
        const groupId = familyOf(workspaceId);
        if (groupId === undefined) throw new CryptoError(NOT_CHECKED_KEYS);
        const version = areaWrite.get(areaSlot(groupId, workspaceId));
        if (version === undefined) throw new CryptoError(NOT_CHECKED_KEYS);
        return { groupId, version };
    }
    /* The version a group area is read under (its write version), null for a workspace that is no group's area. */
    function readVersion(workspaceId: string): number | null {
        return readAt(workspaceId)?.version ?? null;
    }
    /* The version a group area is written under, null for a workspace that is no group's area. */
    function writeVersion(workspaceId: string): number | null {
        const at = readAt(workspaceId);
        if (at === null) return null;
        const key = areaSlot(at.groupId, workspaceId);
        if (blocked.has(key)) throw new CryptoError(KEYS_CHANGED);
        // Only once a root wrapped under this very version was opened here. A root seen under
        // an earlier version is a key change this device committed but has not listed yet (a
        // sync between its acceptance and its root listing): a wait, which the next listing
        // ends. No root seen at all, or one past the chain, is not.
        const seen = rootSeenAt.get(key);
        if (seen !== undefined && seen < at.version) throw new CryptoError(KEY_CHANGE_PENDING);
        if (seen !== at.version) throw new CryptoError(KEYS_CHANGED);
        return at.version;
    }
    /* Why an area may not be written, or null. */
    function unwritable(groupId: string, workspaceId: string, latest: number): AreaBlock | null {
        const key = areaSlot(groupId, workspaceId);
        const reason = blocked.get(key);
        if (reason) return reason;
        const seen = rootSeenAt.get(key);
        return seen === latest ? null : seen === undefined ? 'root-unknown' : 'root-behind';
    }
    /*
     * Refuses any write into a group area the worker has not found writable:
     * blocked, not opened under a family with a committed chain, or without
     * the key at the write version (F9).
     * Every Drive write in the session calls it.
     */
    function requireWritable(workspaceId: string) {
        requireGuardKept(workspaceId);
        const version = writeVersion(workspaceId);
        if (version !== null && !workspaceKeys.get(workspaceId)?.keys.get(version))
            throw new CryptoError(KEYS_CHANGED);
    }
    /*
     * An area root a listing has just opened, its envelope opened under the
     * area key at `parentKeyEpoch` (never a cached key the row only claims):
     * the area is writable only while that is its write version, and only
     * when its family's committed chain committed to this root key at that
     * version (design 2.10, F14; a version a format 1 roster listed keeps the
     * envelope rule). False when the key is not the committed one: the caller
     * drops it, and the root reads as couldn't-check. A root served at an
     * older version that does hold never lowers what was seen.
     */
    async function rootSeen(
        workspaceId: string,
        nodeId: string,
        parentKeyEpoch: number,
        rootKey: Uint8Array,
    ) {
        if (!isArea(workspaceId)) return true;
        const groupId = familyOf(workspaceId);
        const chain = groupId === undefined ? undefined : chains.get(groupId);
        // Without its family's committed chain nothing says which root is current: no write until one.
        if (groupId === undefined || !chain) return true;
        const key = areaSlot(groupId, workspaceId);
        try {
            await checkAreaRoot(chain, workspaceId, parentKeyEpoch, rootKey);
        } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
            // A root refused at the version seen, or at the write version itself, leaves no root
            // seen: the area reads as a key change that went wrong (KEYS_CHANGED), not one still
            // on its way, until a committed root at the write version opens.
            if (rootSeenAt.get(key) === parentKeyEpoch || areaWrite.get(key) === parentKeyEpoch)
                rootSeenAt.delete(key);
            return false;
        }
        const seen = rootSeenAt.get(key);
        if (seen === undefined || seen < parentKeyEpoch) rootSeenAt.set(key, parentKeyEpoch);
        // Only a root at the area's write version names the root node: an older top-level row
        // (one a removed member holding an old area key could plant) never wins it.
        if (!rootIds.has(key) && parentKeyEpoch === areaWrite.get(key)) rootIds.set(key, nodeId);
        return true;
    }
    /* Whether a top-level row is another node than the root this family's area already has. */
    function notTheRoot(workspaceId: string, nodeId: string) {
        const groupId = familyOf(workspaceId);
        if (groupId === undefined) return false;
        const root = rootIds.get(areaSlot(groupId, workspaceId));
        return root !== undefined && root !== nodeId;
    }
    /*
     * Refused (OLDER_CHAIN, SPLIT_CHAIN) unless `chain` passes through the
     * family's floor and the chain committed now (overtakenBy), checked again
     * at commit: an acceptance verified against an earlier floor that another
     * moved meanwhile (to another group key at the same roster, say) commits
     * nothing beside it. Throws before anything changes.
     */
    function checkCommit(chain: AcceptedRosters) {
        for (const held of [floors.get(chain.groupId), chains.get(chain.groupId)]) {
            const refusal = held && overtakenBy(held, chain);
            if (refusal) throw new CryptoError(refusal);
        }
    }
    /*
     * A family's chain, accepted from what the server served (never a staged
     * one): its areas are written under the versions it lists. An older chain
     * than the one held is refused (a background acceptance that lost a race
     * with the foreground's), and so is one beside it (checkCommit). A new
     * write version needs its root seen again;
     * a retired area (a deleted family folder, design 2.10) is written no more.
     */
    function commit(chain: AcceptedRosters) {
        checkCommit(chain);
        const floor = floors.get(chain.groupId);
        chains.set(chain.groupId, chain);
        // The floor moves to a later roster, or to a later group key at the same roster (a
        // succession the roster that dropped a holder ties to itself, served after it).
        if (
            !floor ||
            floor.roster.rosterVersion < chain.roster.rosterVersion ||
            (floor.roster.rosterVersion === chain.roster.rosterVersion &&
                floor.groupKeyVersion < chain.groupKeyVersion)
        )
            floors.set(chain.groupId, chain);
        for (const workspaceId of Object.keys(chain.areaKeys)) {
            const key = areaSlot(chain.groupId, workspaceId);
            const version = areaWriteVersion(chain, workspaceId);
            if (version === null) {
                areaWrite.delete(key);
                rootSeenAt.delete(key);
            } else areaWrite.set(key, version);
        }
    }
    /* A refusal or a fork for the family: none of its areas is written, and none of their keys opens (heldBack), until a chain is committed again. */
    function uncommit(groupId: string) {
        for (const key of areaWrite.keys())
            if (key.startsWith(`${groupId}/`)) areaWrite.delete(key);
        chains.delete(groupId);
    }
    /* Writes into the family wait for its guard to be stored (owe), or go on again (kept). */
    function owe(groupId: string) {
        guardOwed.add(groupId);
    }
    function kept(groupId: string) {
        guardOwed.delete(groupId);
    }
    function owes(groupId: string) {
        return guardOwed.has(groupId);
    }
    /* A family the person no longer reads: the keys of the areas it opened, and all it knew of them. */
    function forgetGroup(groupId: string) {
        guardOwed.delete(groupId);
        for (const workspaceId of opened.get(groupId)?.keys() ?? []) dropWorkspace(workspaceId);
        for (const map of [areaWrite, blocked, rootSeenAt, rootIds])
            for (const key of map.keys()) if (key.startsWith(`${groupId}/`)) map.delete(key);
        opened.delete(groupId);
        chains.delete(groupId);
        floors.delete(groupId);
    }
    /* Every family: what forgetting every group drops. */
    function forgetAllGroups() {
        guardOwed.clear();
        for (const groupId of new Set([...chains.keys(), ...opened.keys(), ...floors.keys()]))
            forgetGroup(groupId);
    }
    /* The highest chain committed for the family this session: acceptance's floor and mark. */
    function floor(groupId: string) {
        return floors.get(groupId);
    }
    /* The chain committed for the family now, if any (none after a refusal or a fork). */
    function committedChain(groupId: string) {
        return chains.get(groupId);
    }
    /*
     * An area key a grant (or self-grant) opened at `version`, with the
     * version the server reports (`served`). Refused unless the family's chain
     * is committed here, the area's id is derived under the family from
     * `idSeed`, and the chain lists this key's commitment at that version.
     * Then held, and the area blocked while it is behind the chain or either
     * side disagrees; writable only once a root at the latest version is seen.
     */
    async function openArea(
        groupId: string,
        workspaceId: string,
        idSeed: string,
        version: number,
        key: Uint8Array<ArrayBuffer>,
        served: number,
    ): Promise<AreaBlock | null> {
        uuid(groupId, 'group id');
        const chain = chains.get(groupId);
        if (!chain) throw new CryptoError(NO_CHAIN);
        uuid(workspaceId, 'workspace id');
        if (personal.has(workspaceId)) throw new CryptoError(NOT_THE_FAMILYS);
        try {
            await checkId('workspace', groupId, idSeed, workspaceId);
        } catch {
            throw new CryptoError(NOT_THE_FAMILYS);
        }
        const latest = areaWriteVersion(chain, workspaceId);
        if (latest === null) throw new CryptoError(NOT_LISTED);
        const listed = chain.areaKeys[workspaceId] ?? [];
        if (version < 1 || listed[version - 1] !== (await areaKeyCommitment(key)))
            throw new CryptoError(NOT_CHECKED_KEYS);
        const areas = opened.get(groupId) ?? new Map<string, number>();
        areas.set(workspaceId, Math.max(areas.get(workspaceId) ?? 0, version));
        opened.set(groupId, areas);
        const reason: AreaBlock | null =
            version < latest
                ? 'no-grant-at-latest'
                : served < latest
                  ? 'server-behind'
                  : served > latest
                    ? 'server-ahead'
                    : null;
        holdWorkspaceKey(workspaceId, version, key);
        const at = areaSlot(groupId, workspaceId);
        if (reason) blocked.set(at, reason);
        else blocked.delete(at);
        // The root is the listing's to decide (rootSeen): until one is opened at the latest
        // version, the area reads 'root-unknown' (or 'root-behind') and is not written.
        return unwritable(groupId, workspaceId, latest);
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
        personal.clear();
    }
    function nodeKeysOf(workspaceId: string) {
        return workspaceKeys.has(workspaceId) ? ownNodeKeys : guestNodeKeys;
    }
    function prevNodeKeysOf(workspaceId: string) {
        return workspaceKeys.has(workspaceId) ? ownPrevNodeKeys : guestPrevNodeKeys;
    }
    function nodeKey(workspaceId: string, nodeId: string) {
        if (heldBack(workspaceId)) return undefined;
        return nodeKeysOf(workspaceId).get(slot(workspaceId, nodeId));
    }
    /* The previous key held for a node (and whether this device opened it itself). */
    function prevNodeKey(workspaceId: string, nodeId: string) {
        if (heldBack(workspaceId)) return undefined;
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
        // Through the held-back gates of nodeKey and prevNodeKey.
        const current = nodeKey(workspaceId, nodeId);
        if (current?.epoch === epoch) return current.key;
        const previous = prevNodeKey(workspaceId, nodeId);
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
        // Reached only behind a held-back gate: openListedNode's, or requireWritable's for writes.
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
        if (heldBack(workspaceId)) throw new CryptoError(NO_CHAIN);
        requireGuardKept(workspaceId);
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
        requireGuardKept(workspaceId);
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
        requireGuardKept(workspaceId);
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
        if (heldBack(workspaceId)) throw new CryptoError(NO_CHAIN);
        const cached = nodeKey(workspaceId, node.id);
        const at = slot(workspaceId, node.id);
        // A group area's root is taken from the cache only under the area key
        // version it was opened under: a row that names another is opened again.
        const areaRoot = node.parentId === workspaceId && isArea(workspaceId);
        // Another top-level node than the area's root: nothing in Drive goes there (wrapKeyFor),
        // so it is planted, and it decides nothing about the area.
        if (areaRoot && notTheRoot(workspaceId, node.id)) throw new CryptoError(NOT_COMMITTED_ROOT);
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
            // Uncommitted while the envelope opened: neither kept nor handed out.
            if (heldBack(workspaceId)) {
                key.fill(0);
                heldPrevious?.fill(0);
                throw new CryptoError(NO_CHAIN);
            }
            rememberNodeKey(workspaceId, node.id, key, node.keyEpoch, rootedAt);
            if (areaRoot) rootOpenedUnder.set(at, node.parentKeyEpoch);
        }
        // A group area's root decides whether the area may be written: only one
        // whose envelope opened under the area's write version (a withheld root
        // rotation's does not, nor does option A's previous-root envelope), and
        // whose key is the one the roster committed to at that version (design
        // 2.10: a root rolled back under the same area key is not current).
        if (areaRoot && !(await rootSeen(workspaceId, node.id, node.parentKeyEpoch, key))) {
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
        // Uncommitted during the awaits above (the root's check, the previous key): not handed out.
        if (heldBack(workspaceId)) throw new CryptoError(NO_CHAIN);
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
    /*
     * One node of a walk to `targetEpoch` (rotateOne's key half): a node
     * already at the target is re-wrapped, only if its key is rooted at the
     * write version (NOT_CARRIED); any other gets a fresh key under a parent
     * the rules allow, handed to `rekey` with the key it replaces to re-key
     * the node's records, and pending (until commitPending) only once `rekey`
     * succeeded. A family folder's top level is never a walk's (AREA_ROOT).
     * The re-wrap branch returns a copy of the node's key, the caller's to zero.
     */
    async function rotateKey<T>(
        workspaceId: string,
        node: RotatingNodeKey,
        targetEpoch: number,
        rekey: (keys: { old: Uint8Array; fresh: Uint8Array; parentKey: Uint8Array }) => Promise<T>,
    ): Promise<
        | { rewrap: true; keyEnvelope: Uint8Array; key: Uint8Array<ArrayBuffer> }
        | { rewrap: false; result: T }
    > {
        requireWritable(workspaceId);
        const old = await rotationOldKey(workspaceId, node);
        // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
        if (node.keyEpoch >= targetEpoch) {
            const key = old.slice();
            try {
                return {
                    rewrap: true,
                    keyEnvelope: await rewrapAtTarget(workspaceId, node, old),
                    key,
                };
            } catch (error) {
                key.fill(0);
                throw error;
            }
        }
        // A second walk of the node to the same target while the first is pending: the first's fresh
        // key would be replaced under children already wrapped under it.
        if (pendingNodeKeys.get(slot(workspaceId, node.id))?.epoch === targetEpoch) {
            old.fill(0);
            throw new CryptoError(ITEM_CHANGED);
        }
        const fresh = generateKey();
        try {
            const parent = freshKeyParent(workspaceId, node);
            const result = await rekey({ old, fresh, parentKey: parent.key });
            setPending(workspaceId, node.id, {
                fresh,
                epoch: targetEpoch,
                old,
                oldEpoch: node.keyEpoch,
                rootedAt: parent.rootedAt,
            });
            return { rewrap: false, result };
        } catch (error) {
            fresh.fill(0);
            old.fill(0);
            throw error;
        }
    }
    /*
     * A move (driveRewrapNode): the node's key, at `keyEpoch` as opened and
     * writable, wrapped under its new parent by the write rules.
     */
    async function rewrapNode(
        workspaceId: string,
        node: { id: string; parentId: string; parentKeyEpoch: number; keyEpoch: number },
    ) {
        requireWritable(workspaceId);
        const entry = writableNodeKey(workspaceId, node.id);
        if (!entry) throw new CryptoError('Open the containing folder first.');
        if (entry.epoch !== node.keyEpoch) throw new CryptoError(ITEM_CHANGED);
        const parentKey = wrapKeyFor(workspaceId, node.parentId, node.parentKeyEpoch);
        return wrapNodeKey(entry.key, parentKey, {
            workspaceId,
            nodeId: node.id,
            parentId: node.parentId,
            parentKeyEpoch: node.parentKeyEpoch,
            keyEpoch: node.keyEpoch,
        });
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
    /* A walk abandoned (or a batch whose node list was lost): every fresh key pending in the workspace, dropped. */
    function dropAllPending(workspaceId: string) {
        let count = 0;
        for (const [at, pending] of pendingNodeKeys)
            if (at.startsWith(`${workspaceId}/`)) {
                pendingNodeKeys.delete(at);
                zeroPending(pending);
                count++;
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
        familyOf,
        readVersion,
        writeVersion,
        unwritable,
        requireWritable,
        owe,
        kept,
        owes,
        rootSeen,
        commit,
        checkCommit,
        uncommit,
        floor,
        committedChain,
        forgetGroup,
        forgetAllGroups,
        openArea,
        holdWorkspaceKey,
        workspaceKey,
        workspaceVersions,
        hasWorkspace,
        dropWorkspace,
        clear,
        openPersonalWorkspace,
        openedByFamily,
        foreignListings,
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
        rotateKey,
        rewrapNode,
        commitPending,
        dropPending,
        dropAllPending,
    };
}

export type AreaLedger = ReturnType<typeof createAreaLedger>;
