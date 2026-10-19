import { and, eq, isNull, sql } from 'drizzle-orm';
import { billingEnv } from '@hushos/env/billing';
import type { db } from './client';
import type { Tx } from './drive';
import {
    groupMemberships,
    groupStorage,
    groups,
    personalWorkspaces,
    storageEntitlements,
    workspaceStorage,
    workspaces,
} from './schema';

/*
 * A family's one storage pool (docs/families-shared-pool.md 3): what draws
 * from it, how much it holds, and what any workspace may still take. Drive's
 * free-space check (`freeBytes`), the account's storage figures
 * (`getStorageAllowance`, which `/api/auth/storage` and the phones read) and
 * the family's billing summary all come through here, so the three can never
 * disagree.
 *
 * A personal workspace is pooled when billing is on, its owner is an active
 * member of a family, and that family's plan is live (`expires_at` set and in
 * the future), whether or not they pay for a personal plan: a personal
 * subscriber let in draws from the pool at once, and billing ends their plan
 * with a prorated refund (owner decision 2, docs/families-shared-pool.md 5.1).
 * Nothing stacks on the pool while they are pooled: Free's base, a personal
 * plan not yet ended, referral bonuses and operator grants stay in
 * `storage_entitlements` and count again once they aren't.
 */

type Conn = Tx | typeof db;

/*
 * Every time rule here (a family plan's expiry, a grant's)
 * is judged at one instant, `at`, the app's clock read once the locks are
 * held: never the database's `now()`, which is the transaction's start and so
 * frozen from before it queued on the pool lock.
 */
const instant = (at: Date) => sql`${at.toISOString()}::timestamptz`;

/*
 * The pool lock (3.6): a transaction-scoped advisory lock keyed by the family,
 * taken where the `group_storage` row is locked and in its place in the lock
 * order. It exists whether or not the row does, so a group made before billing
 * (no row yet) still serialises its first plan's write (applyGroupState)
 * against uploads that read "no pool". A hash collision only serialises two
 * pools more than needed.
 */
const POOL_LOCK_SPACE = 0x706f6f6c;
export async function takePoolLock(tx: Tx, groupId: string) {
    await tx.execute(
        sql`select pg_advisory_xact_lock(${POOL_LOCK_SPACE}::int, hashtext(${groupId}))`,
    );
}

export const GIB = 1n << 30n;

/* Bytes rounded up to a whole GiB (an amount to free, a total shown). */
export function wholeGibUp(bytes: bigint) {
    return bytes <= 0n ? 0n : ((bytes + GIB - 1n) / GIB) * GIB;
}

/*
 * How a pool counts what it holds (3.6 step 5, 3.9): in parts, the family folders
 * together and each pooled member's own files, each rounded up to a whole GiB on
 * its own, and summed. Every check against the pool (an upload or copy, pool-full,
 * the downgrade and first-purchase guards) and every figure shown reads it, never
 * the exact total. Tier quotas are whole GiB, so a rounded total would change at
 * exactly the byte the exact one does: a member adding single bytes to their own
 * files could watch it change and learn the others' usage to the byte, modulo a
 * GiB. Counted part by part, another member's files move any figure only when
 * they cross a whole GiB, which managers already see (3.9). It costs up to a GiB
 * of the pool per part (each member, and the folders).
 */
export type PoolPart = { workspaceId: string | null; used: bigint; reserved: bigint };

/* A part as the pool counts it: its used and reserved bytes together, rounded up to a whole GiB. */
const counted = (part: { used: bigint; reserved: bigint }, reserved: boolean) =>
    wholeGibUp(part.used + (reserved ? part.reserved : 0n));

/*
 * The pool's usage: the used and reserved bytes of every workspace of the
 * family (a deleted family folder included until its purge deletes its files)
 * and of every pooled member's personal workspace (docs/families-shared-pool.md
 * 3.7). The one implementation. Each workspace is counted once by id, never
 * through `workspace_keys` or `area_grants` (one row per member per folder),
 * and only active memberships bring a personal workspace in, so someone who
 * left is not counted, while a member who pays for a personal plan is. Whether
 * the plan is live doesn't matter here: a
 * family without one counts what would draw from it once it has one.
 */
export async function poolUsage(tx: Conn, groupId: string) {
    const parts = await poolParts(tx, groupId);
    return {
        used: parts.reduce((sum, part) => sum + part.used, 0n),
        reserved: parts.reduce((sum, part) => sum + part.reserved, 0n),
        // What the pool counts as stored, part by part (see PoolPart): the figure shown and
        // the one the downgrade and first-purchase guards compare.
        counted: parts.reduce((sum, part) => sum + counted(part, false), 0n),
        // The same with uploads in flight, as every reservation and pool-full count it.
        countedReserved: parts.reduce((sum, part) => sum + counted(part, true), 0n),
        parts,
    };
}

