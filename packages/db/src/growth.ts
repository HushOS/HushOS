import { and, count, desc, eq, isNull, ne, or, sql, sum } from 'drizzle-orm';
import { db } from './client';
import {
    accountIntents,
    affiliateEarnings,
    affiliates,
    personalWorkspaces,
    referralCodes,
    referralRewards,
    referrals,
    storageEntitlements,
    users,
} from './schema';

/*
 * Referrals and affiliates. Attribution is written once per account, at
 * sign-up, from the code the person arrived with. Storage rewards become
 * ordinary entitlements, so the allowance needs nothing new to count them;
 * affiliate earnings are one row per paid order, keyed by the order, so a
 * replayed webhook cannot pay a commission twice.
 */

// No 0/o, 1/l/i: a code is read aloud and typed on phones.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 8;

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function normalizeReferralCode(raw: string) {
    return raw.trim().toLowerCase();
}
export function normalizeAffiliateCode(raw: string) {
    return raw.trim().toUpperCase();
}
export function normalizeSlug(raw: string) {
    return raw.trim().toLowerCase();
}

/* A person's invite code, minted on first use. */
export async function ensureReferralCode(userId: string) {
    const [existing] = await db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.userId, userId));
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 5; attempt++) {
        const [row] = await db
            .insert(referralCodes)
            .values({ userId, code: randomCode() })
            .onConflictDoNothing()
            .returning({ code: referralCodes.code });
        if (row) return row.code;
        // Either the code collided (try another) or a concurrent call won (read it).
        const [won] = await db
            .select({ code: referralCodes.code })
            .from(referralCodes)
            .where(eq(referralCodes.userId, userId));
        if (won) return won.code;
    }
    throw new Error('Could not mint a referral code.');
}

export type ResolvedCode =
    | { kind: 'user'; userId: string; name: string; code: string }
    | { kind: 'affiliate'; affiliate: typeof affiliates.$inferSelect };

/* What a code the person typed or carried in a link points at, if anything live. */
export async function resolveCode(raw: string): Promise<ResolvedCode | null> {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 64) return null;
    const [byUser] = await db
        .select({ userId: referralCodes.userId, name: users.name, code: referralCodes.code })
        .from(referralCodes)
        .innerJoin(users, eq(users.id, referralCodes.userId))
        .where(
            and(eq(referralCodes.code, normalizeReferralCode(trimmed)), isNull(users.suspendedAt)),
        );
    if (byUser) return { kind: 'user', ...byUser };
    const [affiliate] = await db
        .select()
        .from(affiliates)
        .where(
            and(eq(affiliates.code, normalizeAffiliateCode(trimmed)), eq(affiliates.active, true)),
        );
    return affiliate ? { kind: 'affiliate', affiliate } : null;
}

/*
 * Records who a new account arrived through. Once per account, never oneself,
 * and only for a code that resolves; anything else is silently no attribution.
 */
export async function attributeSignup(input: { userId: string; code: string }) {
    const resolved = await resolveCode(input.code);
    if (!resolved) return null;
    if (resolved.kind === 'user' && resolved.userId === input.userId) return null;
    const [row] = await db
        .insert(referrals)
        .values(
            resolved.kind === 'user'
                ? {
                      referredUserId: input.userId,
                      kind: 'user',
                      referrerUserId: resolved.userId,
                      code: resolved.code,
                  }
                : {
                      referredUserId: input.userId,
                      kind: 'affiliate',
                      affiliateId: resolved.affiliate.id,
                      code: resolved.affiliate.code,
                  },
        )
        .onConflictDoNothing({ target: referrals.referredUserId })
        .returning();
    return row ?? null;
}

type RewardSide = 'referrer' | 'referred' | 'referrer-paid';

/* Bytes already granted to a person on one side, for the caps. */
async function grantedBytes(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    userId: string,
    side: RewardSide,
) {
    const [row] = await tx
        .select({ bytes: sum(referralRewards.quotaBytes) })
        .from(referralRewards)
        .where(and(eq(referralRewards.userId, userId), eq(referralRewards.side, side)));
    return BigInt(row?.bytes ?? 0);
}

