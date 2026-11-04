import { describe, expect, test } from 'vitest';
import { familyCost, familyNote, fitAnswer, HEADROOM, type FamilyPrice } from './fit-answer';

const GB = 1024 ** 3;
const TB = 1024 * GB;

/* The shape of the catalogue HushOS sells: Free and three personal sizes, three family pools. */
const personal = [
    { key: 'free', quotaBytes: 2 * GB },
    { key: 'plus', quotaBytes: 200 * GB },
    { key: 'pro', quotaBytes: 500 * GB },
    { key: 'max', quotaBytes: 1 * TB },
];
const family = [
    { key: 'family-plus', quotaBytes: 800 * GB, maxMembers: 20 },
    { key: 'family-pro', quotaBytes: 2 * TB, maxMembers: 20 },
    { key: 'family-max', quotaBytes: 4 * TB, maxMembers: 20 },
];
const personalKeys = new Set(personal.map((plan) => plan.key));
const familyKeys = new Set(family.map((plan) => plan.key));

const answer = (people: number, total: number, contact = true) =>
    fitAnswer({ personal, family, people, total, contact });
const keyOf = (result: ReturnType<typeof answer>) =>
    result.kind === 'fits' || result.kind === 'tight'
        ? result.plan.key
        : result.kind === 'beyond'
          ? result.largest?.key
          : undefined;

describe('fitAnswer', () => {
    test('one person is never offered a family plan, even past the biggest personal plan', () => {
        for (const total of [1 * GB, 700 * GB, 0.95 * TB, 1.1 * TB, 3 * TB, 10 * TB]) {
            const result = answer(1, total);
            expect(familyKeys.has(keyOf(result) ?? '')).toBe(false);
        }
        // 1.1 TB is more than Max holds, though Family Pro would hold it: the answer is "more than 1 TB".
        expect(answer(1, 1.1 * TB)).toEqual({
            kind: 'beyond',
            largest: personal[3],
            reach: 'contact',
        });
    });

    test('two or more people are never offered a personal plan, even when one would hold it', () => {
        for (const people of [2, 5, 20]) {
            for (const total of [1 * GB, 150 * GB, 700 * GB, 1.1 * TB, 3.7 * TB, 5 * TB]) {
                expect(personalKeys.has(keyOf(answer(people, total)) ?? '')).toBe(false);
            }
        }
        // 1 GB would fit Free, but a family's smallest plan is Family Plus.
        expect(answer(2, 1 * GB)).toEqual({ kind: 'fits', plan: family[0] });
        expect(answer(5, 1.1 * TB)).toEqual({ kind: 'fits', plan: family[1] });
    });

    test('a family plan too small for the number of people is skipped', () => {
        const capped = [{ ...family[0]!, maxMembers: 6 }, family[1]!, family[2]!];
        expect(
            fitAnswer({ personal, family: capped, people: 7, total: 10 * GB, contact: true }),
        ).toEqual({ kind: 'fits', plan: family[1] });
        expect(
            fitAnswer({ personal, family: capped, people: 6, total: 10 * GB, contact: true }),
        ).toEqual({ kind: 'fits', plan: capped[0] });
    });

    test('a plan fits up to a tenth short of full, is tight up to full, and is passed beyond', () => {
        const plus = 200 * GB;
        expect(answer(1, plus * HEADROOM)).toEqual({ kind: 'fits', plan: personal[1] });
        // One byte past the headroom: the smaller plan no longer fits, and the next one does.
        expect(answer(1, plus * HEADROOM + 1)).toEqual({ kind: 'fits', plan: personal[2] });
        // Past every plan's headroom but within the biggest: tight in it.
        expect(answer(1, 1 * TB * HEADROOM + 1)).toEqual({ kind: 'tight', plan: personal[3] });
        expect(answer(1, 1 * TB)).toEqual({ kind: 'tight', plan: personal[3] });
        expect(answer(1, 1 * TB + 1).kind).toBe('beyond');
        // The same boundary for a family.
        expect(answer(3, 4 * TB * HEADROOM)).toEqual({ kind: 'fits', plan: family[2] });
        expect(answer(3, 4 * TB * HEADROOM + 1)).toEqual({ kind: 'tight', plan: family[2] });
        expect(answer(3, 4 * TB + 1).kind).toBe('beyond');
    });

    test('past the biggest plan, sales where a contact is named, self-hosting otherwise', () => {
        expect(answer(1, 2 * TB, true)).toEqual({
            kind: 'beyond',
            largest: personal[3],
            reach: 'contact',
        });
        expect(answer(1, 2 * TB, false)).toEqual({
            kind: 'beyond',
            largest: personal[3],
            reach: 'self-host',
        });
        expect(answer(4, 5 * TB, true)).toEqual({
            kind: 'beyond',
            largest: family[2],
            reach: 'contact',
        });
        expect(answer(4, 5 * TB, false)).toEqual({
            kind: 'beyond',
            largest: family[2],
            reach: 'self-host',
        });
    });

    test('nothing kept is no answer, not Free', () => {
        expect(answer(1, 0)).toEqual({ kind: 'empty' });
        expect(answer(6, 0)).toEqual({ kind: 'empty' });
    });
});

describe('family prices', () => {
    const monthly: FamilyPrice = {
        base: 2000,
        perMember: 150,
        currency: 'usd',
        includedMembers: 4,
        interval: 'month',
    };

    test('only members past those included are charged', () => {
        expect(familyCost(monthly, 1)).toBe(2000);
        expect(familyCost(monthly, 4)).toBe(2000);
        expect(familyCost(monthly, 5)).toBe(2150);
        expect(familyCost(monthly, 20)).toBe(2000 + 16 * 150);
        // Another plan's included members move the line, not a fixed four.
        expect(familyCost({ ...monthly, includedMembers: 6 }, 5)).toBe(2000);
        expect(familyCost({ ...monthly, includedMembers: 6 }, 8)).toBe(2300);
    });

    test('the note says the total and the per-member price from the plan, at its interval', () => {
        expect(familyNote(monthly, 4)).toBe('$20 a month, 4 included.');
        expect(familyNote(monthly, 8)).toBe(
            '$26 a month for 8 people: 4 included, then $1.50 a month each.',
        );
        expect(
            familyNote(
                {
                    base: 19200,
                    perMember: 1500,
                    currency: 'usd',
                    includedMembers: 4,
                    interval: 'year',
                },
                5,
            ),
        ).toBe('$207 a year for 5 people: 4 included, then $15 a year each.');
        expect(
            familyNote(
                {
                    base: 59900,
                    perMember: 7900,
                    currency: 'inr',
                    includedMembers: 3,
                    interval: 'month',
                },
                3,
            ),
        ).toBe('₹599 a month, 3 included.');
    });
});
