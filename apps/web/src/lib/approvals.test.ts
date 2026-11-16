import type { ApprovalPrompt } from '@hushos/auth/client';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * This browser's own count of the prompts it showed today (docs/two-step-design.md 12) is kept
 * in the signed-in account's storage, which sign-out clears. A list that was asked for under
 * one account and answered after it signed out comes back empty (`authClient.approvals` drops a
 * list that is not the current account's): it must then write nothing, or the next account
 * starts with a record made after the clearing.
 */

const KEY = 'hushos-approval-prompts';
const listed = vi.fn<() => Promise<ApprovalPrompt[]>>();
vi.mock('@/lib/auth-client', () => ({ authClient: { approvals: listed } }));
const { approvalAsks, approvalsQueryOptions } = await import('./approvals');
const look = () => approvalsQueryOptions.queryFn!({} as never) as Promise<ApprovalPrompt[]>;

const MAYA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SAM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const asked = (id: string, userId = MAYA): ApprovalPrompt => ({
    id,
    userId,
    purpose: 'login',
    class: 'unknown',
    device: { kind: 'web', name: 'Chrome on Windows', addedAt: null },
    location: null,
    selfNamed: true,
    chosen: false,
    createdAt: '2026-11-14T10:00:00.000Z',
    expiresAt: '2026-11-14T10:05:00.000Z',
    tokenDigest: 'A'.repeat(43),
    commitment: 'B'.repeat(43),
    approverKey: null,
    reveal: null,
});

beforeEach(() => {
    listed.mockReset();
    localStorage.clear();
});

describe('what a prompt says is asked', () => {
    // Noon, so the day is the same wherever the test runs; this year, so no year is said.
    const year = new Date().getFullYear();
    const laptop = { name: 'Maya’s Laptop', addedAt: `${year}-03-14T12:00:00.000Z` };
    const day = '14 Mar';

    test('a name the server vouches for is said as it is, and never with a date', () => {
        expect(approvalAsks({ purpose: 'password', device: laptop, selfNamed: false })).toBe(
            'Change your password on Maya’s Laptop',
        );
    });

    test('with no second step yet, a device of the account is said in its own words, with the day it was added', () => {
        // Whoever has the password can sign in under this name: the prompt must not vouch for it.
        expect(
            approvalAsks({
                purpose: 'device-approval',
                device: laptop,
                selfNamed: true,
                location: 'in France',
            }),
        ).toBe(
            `Turn on Approve on another device on a device calling itself “Maya’s Laptop”, added ${day}, in France`,
        );
    });

    test('a sign-in the account does not know is a new device, in its own words', () => {
        expect(
            approvalAsks({
                purpose: 'login',
                device: { name: 'Chrome on Windows', addedAt: null },
                selfNamed: true,
            }),
        ).toBe('Sign-in on a new device calling itself “Chrome on Windows”');
        expect(approvalAsks({ purpose: 'login', device: { name: ' ' }, selfNamed: true })).toBe(
            'Sign-in on a new device',
        );
        // A date that is none says nothing, and another year's says its year.
        expect(
            approvalAsks({
                purpose: 'device-approval',
                device: { name: 'Pixel 9', addedAt: 'yesterday' },
                selfNamed: true,
            }),
        ).toBe('Turn on Approve on another device on a new device calling itself “Pixel 9”');
        expect(
            approvalAsks({
                purpose: 'device-approval',
                device: { name: 'Pixel 9', addedAt: `${year - 1}-03-14T12:00:00.000Z` },
                selfNamed: true,
            }),
        ).toBe(
            `Turn on Approve on another device on a device calling itself “Pixel 9”, added 14 Mar ${year - 1}`,
        );
    });
});

describe('the count of prompts shown today', () => {
    test('a list with nothing in it writes nothing into the account’s storage', async () => {
        listed.mockResolvedValue([]);
        expect(await look()).toEqual([]);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    test('what is shown is counted, and the sixth of a class in a day is not shown', async () => {
        const ids = Array.from(
            { length: 6 },
            (_, index) => `7c9e6679-7425-40de-944b-e07fc1f90a0${index}`,
        );
        listed.mockResolvedValue(ids.map((id) => asked(id)));
        expect((await look()).map((prompt) => prompt.id)).toEqual(ids.slice(0, 5));
        expect(JSON.parse(localStorage.getItem(KEY)!).seen.unknown).toEqual(ids.slice(0, 5));
        // The sixth alone, later the same day: still not shown.
        listed.mockResolvedValue([asked(ids[5]!)]);
        expect(await look()).toEqual([]);
    });

    test('where the browser will not store the count, it is still kept for the page, and for that account only', async () => {
        // A private window, or a store that is full or blocked: nothing can be written.
        const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        });
        try {
            const ids = Array.from(
                { length: 7 },
                (_, index) => `11111111-7425-40de-944b-e07fc1f90a0${index}`,
            );
            listed.mockResolvedValue(ids.slice(0, 6).map((id) => asked(id)));
            expect((await look()).map((prompt) => prompt.id)).toEqual(ids.slice(0, 5));
            expect(localStorage.getItem(KEY)).toBeNull();
            // The sixth and a seventh, alone, on later looks: the five are still counted.
            listed.mockResolvedValue([asked(ids[5]!), asked(ids[6]!)]);
            expect(await look()).toEqual([]);
            // Someone else signs in on this page: they start from nothing, not from Maya's five.
            listed.mockResolvedValue([asked(ids[6]!, SAM)]);
            expect((await look()).map((prompt) => prompt.id)).toEqual([ids[6]]);
            // And Maya's count went when the account changed, as the stored one does at sign-out.
            listed.mockResolvedValue([asked(ids[5]!)]);
            expect((await look()).map((prompt) => prompt.id)).toEqual([ids[5]]);
        } finally {
            refused.mockRestore();
        }
    });
});