/* One reward: an entitlement the allowance counts, and the row that says why. Once per referral and side. */
async function grantOnce(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    referralId: string,
    userId: string,
    side: RewardSide,
    quotaBytes: bigint,
) {
    const [already] = await tx
        .select({ id: referralRewards.id })
        .from(referralRewards)
        .where(and(eq(referralRewards.referralId, referralId), eq(referralRewards.side, side)));
    if (already) return false;
    const [personal] = await tx
        .select({ workspaceId: personalWorkspaces.workspaceId })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.userId, userId));
    if (!personal) return false;
    const [entitlement] = await tx
        .insert(storageEntitlements)
        .values({
            workspaceId: personal.workspaceId,
            source: 'referral',
            sourceReference: `referral:${referralId}:${side}`,
            quotaBytes,
        })
        .onConflictDoNothing({ target: storageEntitlements.sourceReference })
        .returning({ id: storageEntitlements.id });
    await tx.insert(referralRewards).values({
        referralId,
        userId,
        side,
        quotaBytes,
        entitlementId: entitlement?.id ?? null,
    });
    return true;
}

/*
 * Storage for a user-to-user referral at sign-up: the new account always, the
 * referrer while the total they have earned from sign-ups stays under the cap.
 * Each side is granted at most once per referral.
 */
export async function grantReferralRewards(input: {
    referralId: string;
    bonusBytes: bigint;
    signupCapBytes: bigint;
}) {
    return db.transaction(async (tx) => {
        const [referral] = await tx
            .select()
            .from(referrals)
            .where(eq(referrals.id, input.referralId))
            .for('update');
        if (!referral || referral.kind !== 'user' || !referral.referrerUserId)
            return { referrer: false, referred: false };
        const referred = await grantOnce(
            tx,
            referral.id,
            referral.referredUserId,
            'referred',
            input.bonusBytes,
        );
        const earned = await grantedBytes(tx, referral.referrerUserId, 'referrer');
        const referrer =
            earned + input.bonusBytes <= input.signupCapBytes &&
            (await grantOnce(
                tx,
                referral.id,
                referral.referrerUserId,
                'referrer',
                input.bonusBytes,
            ));
        return { referrer, referred };
    });
}

/*
 * Storage for the inviter when someone they invited pays for a plan for the
 * first time: once per invited account, while the total earned this way
 * stays under its own cap. Nothing for the payer; they have their plan.
 */
export async function grantPaidReferralReward(input: {
    referredUserId: string;
    bonusBytes: bigint;
    paidCapBytes: bigint;
}) {
    return db.transaction(async (tx) => {
        const [referral] = await tx
            .select()
            .from(referrals)
            .where(
                and(eq(referrals.referredUserId, input.referredUserId), eq(referrals.kind, 'user')),
            )
            .for('update');
        if (!referral?.referrerUserId) return false;
        const earned = await grantedBytes(tx, referral.referrerUserId, 'referrer-paid');
        if (earned + input.bonusBytes > input.paidCapBytes) return false;
        return grantOnce(
            tx,
            referral.id,
            referral.referrerUserId,
            'referrer-paid',
            input.bonusBytes,
        );
    });
}

/* What a person sees on their Referrals page. */
export async function getReferralSummary(userId: string) {
    const code = await ensureReferralCode(userId);
    const [joined] = await db
        .select({ value: count() })
        .from(referrals)
        .where(eq(referrals.referrerUserId, userId));
    const rows = await db
        .select({
            side: referralRewards.side,
            value: count(),
            bytes: sum(referralRewards.quotaBytes),
        })
        .from(referralRewards)
        .where(eq(referralRewards.userId, userId))
        .groupBy(referralRewards.side);
    const bySide = (side: RewardSide) => {
        const row = rows.find((entry) => entry.side === side);
        return { count: row?.value ?? 0, bytes: BigInt(row?.bytes ?? 0) };
    };
    const [arrivedThrough] = await db
        .select({ kind: referrals.kind, createdAt: referrals.createdAt })
        .from(referrals)
        .where(eq(referrals.referredUserId, userId));
    return {
        code,
        joined: joined?.value ?? 0,
        signup: bySide('referrer'),
        paid: bySide('referrer-paid'),
        arrivedThrough: arrivedThrough ?? null,
    };
}