/*
 * The pool's parts (PoolPart): the family folders together (`workspaceId` null), a
 * deleted one included until its purge, and each active member's own workspace.
 */
async function poolParts(tx: Conn, groupId: string): Promise<PoolPart[]> {
    const result = await tx.execute<{
        workspace_id: string | null;
        used: string;
        reserved: string;
    }>(sql`
        select null::uuid as workspace_id,
               coalesce(sum(s.used_bytes), 0)::text as used,
               coalesce(sum(s.reserved_bytes), 0)::text as reserved
        from ${workspaceStorage} s
        join ${workspaces} w on w.id = s.workspace_id
        where w.group_id = ${groupId}
        union all
        select s.workspace_id, s.used_bytes::text, s.reserved_bytes::text
        from ${personalWorkspaces} p
        join ${groupMemberships} m on m.user_id = p.user_id
        join ${workspaceStorage} s on s.workspace_id = p.workspace_id
        where m.group_id = ${groupId}
          and m.group_kind = 'family'
          and m.state = 'active'
    `);
    return result.rows.map((row) => ({
        workspaceId: row.workspace_id,
        used: BigInt(row.used),
        reserved: BigInt(row.reserved),
    }));
}

/* The family `userId` is an active member of (one at most, group_memberships_one_family_idx). */
async function activeFamilyId(tx: Conn, userId: string) {
    const [row] = await tx
        .select({ groupId: groupMemberships.groupId })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.userId, userId),
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
            ),
        )
        .limit(1);
    return row?.groupId ?? null;
}

/* A plan is live from billing's write until its period end plus the grace days (3.1). */
function planLive(pool: { expiresAt: Date | null }, at: Date) {
    return pool.expiresAt !== null && pool.expiresAt.getTime() > at.getTime();
}

async function readPool(tx: Conn, groupId: string, lock: boolean) {
    const query = tx
        .select({ quotaBytes: groupStorage.quotaBytes, expiresAt: groupStorage.expiresAt })
        .from(groupStorage)
        .where(eq(groupStorage.groupId, groupId));
    if (!lock) return (await query)[0] ?? null;
    await takePoolLock(tx as Tx, groupId);
    const [row] = await query.for('update');
    return row ?? null;
}

async function readOwn(tx: Conn, workspaceId: string, lock: boolean) {
    const query = tx
        .select({
            baseQuotaBytes: workspaceStorage.baseQuotaBytes,
            usedBytes: workspaceStorage.usedBytes,
            reservedBytes: workspaceStorage.reservedBytes,
        })
        .from(workspaceStorage)
        .where(eq(workspaceStorage.workspaceId, workspaceId));
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
}

/* A workspace's own allowance: its base plus every grant in force now. */
async function ownFigures(
    tx: Conn,
    workspaceId: string,
    own: { baseQuotaBytes: bigint; usedBytes: bigint; reservedBytes: bigint },
    at: Date,
): Promise<StorageFigures> {
    const grants = await tx
        .select({ quotaBytes: storageEntitlements.quotaBytes })
        .from(storageEntitlements)
        .where(
            and(
                eq(storageEntitlements.workspaceId, workspaceId),
                isNull(storageEntitlements.revokedAt),
                sql`${storageEntitlements.startsAt} <= ${instant(at)}`,
                sql`(${storageEntitlements.expiresAt} is null or ${storageEntitlements.expiresAt} > ${instant(at)})`,
            ),
        );
    const allowance = grants.reduce((sum, grant) => sum + grant.quotaBytes, own.baseQuotaBytes);
    return {
        allowance,
        used: own.usedBytes,
        reserved: own.reservedBytes,
        free: allowance - own.usedBytes - own.reservedBytes,
        shown: null,
        pool: null,
    };
}

/*
 * The pool's figures for one of its workspaces. `free` is what that workspace may
 * still take: the pool less every other part as it counts (whole GiB, uploads in
 * flight included) less this part's own bytes, exact for a member's own files
 * (known to whoever writes there) and in whole GiB for the family folders (whose
 * bytes are every member's). The others' move it only a GiB at a time. `shown` is what
 * a member reads: what is stored, counted part by part, and what is free with
 * uploads in flight counted the same way, so an upload moves either figure only
 * when its part crosses a whole GiB.
 */
