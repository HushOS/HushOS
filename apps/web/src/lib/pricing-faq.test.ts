import type { FamilyPlan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { familyOffer } from './plans';
import { faqFor } from './pricing-faq';

const family: FamilyPlan = {
    id: 'family-month',
    name: 'Family (monthly)',
    description: null,
    interval: 'month',
    prices: { usd: { base: 1500, perMember: 200 } },
    includedMembers: 6,
    maxMembers: 20,
    quotaBytes: String(2 * 1024 ** 4),
};
const mentionsFamily = (items: { q: string; a: string }[]) =>
    items.filter(({ q, a }) => /family/i.test(q) || /family/i.test(a));

describe('faqFor', () => {
    test('keeps every family question out with families off or billing off', () => {
        for (const offer of [
            familyOffer({ enabled: true, families: [] }, 'month', 'usd'),
            familyOffer({ enabled: false, families: [family] }, 'month', 'usd'),
        ]) {
            const items = faqFor(offer);
            expect(mentionsFamily(items)).toEqual([]);
            expect(items[0]?.a.startsWith('Storage, and nothing else.')).toBe(true);
        }
    });

    test('adds the family questions only with a family plan, and drops "nothing else"', () => {
        const items = faqFor(familyOffer({ enabled: true, families: [family] }, 'month', 'usd'));
        expect(items.map(({ q }) => q)).toEqual([
            'What do paid plans add?',
            'Who bills me?',
            'What happens when I cancel?',
            'Can I switch between monthly and yearly?',
            'What is a family plan?',
            'Who pays for a family plan?',
            'What happens if a member leaves or is removed?',
            'What happens when a family plan is cancelled?',
            'Is running it myself free?',
        ]);
        expect(items[0]?.a).not.toMatch(/nothing else/);
        expect(items[4]?.a).toContain('Free included');
    });
});
