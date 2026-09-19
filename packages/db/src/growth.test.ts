import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { getStorageAllowance } from './auth';
import { db } from './client';
import * as growth from './growth';
import {
    affiliateEarnings,
    referralRewards,
    referrals,
    storageEntitlements,
    users,
} from './schema';

/*
 * Attribution is written once and never to oneself; rewards land as
 * entitlements the allowance counts, each side once, the referrer only under
 * the cap; affiliate codes resolve only while active; a commission is paid
 * once per order however many times the order is reported.
 */

const GIB = 1_073_741_824n;

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function affiliate(overrides: Partial<growth.AffiliateInput> = {}) {
    return growth.createAffiliate({
        name: 'Creator',
        slug: 'creator',
        code: 'CREATOR20',
        percentOff: 20,
        duration: 'forever',
        durationMonths: null,
        commissionBps: 2500,
        userId: null,
        notes: null,
        providerDiscountId: 'disc_1',
        ...overrides,
    });
}

describe('referral codes and attribution', () => {
    test('a code is minted once, resolves case-insensitively, and never attributes to itself', async () => {
        const inviter = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        expect(code).toMatch(/^[a-z2-9]{8}$/);
        expect(await growth.ensureReferralCode(inviter.userId)).toBe(code);
        const resolved = await growth.resolveCode(`  ${code.toUpperCase()} `);
        expect(resolved).toMatchObject({ kind: 'user', userId: inviter.userId });
        expect(await growth.attributeSignup({ userId: inviter.userId, code })).toBeNull();
        expect(await growth.resolveCode('nosuchcode')).toBeNull();
    });

    test('an account is attributed once; a second code later changes nothing', async () => {
        const inviter = await createTestAccount();
        const other = await createTestAccount();
        const joiner = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        const otherCode = await growth.ensureReferralCode(other.userId);
        const first = await growth.attributeSignup({ userId: joiner.userId, code });
        expect(first).toMatchObject({ kind: 'user', referrerUserId: inviter.userId });
        expect(await growth.attributeSignup({ userId: joiner.userId, code: otherCode })).toBeNull();
        const summary = await growth.getReferralSummary(inviter.userId);
        expect(summary.joined).toBe(1);
        expect((await growth.getReferralSummary(other.userId)).joined).toBe(0);
    });

    test("a suspended inviter's code stops resolving", async () => {
        const inviter = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, inviter.userId));
        expect(await growth.resolveCode(code)).toBeNull();
    });
});

describe('referral rewards', () => {
    test('both sides gain storage the allowance counts, each side once', async () => {
        const inviter = await createTestAccount();
        const joiner = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        const referral = (await growth.attributeSignup({ userId: joiner.userId, code }))!;
        const granted = await growth.grantReferralRewards({
            referralId: referral.id,
            bonusBytes: GIB,
            signupCapBytes: 10n * GIB,
        });
        expect(granted).toEqual({ referrer: true, referred: true });
        expect((await getStorageAllowance(inviter.userId))?.quotaBytes).toBe((2n * GIB).toString());
        expect((await getStorageAllowance(joiner.userId))?.quotaBytes).toBe((2n * GIB).toString());
        // Granting again for the same referral is a no-op, not a second gigabyte.
        const again = await growth.grantReferralRewards({
            referralId: referral.id,
            bonusBytes: GIB,
            signupCapBytes: 10n * GIB,
        });
        expect(again).toEqual({ referrer: false, referred: false });
        expect(await db.select().from(storageEntitlements)).toHaveLength(2);
        const summary = await growth.getReferralSummary(inviter.userId);
        expect(summary).toMatchObject({ joined: 1, signup: { count: 1, bytes: GIB } });
    });

    test('the referrer stops earning at the cap; the people they invite still do', async () => {
        const inviter = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        const results = [];
        for (let i = 0; i < 3; i++) {
            const joiner = await createTestAccount();
            const referral = (await growth.attributeSignup({ userId: joiner.userId, code }))!;
            results.push(
                await growth.grantReferralRewards({
                    referralId: referral.id,
                    bonusBytes: GIB,
                    signupCapBytes: 2n * GIB,
                }),
            );
        }
        expect(results).toEqual([
            { referrer: true, referred: true },
            { referrer: true, referred: true },
            { referrer: false, referred: true },
        ]);
        expect((await getStorageAllowance(inviter.userId))?.quotaBytes).toBe((3n * GIB).toString());
        const rewards = await db.select().from(referralRewards);
        expect(rewards.filter((row) => row.side === 'referrer')).toHaveLength(2);
        expect(rewards.filter((row) => row.side === 'referred')).toHaveLength(3);
        expect((await growth.getReferralSummary(inviter.userId)).signup.bytes).toBe(2n * GIB);
    });

    test('a paid invite rewards the inviter once per invitee, under its own cap', async () => {
        const inviter = await createTestAccount();
        const code = await growth.ensureReferralCode(inviter.userId);
        const first = await createTestAccount();
        const second = await createTestAccount();
        for (const joiner of [first, second]) {
            const referral = (await growth.attributeSignup({ userId: joiner.userId, code }))!;
            await growth.grantReferralRewards({
                referralId: referral.id,
                bonusBytes: GIB,
                signupCapBytes: 5n * GIB,
            });
        }
        const paid = { bonusBytes: 5n * GIB, paidCapBytes: 5n * GIB };
        expect(
            await growth.grantPaidReferralReward({ referredUserId: first.userId, ...paid }),
        ).toBe(true);
        // A renewal by the same person is not a second first payment.
        expect(
            await growth.grantPaidReferralReward({ referredUserId: first.userId, ...paid }),
        ).toBe(false);
        // The cap is reached, so the next paying invitee earns nothing more.
        expect(
            await growth.grantPaidReferralReward({ referredUserId: second.userId, ...paid }),
        ).toBe(false);
        // Someone nobody invited pays: nothing to grant.
        const stranger = await createTestAccount();
        expect(
            await growth.grantPaidReferralReward({ referredUserId: stranger.userId, ...paid }),
        ).toBe(false);
        // 1 GiB base, 2 GiB from two sign-ups, 5 GiB from one paid invite.
        expect((await getStorageAllowance(inviter.userId))?.quotaBytes).toBe((8n * GIB).toString());
        expect(await growth.getReferralSummary(inviter.userId)).toMatchObject({
            joined: 2,
            signup: { count: 2, bytes: 2n * GIB },
            paid: { count: 1, bytes: 5n * GIB },
        });
    });

    test('an affiliate attribution grants no storage', async () => {
        await affiliate();
        const joiner = await createTestAccount();
        const referral = (await growth.attributeSignup({
            userId: joiner.userId,
            code: 'creator20',
        }))!;
        expect(referral.kind).toBe('affiliate');
        const granted = await growth.grantReferralRewards({
            referralId: referral.id,
            bonusBytes: GIB,
            signupCapBytes: 10n * GIB,
        });
        expect(granted).toEqual({ referrer: false, referred: false });
        expect((await getStorageAllowance(joiner.userId))?.quotaBytes).toBe(GIB.toString());
    });
});

