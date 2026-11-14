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
const { approvalsQueryOptions } = await import('./approvals');
const look = () => approvalsQueryOptions.queryFn!({} as never) as Promise<ApprovalPrompt[]>;

const asked = (id: string): ApprovalPrompt => ({
    id,
    purpose: 'login',
    class: 'unknown',
    device: { kind: 'web', name: 'Chrome on Windows' },
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
