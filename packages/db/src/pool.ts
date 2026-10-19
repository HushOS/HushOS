import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
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
 * member of a family, that family's plan is live (`expires_at` set and in the
 * future), and its owner has no personal plan still in force: a personal
 * subscriber who joins keeps their plan to the end of the period they paid
 * for, and their files stay on it until then (owner decision 2 of
 * 2026-10-19). Nothing else stacks on the pool while they are pooled: Free's
 * base, referral bonuses and operator grants stay in `storage_entitlements`
 * and count again once they aren't.
 */

type Conn = Tx | typeof db;

/* The source billing writes a personal plan's entitlement under (applyCustomerState's provider). */
export const PERSONAL_PLAN_SOURCE = 'polar';

/* Whether the personal workspace `workspaceId` (a column or value) has a personal plan in force now. */
function livePersonalPlan(workspaceId: SQL | string) {
    return sql`exists (select 1 from ${storageEntitlements} where ${storageEntitlements.workspaceId} = ${workspaceId} and ${storageEntitlements.source} = ${PERSONAL_PLAN_SOURCE} and ${storageEntitlements.revokedAt} is null and ${storageEntitlements.startsAt} <= now() and (${storageEntitlements.expiresAt} is null or ${storageEntitlements.expiresAt} > now()))`;
}

async function hasLivePersonalPlan(tx: Conn, workspaceId: string) {
    const result = await tx.execute<{ live: boolean }>(
        sql`select ${livePersonalPlan(workspaceId)} as live`,
    );
    return result.rows[0]?.live === true;
}

/*
 * The pool's usage: the used and reserved bytes of every workspace of the
 * family (a deleted family folder included until its purge deletes its files)
 * and of every pooled member's personal workspace (docs/families-shared-pool.md
 * 3.7). The one implementation. Each workspace is counted once by id, never
 * through `workspace_keys` or `area_grants` (one row per member per folder),
 * and only active memberships bring a personal workspace in, so someone who
 * left is not counted. Whether the plan is live doesn't matter here: a
 * family without one counts what would draw from it once it has one.
 */