async function poolFigures(
    tx: Conn,
    groupId: string,
    workspace: { id: string; isArea: boolean },
    pool: { quotaBytes: bigint; expiresAt: Date | null },
    at: Date,
): Promise<StorageFigures> {
    const usage = await poolUsage(tx, groupId);
    // Past the plan's period and grace (or before any plan), the pool is empty.
    const allowance = planLive(pool, at) ? pool.quotaBytes : 0n;
    const own = usage.parts.find((part) =>
        workspace.isArea ? part.workspaceId === null : part.workspaceId === workspace.id,
    ) ?? { used: 0n, reserved: 0n };
    const others = usage.countedReserved - counted(own, true);
    // A family folder's part is everyone's uploads, not the writer's own: counted in whole
    // GiB too, so a refusal's `free` doesn't give away the folders' exact total, others'
    // uploads in flight included. Up to a GiB of the folders' room is the price.
    const mine = workspace.isArea ? counted(own, true) : own.used + own.reserved;
    return {
        allowance,
        used: usage.used,
        reserved: usage.reserved,
        free: allowance - others - mine,
        shown: { used: usage.counted, free: allowance - usage.countedReserved },
        pool: { groupId },
    };
}

export type StorageFigures = {
    allowance: bigint;
    used: bigint;
    reserved: bigint;
    free: bigint;
    /* A pool's figures as its members read them (poolFigures); null for an own allowance. */
    shown: { used: bigint; free: bigint } | null;
    /* The family whose pool these figures are, or null for the workspace's own allowance. */
    pool: { groupId: string } | null;
};

/*
 * Thrown when a personal workspace's owner joined or left a family between
 * resolving the pool and holding its lock (3.6 step 3): the caller's whole
 * transaction is rolled back and started over (settlingPool).
 */
export class PoolMovedError extends Error {
    constructor() {
        super('The storage pool changed during the check.');
        this.name = 'PoolMovedError';
    }
}

/*
 * Runs `work`, a whole transaction that checks free space, and starts it over
 * when the pool moved under it (PoolMovedError), at most twice. A third move
 * is thrown: the route answers 503 and the client tries again. A move needs a
 * membership change of the workspace's owner, so two in a row are rare.
 */
export async function settlingPool<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof PoolMovedError) || attempt >= 3) throw error;
        }
    }
}

/*
 * What a workspace may still take, from its own allowance or its family's pool.
 *
 * With `lock`, inside the transaction that will reserve the bytes, in the
 * order every check against a pool takes (3.6), after the caller locked the
 * workspace's row (nextChangeSeq):
 *
 * 1. resolve the pool: a family folder's own family, or for a personal
 *    workspace its owner's active family membership (live plan or not, so a
 *    plan going live, which billing writes under this lock, cannot slip past);
 * 2. take the family's pool lock (takePoolLock) and its `group_storage` row;
 * 3. for a personal workspace, read the membership again: every membership
 *    change takes the same lock, so under it the membership is settled, and a
 *    change since step 1 throws PoolMovedError;
 * 4. lock the workspace's `workspace_storage` row (for a personal workspace
 *    that is in no family, then read the membership again: an admission locks
 *    the newcomer's row, so one that landed meanwhile is seen here);
 * 5. read the clock once (every time rule below is judged then) and sum the
 *    pool (poolUsage) or the workspace's own allowance.
 *
 * Without `lock`, the same figures read once, for display.
 */
export async function storageFigures(
    tx: Conn,
    workspaceId: string,
    options: { lock: boolean },
): Promise<StorageFigures | null> {
    const { lock } = options;
    const [owner] = await tx
        .select({ groupId: workspaces.groupId, userId: personalWorkspaces.userId })
        .from(workspaces)
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.workspaceId, workspaces.id))
        .where(eq(workspaces.id, workspaceId));
    if (!owner) return null;
    // A pool is billing's; with BILLING_PROVIDER=none every workspace keeps its own allowance.
    const billing = billingEnv.BILLING_PROVIDER !== 'none';
    if (billing && owner.groupId) {
        const pool = await readPool(tx, owner.groupId, lock);
        const own = await readOwn(tx, workspaceId, lock);
        if (!own) return null;
        const at = new Date();
        // A group made before billing has no pool: its areas keep their own allowances.
        return pool
            ? poolFigures(tx, owner.groupId, { id: workspaceId, isArea: true }, pool, at)
            : ownFigures(tx, workspaceId, own, at);
    }
    if (billing && owner.userId) {
        const familyId = await activeFamilyId(tx, owner.userId);
        if (familyId) {
            const pool = await readPool(tx, familyId, lock);
            if (lock && (await activeFamilyId(tx, owner.userId)) !== familyId)
                throw new PoolMovedError();
            const own = await readOwn(tx, workspaceId, lock);
            if (!own) return null;
            const at = new Date();
            if (pool && planLive(pool, at))
                return poolFigures(tx, familyId, { id: workspaceId, isArea: false }, pool, at);
            return ownFigures(tx, workspaceId, own, at);
        }
        const own = await readOwn(tx, workspaceId, lock);
        if (!own) return null;
        if (lock && (await activeFamilyId(tx, owner.userId)) !== null) throw new PoolMovedError();
        return ownFigures(tx, workspaceId, own, new Date());
    }
    const own = await readOwn(tx, workspaceId, lock);
    return own ? ownFigures(tx, workspaceId, own, new Date()) : null;
}

