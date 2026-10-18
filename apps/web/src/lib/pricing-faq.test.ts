import type { FamilyPlan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { familyOffers } from './plans';
import { faqFor } from './pricing-faq';

function tier(name: string, gib: number, usd: number): FamilyPlan {
    return {
        id: name.toLowerCase(),
        name: `${name} (monthly)`,
        description: null,
        interval: 'month',
        tier: null,
        recommended: false,
        prices: {
            usd: { base: usd, perMember: 150 },
            gbp: { base: (usd * 4) / 5, perMember: 120 },
        },
        includedMembers: 4,
        maxMembers: 20,
        quotaBytes: String(gib * 1024 ** 3),
    };
}
const families = [
    tier('Family Plus', 800, 1000),
    tier('Family Pro', 2048, 2000),
    tier('Family Max', 4096, 3000),
];
const mentionsFamily = (items: { q: string; a: string }[]) =>
    items.filter(({ q, a }) => /family/i.test(q) || /family/i.test(a));

describe('faqFor', () => {
    test('keeps every family question out with families off or billing off', () => {
        for (const offers of [
            familyOffers({ enabled: true, families: [] }, 'month', 'usd'),
            familyOffers({ enabled: false, families }, 'month', 'usd'),
        ]) {
            const items = faqFor(offers);
            expect(mentionsFamily(items)).toEqual([]);
            expect(items[0]?.a.startsWith('Storage, and nothing else.')).toBe(true);
        }
    });

    test('adds the family questions only with a family plan, and drops "nothing else"', () => {
        const items = faqFor(familyOffers({ enabled: true, families }, 'month', 'usd'));
        expect(items.map(({ q }) => q)).toEqual([
            'What do paid plans add?',
            'Who bills me?',
            'What happens when I cancel?',
            'Can I switch between monthly and yearly?',
            'What is a family plan?',
            'Can a family change plans?',
            'Who pays for a family plan?',
            'What happens if a member leaves or is removed?',
            'What happens when a family plan is cancelled?',
            'Is running it myself free?',
        ]);
        expect(items[0]?.a).not.toMatch(/nothing else/);
    });

    test('answers with the tiers shown: four included, the price of a member after that, up to twenty', () => {
        const answer = (currency: string) =>
            faqFor(familyOffers({ enabled: true, families }, 'month', currency), currency).find(
                ({ q }) => q === 'What is a family plan?',
            )?.a;
        expect(answer('usd')).toBe(
            'One plan with 4 members included. Each member after that is $1.50 a month, up to 20. It gives family folders that every member can open, end-to-end encrypted. Family Plus has 800 GB, Family Pro 2 TB and Family Max 4 TB; that storage is for family folders, and each member’s own files stay on their own plan, Free included. Family folders are on the web for now.',
        );
        expect(answer('gbp')).toContain('Each member after that is £1.20 a month, up to 20.');
    });
});