/* The code a person signed up with and has not checked out on yet. */
export async function pendingReferralCode(userId: string) {
    const [row] = await db
        .select({ code: accountIntents.referralCode })
        .from(accountIntents)
        .where(and(eq(accountIntents.userId, userId), isNull(accountIntents.consumedAt)));
    return row?.code ?? null;
}

export type AffiliateInput = {
    name: string;
    slug: string;
    code: string;
    percentOff: number;
    duration: 'once' | 'forever' | 'repeating';
    durationMonths: number | null;
    commissionBps: number;
    userId: string | null;
    pendingEmail?: string | null;
    notes: string | null;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/* The database itself, or a transaction holding the affiliate lock. */
export type Executor = typeof db | Tx;

/*
 * One affiliate's terms change one change at a time: a transaction-scoped
 * advisory lock keyed by the affiliate's id, held while `run` reads the row,
 * asks the provider, and writes. Two changes that each read, sent the provider
 * their merged terms and wrote would otherwise leave the provider with one set
 * and the row with another. The lock is held across the provider's call, which
 * is admin-only, rare and per affiliate. A change that finds it held is refused
 * at once rather than queued: a waiter would hold a pooled connection for as
 * long as the provider takes. A hash collision only refuses a second affiliate.
 */
export const AFFILIATE_LOCK_SPACE = 0x61666c74;

/* Another change of this affiliate holds the lock. */
export class AffiliateBusyError extends Error {
    constructor() {
        super('This affiliate is being changed.');
        this.name = 'AffiliateBusyError';
    }
}

/*
 * Everything `run` reads or writes goes through `tx`, never the global `db`:
 * the lock is held for the whole transaction, and a second connection asked
 * for inside it could wait on a pool that is full.
 */
export async function withAffiliateLock<T>(id: string, run: (tx: Tx) => Promise<T>) {
    return db.transaction(async (tx) => {
        const taken = await tx.execute<{ locked: boolean }>(
            sql`select pg_try_advisory_xact_lock(${AFFILIATE_LOCK_SPACE}::int, hashtext(${id})) as locked`,
        );
        if (!taken.rows[0]?.locked) throw new AffiliateBusyError();
        return run(tx);
    });
}

export async function createAffiliate(
    input: AffiliateInput & { providerDiscountId: string | null },
) {
    const [row] = await db
        .insert(affiliates)
        .values({
            ...input,
            slug: normalizeSlug(input.slug),
            code: normalizeAffiliateCode(input.code),
        })
        .returning();
    return row!;
}

export async function updateAffiliate(
    id: string,
    patch: Partial<AffiliateInput> & {
        active?: boolean;
        providerDiscountId?: string | null;
    },
    executor: Executor = db,
) {
    const [row] = await executor
        .update(affiliates)
        .set({
            ...patch,
            ...(patch.slug !== undefined ? { slug: normalizeSlug(patch.slug) } : {}),
            ...(patch.code !== undefined ? { code: normalizeAffiliateCode(patch.code) } : {}),
            updatedAt: new Date(),
        })
        .where(eq(affiliates.id, id))
        .returning();
    return row ?? null;
}

/*
 * Removes the affiliate and what pointed at them: the attributions of the
 * people who signed up through them (their accounts stay; an affiliate
 * attribution carries no reward) and the ledger of their earnings.
 */
export async function deleteAffiliate(id: string, executor: Executor = db) {
    return executor.transaction(async (tx) => {
        await tx.delete(referrals).where(eq(referrals.affiliateId, id));
        const rows = await tx
            .delete(affiliates)
            .where(eq(affiliates.id, id))
            .returning({ id: affiliates.id });
        return rows.length > 0;
    });
}

/*
 * `forUpdate` locks the row to the transaction's end: an earning recorded for
 * it meanwhile waits on its foreign key, and after a removal fails, instead of
 * being deleted with the affiliate unseen.
 */
export async function getAffiliate(
    id: string,
    executor: Executor = db,
    options: { forUpdate?: boolean } = {},
) {
    const query = executor.select().from(affiliates).where(eq(affiliates.id, id));
    const [row] = await (options.forUpdate ? query.for('update') : query);
    return row ?? null;
}

/* The public landing page's affiliate: live ones only. */
export async function getAffiliateBySlug(slug: string) {
    const [row] = await db
        .select()
        .from(affiliates)
        .where(and(eq(affiliates.slug, normalizeSlug(slug)), eq(affiliates.active, true)));
    return row ?? null;
}

/*
 * Any affiliate, paused or not, whose slug or code this is. The offer page
 * asks before falling back to the provider's discount codes, so pausing a
 * creator takes their page down instead of leaving it up under their code.
 * `except` leaves one affiliate out, in the query itself: a handle can be one
 * affiliate's slug and another's code, and the row left out must not hide the other.
 */
export async function findAffiliateByHandle(
    handle: string,
    except?: string,
    executor: Executor = db,
) {
    const [row] = await executor
        .select()
        .from(affiliates)
        .where(
            and(
                or(
                    eq(affiliates.slug, normalizeSlug(handle)),
                    eq(affiliates.code, normalizeAffiliateCode(handle)),
                ),
                except ? ne(affiliates.id, except) : undefined,
            ),
        )
        .limit(1);
    return row ?? null;
}

/*
 * Creators an operator gave an email before its account existed, linked once
 * it does. Done when the links are read, not at sign-up: an account made while
 * the operator's save waits on the provider exists before the row it should
 * link to, and a step at sign-up that failed would never run again. Every
 * account verified its email before it was created, so only the address's
 * owner can take the link. This one is for one account, reading its own page.
 */
export async function linkPendingAffiliates(userId: string) {
    const rows = await db
        .update(affiliates)
        .set({ userId, pendingEmail: null, updatedAt: new Date() })
        .from(users)
        .where(
            and(
                eq(users.id, userId),
                eq(affiliates.pendingEmail, users.normalizedEmail),
                isNull(affiliates.userId),
            ),
        )
        .returning({ id: affiliates.id });
    return rows.length;
}

/* Every pending creator whose account now exists: the operator's list reads this first. */
export async function linkAllPendingAffiliates() {
    const rows = await db
        .update(affiliates)
        .set({ userId: sql`${users.id}`, pendingEmail: null, updatedAt: new Date() })
        .from(users)
        .where(and(eq(users.normalizedEmail, affiliates.pendingEmail), isNull(affiliates.userId)))
        .returning({ id: affiliates.id });
    return rows.length;
}

/* Every creator an account runs, as its own page lists them: the oldest first. */
export async function listAffiliatesForUser(userId: string) {
    return db
        .select()
        .from(affiliates)
        .where(eq(affiliates.userId, userId))
        .orderBy(affiliates.createdAt, affiliates.id);
}

export async function findAffiliateByDiscount(providerDiscountId: string) {
    const [row] = await db
        .select()
        .from(affiliates)
        .where(eq(affiliates.providerDiscountId, providerDiscountId));
    return row ?? null;
}

/* The affiliate a paying customer arrived through, if any. */
export async function findAffiliateForCustomer(userId: string) {
    const [row] = await db
        .select({ affiliate: affiliates })
        .from(referrals)
        .innerJoin(affiliates, eq(affiliates.id, referrals.affiliateId))
        .where(and(eq(referrals.referredUserId, userId), eq(referrals.kind, 'affiliate')));
    return row?.affiliate ?? null;
}

export type EarningTotals = Record<string, { unpaid: number; paid: number }>;

async function earningTotals(affiliateId: string, executor: Executor = db): Promise<EarningTotals> {
    const rows = await executor
        .select({
            currency: affiliateEarnings.currency,
            paid: sql<boolean>`${affiliateEarnings.paidAt} is not null`,
            total: sum(affiliateEarnings.commissionAmount),
        })
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.affiliateId, affiliateId))
        .groupBy(affiliateEarnings.currency, sql`${affiliateEarnings.paidAt} is not null`);
    const totals: EarningTotals = {};
    for (const row of rows) {
        totals[row.currency] ??= { unpaid: 0, paid: 0 };
        totals[row.currency]![row.paid ? 'paid' : 'unpaid'] += Number(row.total ?? 0);
    }
    return totals;
}

