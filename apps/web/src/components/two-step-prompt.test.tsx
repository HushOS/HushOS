import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useStepPrompt } from '@/components/two-step-prompt';

/*
 * The step screen answers the auth client, which waits on it while holding the crypto worker
 * for the sign-in or the change (packages/auth client.ts). A screen that has gone away must
 * still answer, by backing out: an ask left unanswered keeps the worker held, and this tab
 * then refuses every account operation and never opens its saved unlock until it is reloaded.
 */
const request = { methods: ['totp' as const], endsIn: 300_000 };

describe('a step screen whose page went away', () => {
    test('backs out of the ask it was showing', async () => {
        const { result, unmount } = renderHook(() => useStepPrompt());
        let asked!: Promise<unknown>;
        act(() => {
            asked = result.current.ask(request);
        });
        unmount();
        await expect(asked).resolves.toBeNull();
    });

    test('backs out of an ask made after it left, as while the password was still being proved', async () => {
        const { result, unmount } = renderHook(() => useStepPrompt());
        const { ask } = result.current;
        unmount();
        await expect(ask(request)).resolves.toBeNull();
    });

    test('still asks, and takes the answer typed, while it is on screen', async () => {
        const { result } = renderHook(() => useStepPrompt());
        let asked!: Promise<unknown>;
        act(() => {
            asked = result.current.ask(request);
        });
        act(() => result.current.setValue('123456'));
        act(() => result.current.submit());
        await expect(asked).resolves.toEqual({ kind: 'totp', code: '123456' });
    });
});