/* The family a pool belongs to, by name, for the account's storage figures. */
export async function poolName(tx: Conn, groupId: string) {
    const [row] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId));
    return row?.name ?? null;
}

/*
 * Whether `userId`'s own files fit in the family's free space (3.2,
 * `pool-full`): their used and reserved bytes, rounded up to a whole GiB, beside
 * the pool's parts as it counts them (PoolPart), against its quota. Inside an admission's transaction, after the group's and areas'
 * locks and the pool row's (lockPool), the newcomer's storage row is locked
 * too, so an upload of theirs in flight is either counted here or, if it
 * starts later, finds them in the family (storageFigures, step 4). True when
 * nothing is pooled: billing off, or a family without a live plan, whose
 * admission pools nobody yet. A newcomer who pays for a personal plan is
 * counted like anyone else: they draw from the pool from the moment they're in.
 */
export async function admissionFits(
    tx: Conn,
    groupId: string,
    userId: string,
    options: { lock: boolean },
) {
    if (billingEnv.BILLING_PROVIDER === 'none') return true;
    const pool = await readPool(tx, groupId, options.lock);
    if (!pool) return true;
    const [personal] = await tx
        .select({ workspaceId: personalWorkspaces.workspaceId })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.userId, userId));
    if (!personal) return true;
    const own = await readOwn(tx, personal.workspaceId, options.lock);
    if (!own) return true;
    const at = new Date();
    if (!planLive(pool, at)) return true;
    // As the pool will count them once they're in: their files rounded up to a whole GiB on
    // their own, beside every part already in it, uploads in flight included (PoolPart).
    const { countedReserved } = await poolUsage(tx, groupId);
    return (
        countedReserved + counted({ used: own.usedBytes, reserved: own.reservedBytes }, true) <=
        pool.quotaBytes
    );
}

/*
 * The pool lock a membership change takes (3.6): after the group's row and its
 * areas, before any `workspace_storage` row, so an upload that resolved the
 * pool either finishes before the change or reads the membership after it.
 */
export async function lockPool(tx: Tx, groupId: string) {
    await takePoolLock(tx, groupId);
    await tx
        .select({ groupId: groupStorage.groupId })
        .from(groupStorage)
        .where(eq(groupStorage.groupId, groupId))
        .for('update');
}

/*
 * The family whose pool `userId`'s own files draw from right now, or null: billing on, an
 * active family membership, and that family's plan live (3.1). With the family's name and
 * the membership's admission time, which name the membership a personal plan's ending is
 * keyed to (docs/families-shared-pool.md 5.1).
 */
export async function pooledFamilyOf(tx: Conn, userId: string, at = new Date()) {
    if (billingEnv.BILLING_PROVIDER === 'none') return null;
    const [row] = await tx
        .select({
            groupId: groupMemberships.groupId,
            admittedAt: groupMemberships.admittedAt,
            name: groups.name,
            expiresAt: groupStorage.expiresAt,
        })
        .from(groupMemberships)
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .innerJoin(groupStorage, eq(groupStorage.groupId, groupMemberships.groupId))
        .where(
            and(
                eq(groupMemberships.userId, userId),
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
            ),
        )
        .limit(1);
    if (!row || !row.admittedAt || !planLive(row, at)) return null;
    return { groupId: row.groupId, name: row.name, admittedAt: row.admittedAt };
}

/*
 * Each active member's own files (their personal workspace's stored bytes: My files with its
 * Trash and older versions), and the family folders' total, for the family's managers (3.9).
 * Exact here; billing rounds them before anything leaves the server.
 */
export async function memberUsage(tx: Conn, groupId: string) {
    const members = await tx
        .select({ userId: groupMemberships.userId, usedBytes: workspaceStorage.usedBytes })
        .from(groupMemberships)
        .innerJoin(personalWorkspaces, eq(personalWorkspaces.userId, groupMemberships.userId))
        .innerJoin(
            workspaceStorage,
            eq(workspaceStorage.workspaceId, personalWorkspaces.workspaceId),
        )
        .where(
            and(
                eq(groupMemberships.groupId, groupId),
                eq(groupMemberships.groupKind, 'family'),
                eq(groupMemberships.state, 'active'),
            ),
        );
    const folders = await tx.execute<{ used: string }>(sql`
        select coalesce(sum(s.used_bytes), 0)::text as used
        from ${workspaceStorage} s
        join ${workspaces} w on w.id = s.workspace_id
        where w.group_id = ${groupId}
    `);
    return { members, foldersBytes: BigInt(folders.rows[0]?.used ?? '0') };
}