export async function affiliateStats(affiliateId: string, executor: Executor = db) {
    const [signups] = await executor
        .select({ value: count() })
        .from(referrals)
        .where(eq(referrals.affiliateId, affiliateId));
    const [orders] = await executor
        .select({ value: count() })
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.affiliateId, affiliateId));
    return {
        signups: signups?.value ?? 0,
        orders: orders?.value ?? 0,
        earnings: await earningTotals(affiliateId, executor),
    };
}

export async function listAffiliates() {
    const rows = await db.select().from(affiliates).orderBy(desc(affiliates.createdAt));
    return Promise.all(rows.map(async (row) => ({ ...row, stats: await affiliateStats(row.id) })));
}

/*
 * Commission on one paid order. The order id is unique, so a replayed
 * webhook or a second attribution path records nothing the second time.
 */
/* The commission on an order's net amount, in its smallest unit: rounded down. */
export function commissionFor(netAmount: number, commissionBps: number) {
    return Math.floor((netAmount * commissionBps) / 10_000);
}

export async function recordEarning(input: {
    affiliateId: string;
    orderId: string;
    userId: string | null;
    currency: string;
    netAmount: number;
    commissionBps: number;
}) {
    if (input.netAmount <= 0) return null;
    const commission = commissionFor(input.netAmount, input.commissionBps);
    const [row] = await db
        .insert(affiliateEarnings)
        .values({
            affiliateId: input.affiliateId,
            orderId: input.orderId,
            userId: input.userId,
            currency: input.currency,
            netAmount: input.netAmount,
            commissionAmount: commission,
        })
        .onConflictDoNothing({ target: affiliateEarnings.orderId })
        .returning();
    return row ?? null;
}