export async function poolUsage(tx: Conn, groupId: string) {
    const result = await tx.execute<{ used: string; reserved: string }>(sql`
        select coalesce(sum(s.used_bytes), 0)::text as used,
               coalesce(sum(s.reserved_bytes), 0)::text as reserved
        from ${workspaceStorage} s
        where s.workspace_id in (
            select w.id from ${workspaces} w where w.group_id = ${groupId}
            union
            select p.workspace_id
            from ${personalWorkspaces} p
            join ${groupMemberships} m on m.user_id = p.user_id
            where m.group_id = ${groupId}
              and m.group_kind = 'family'
              and m.state = 'active'
              and not ${livePersonalPlan(sql`p.workspace_id`)}
        )
    `);
    const row = result.rows[0];
    return { used: BigInt(row?.used ?? '0'), reserved: BigInt(row?.reserved ?? '0') };
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
function planLive(pool: { expiresAt: Date | null }) {
    return pool.expiresAt !== null && pool.expiresAt.getTime() > Date.now();
}

async function readPool(tx: Conn, groupId: string, lock: boolean) {
    const query = tx
        .select({ quotaBytes: groupStorage.quotaBytes, expiresAt: groupStorage.expiresAt })
        .from(groupStorage)
        .where(eq(groupStorage.groupId, groupId));
    const [row] = lock ? await query.for('update') : await query;
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
): Promise<StorageFigures> {
    const grants = await tx
        .select({ quotaBytes: storageEntitlements.quotaBytes })
        .from(storageEntitlements)
        .where(
            and(
                eq(storageEntitlements.workspaceId, workspaceId),
                isNull(storageEntitlements.revokedAt),
                sql`${storageEntitlements.startsAt} <= now()`,
                sql`(${storageEntitlements.expiresAt} is null or ${storageEntitlements.expiresAt} > now())`,
            ),
        );
    const allowance = grants.reduce((sum, grant) => sum + grant.quotaBytes, own.baseQuotaBytes);
    return {
        allowance,
        used: own.usedBytes,
        reserved: own.reservedBytes,
        free: allowance - own.usedBytes - own.reservedBytes,
        pool: null,
    };
}

async function poolFigures(
    tx: Conn,
    groupId: string,
    pool: { quotaBytes: bigint; expiresAt: Date | null },
): Promise<StorageFigures> {
    const { used, reserved } = await poolUsage(tx, groupId);
    // Past the plan's period and grace (or before any plan), the pool is empty.
    const allowance = planLive(pool) ? pool.quotaBytes : 0n;
    return { allowance, used, reserved, free: allowance - used - reserved, pool: { groupId } };
}

export type StorageFigures = {
    allowance: bigint;
    used: bigint;
    reserved: bigint;
    free: bigint;
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
 * 2. lock the family's `group_storage` row;
 * 3. for a personal workspace, read the membership again: every membership
 *    change takes the same lock, so under it the membership is settled, and a
 *    change since step 1 throws PoolMovedError;
 * 4. lock the workspace's `workspace_storage` row (for a personal workspace
 *    that is in no family, then read the membership again: an admission locks
 *    the newcomer's row, so one that landed meanwhile is seen here);
 * 5. sum the pool (poolUsage) or the workspace's own allowance.
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
        // A group made before billing has no pool: its areas keep their own allowances.
        return pool ? poolFigures(tx, owner.groupId, pool) : ownFigures(tx, workspaceId, own);
    }
    if (billing && owner.userId) {
        const familyId = await activeFamilyId(tx, owner.userId);
        if (familyId) {
            const pool = await readPool(tx, familyId, lock);
            if (lock && (await activeFamilyId(tx, owner.userId)) !== familyId)
                throw new PoolMovedError();
            const own = await readOwn(tx, workspaceId, lock);
            if (!own) return null;
            if (pool && planLive(pool) && !(await hasLivePersonalPlan(tx, workspaceId)))
                return poolFigures(tx, familyId, pool);
            return ownFigures(tx, workspaceId, own);
        }
        const own = await readOwn(tx, workspaceId, lock);
        if (!own) return null;
        if (lock && (await activeFamilyId(tx, owner.userId)) !== null) throw new PoolMovedError();
        return ownFigures(tx, workspaceId, own);
    }
    const own = await readOwn(tx, workspaceId, lock);
    return own ? ownFigures(tx, workspaceId, own) : null;
}

/* The family a pool belongs to, by name, for the account's storage figures. */
export async function poolName(tx: Conn, groupId: string) {
    const [row] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId));
    return row?.name ?? null;
}

/*
 * Whether `userId`'s own files fit in the family's free space (3.2,
 * `pool-full`): their used and reserved bytes against the pool's quota less
 * its usage. Inside an admission's transaction, after the group's and areas'
 * locks and the pool row's (lockPool), the newcomer's storage row is locked
 * too, so an upload of theirs in flight is either counted here or, if it
 * starts later, finds them in the family (storageFigures, step 4). True when
 * nothing is pooled: billing off, or a family without a live plan, whose
 * admission pools nobody yet. A newcomer still on a personal plan is counted
 * all the same: their files join the pool when that plan ends.
 */
export async function admissionFits(
    tx: Conn,
    groupId: string,
    userId: string,
    options: { lock: boolean },
) {
    if (billingEnv.BILLING_PROVIDER === 'none') return true;
    const pool = await readPool(tx, groupId, options.lock);
    if (!pool || !planLive(pool)) return true;
    const [personal] = await tx
        .select({ workspaceId: personalWorkspaces.workspaceId })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.userId, userId));
    if (!personal) return true;
    const own = await readOwn(tx, personal.workspaceId, options.lock);
    if (!own) return true;
    const { used, reserved } = await poolUsage(tx, groupId);
    return own.usedBytes + own.reservedBytes <= pool.quotaBytes - used - reserved;
}

/*
 * The pool lock a membership change takes (3.6): after the group's row and its
 * areas, before any `workspace_storage` row, so an upload that resolved the
 * pool either finishes before the change or reads the membership after it.
 */
export async function lockPool(tx: Tx, groupId: string) {
    await tx
        .select({ groupId: groupStorage.groupId })
        .from(groupStorage)
        .where(eq(groupStorage.groupId, groupId))
        .for('update');
}