describe('affiliates and earnings', () => {
    test('slug and code resolve only while active, whatever the case typed', async () => {
        const created = await affiliate({ slug: 'Creator', code: 'creator20' });
        expect(created.slug).toBe('creator');
        expect(created.code).toBe('CREATOR20');
        expect((await growth.getAffiliateBySlug('CREATOR'))?.id).toBe(created.id);
        expect((await growth.resolveCode('Creator20'))?.kind).toBe('affiliate');
        await growth.updateAffiliate(created.id, { active: false });
        expect(await growth.getAffiliateBySlug('creator')).toBeNull();
        expect(await growth.resolveCode('creator20')).toBeNull();
    });

    test('removing an affiliate drops their attributions and ledger, and keeps the accounts', async () => {
        const created = await affiliate();
        const customer = await createTestAccount();
        await growth.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        await growth.recordEarning({
            affiliateId: created.id,
            orderId: 'order_1',
            userId: customer.userId,
            currency: 'usd',
            netAmount: 1000,
            commissionBps: 2500,
        });
        expect(await growth.deleteAffiliate(created.id)).toBe(true);
        expect(await growth.deleteAffiliate(created.id)).toBe(false);
        // The account stays, attributed to nobody; the earnings go with the affiliate.
        expect(await growth.findAffiliateForCustomer(customer.userId)).toBeNull();
        expect(
            await db.select().from(referrals).where(eq(referrals.referredUserId, customer.userId)),
        ).toEqual([]);
        expect(await db.select().from(users).where(eq(users.id, customer.userId))).toHaveLength(1);
        expect(await db.select().from(affiliateEarnings)).toEqual([]);
    });

    test('a commission is recorded once per order, rounded down, and paid out as a whole', async () => {
        const created = await affiliate();
        const customer = await createTestAccount();
        await growth.attributeSignup({ userId: customer.userId, code: 'CREATOR20' });
        expect((await growth.findAffiliateForCustomer(customer.userId))?.id).toBe(created.id);
        expect((await growth.findAffiliateByDiscount('disc_1'))?.id).toBe(created.id);
        const first = await growth.recordEarning({
            affiliateId: created.id,
            orderId: 'order_1',
            userId: customer.userId,
            currency: 'usd',
            netAmount: 799,
            commissionBps: 2500,
        });
        // 25% of 7.99 is 1.9975: never rounded up.
        expect(first?.commissionAmount).toBe(199);
        // The same order reported again (a webhook replay, or a second attribution path) pays nothing more.
        expect(
            await growth.recordEarning({
                affiliateId: created.id,
                orderId: 'order_1',
                userId: customer.userId,
                currency: 'usd',
                netAmount: 799,
                commissionBps: 2500,
            }),
        ).toBeNull();
        expect(
            await growth.recordEarning({
                affiliateId: created.id,
                orderId: 'order_refund',
                userId: customer.userId,
                currency: 'usd',
                netAmount: 0,
                commissionBps: 2500,
            }),
        ).toBeNull();
        await growth.recordEarning({
            affiliateId: created.id,
            orderId: 'order_2',
            userId: customer.userId,
            currency: 'inr',
            netAmount: 79900,
            commissionBps: 2500,
        });
        let stats = await growth.affiliateStats(created.id);
        expect(stats).toMatchObject({ signups: 1, orders: 2 });
        expect(stats.earnings).toEqual({
            usd: { unpaid: 199, paid: 0 },
            inr: { unpaid: 19975, paid: 0 },
        });
        expect(await growth.markEarningsPaid(created.id)).toBe(2);
        expect(await growth.markEarningsPaid(created.id)).toBe(0);
        stats = await growth.affiliateStats(created.id);
        expect(stats.earnings).toEqual({
            usd: { unpaid: 0, paid: 199 },
            inr: { unpaid: 0, paid: 19975 },
        });
        expect(await db.select().from(affiliateEarnings)).toHaveLength(2);
    });
});