export async function listEarnings(affiliateId: string, limit = 100) {
    return db
        .select()
        .from(affiliateEarnings)
        .where(eq(affiliateEarnings.affiliateId, affiliateId))
        .orderBy(desc(affiliateEarnings.createdAt))
        .limit(limit);
}

/* An operator has paid the affiliate everything owed so far. */
export async function markEarningsPaid(affiliateId: string) {
    const rows = await db
        .update(affiliateEarnings)
        .set({ paidAt: new Date() })
        .where(
            and(eq(affiliateEarnings.affiliateId, affiliateId), isNull(affiliateEarnings.paidAt)),
        )
        .returning({ id: affiliateEarnings.id });
    return rows.length;
}

/* The account behind an email, for linking a creator to their affiliate record. */
export async function findUserIdByEmail(normalizedEmail: string, executor: Executor = db) {
    const [row] = await executor
        .select({ id: users.id })
        .from(users)
        .where(eq(users.normalizedEmail, normalizedEmail));
    return row?.id ?? null;
}

/*
 * A signed-in person opened a creator's page: their next checkout should carry
 * that code. Kept as the account's pending intent, which checkout consumes;
 * a plan chosen earlier stays with it.
 */
export async function rememberCoupon(userId: string, code: string) {
    await db
        .insert(accountIntents)
        .values({ userId, referralCode: code, source: 'coupon' })
        .onConflictDoUpdate({
            target: accountIntents.userId,
            set: { referralCode: code, source: 'coupon', consumedAt: null },
        });
}
