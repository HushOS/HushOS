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

const asked = (id: string): ApprovalPrompt => ({
    id,
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
        listed.mockResolvedValue(ids.map(asked));
        expect((await look()).map((prompt) => prompt.id)).toEqual(ids.slice(0, 5));
        expect(JSON.parse(localStorage.getItem(KEY)!).seen.unknown).toEqual(ids.slice(0, 5));
        // The sixth alone, later the same day: still not shown.
        listed.mockResolvedValue([asked(ids[5]!)]);
        expect(await look()).toEqual([]);
    });
});
