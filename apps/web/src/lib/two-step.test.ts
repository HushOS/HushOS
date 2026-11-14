import { describe, expect, test, vi } from 'vitest';

/*
 * What a person has typed for a second step, before it is sent: an answer that cannot be
 * right must not cost one of the step's five tries, and after a refusal only what can still
 * pass is offered (a paused app is not; after too many wrong codes only the phrase is).
 */
vi.mock('@/lib/auth-client', () => ({ authClient: {} }));
const { afterRefusal, draftAnswer, draftError, draftFor, emptyDraft, methodsAfter } =
    await import('./two-step');

const words = Array.from({ length: 24 }, (_, index) => `word${index + 1}`);

describe('what is typed for a second step', () => {
    test('a code is six digits, however it was spaced, and is sent without the spaces', () => {
        const draft = { ...emptyDraft(['totp', 'backup', 'phrase']), totp: '123 456' };
        expect(draft.method).toBe('totp');
        expect(draftError(draft)).toBe('');
        expect(draftAnswer(draft)).toEqual({ kind: 'totp', code: '123456' });
        for (const totp of ['', '12345', '1234567', '12345a'])
            expect(draftError({ ...draft, totp })).toMatch(/6-digit code/);
    });

    test('a backup code is ten characters, with or without its hyphen', () => {
        const draft = { ...emptyDraft(['backup']), backup: '7KQ2M-9XD4P' };
        expect(draftError(draft)).toBe('');
        expect(draftError({ ...draft, backup: '7kq2m 9xd4p' })).toBe('');
        expect(draftAnswer(draft)).toEqual({ kind: 'backup', code: '7KQ2M-9XD4P' });
        expect(draftError({ ...draft, backup: '7KQ2M-9XD4' })).toMatch(/10 characters/);
    });

    test('the phrase is 24 words, sent lower-cased with single spaces, and the count says how far along it is', () => {
        const draft = {
            ...emptyDraft(['phrase']),
            phrase: `  ${words.join('\n').toUpperCase()} `,
        };
        expect(draftError(draft)).toBe('');
        expect(draftAnswer(draft)).toEqual({ kind: 'phrase', phrase: words.join(' ') });
        expect(draftError({ ...draft, phrase: words.slice(0, 23).join(' ') })).toMatch(
            /all 24 words.*23 so far/i,
        );
    });

    test('the method typed for is the one sent, whatever the other fields hold', () => {
        const draft = {
            method: 'backup' as const,
            totp: '123456',
            backup: '7KQ2M-9XD4P',
            phrase: words.join(' '),
            device: 'a-request',
        };
        expect(draftAnswer(draft)).toEqual({ kind: 'backup', code: '7KQ2M-9XD4P' });
    });
});

describe('another device as the answer', () => {
    const offered = ['device', 'backup', 'phrase'] as const;
    test('nothing is sent until the other device approved, and then its request is the answer', () => {
        const draft = emptyDraft(offered);
        expect(draft.method).toBe('device');
        // Sent now, the server would only answer that it is still waiting.
        expect(draftError(draft)).toMatch(/hasn’t approved/);
        const approved = { ...draft, device: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
        expect(draftError(approved)).toBe('');
        expect(draftAnswer(approved)).toEqual({
            kind: 'device',
            requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        });
    });
    test('an approval the step refused is not offered to it again; one still waited for is kept', () => {
        const approved = { ...emptyDraft(offered), device: 'a-request' };
        // Refused or over: the other device is asked afresh, never the same request re-sent.
        for (const reason of ['wrong', 'over', 'unavailable'])
            expect(afterRefusal(approved, reason).device).toBe('');
        expect(afterRefusal(approved, 'pending')).toBe(approved);
        // Another method's refusal leaves an approval alone.
        const typing = { ...approved, method: 'backup' as const };
        expect(afterRefusal(typing, 'wrong')).toBe(typing);
        // A spent code budget does not take another device away: it is not a code.
        expect(methodsAfter(['totp', 'device', 'backup', 'phrase'], 'limited', 'totp')).toEqual([
            'device',
            'phrase',
        ]);
    });
});

describe('what is still offered after a refusal', () => {
    const all = ['totp', 'backup', 'phrase'] as const;
    test('what is sent is what is shown: a draft typed for a method that was withdrawn moves to the one now offered', () => {
        // A code was typed for the app, and the app was then paused for this sign-in.
        const typed = { ...emptyDraft(all), totp: '123456', backup: '7KQ2M-9XD4P' };
        const left = methodsAfter(all, 'frozen', 'totp');
        const now = draftFor(typed, left);
        expect(now.method).toBe('backup');
        // The app's code is never what goes out, though it is still in the draft.
        expect(draftAnswer(now)).toEqual({ kind: 'backup', code: '7KQ2M-9XD4P' });
        // With nothing typed for the new method, nothing is sent at all.
        expect(draftError(draftFor({ ...typed, backup: '' }, left))).toMatch(/backup codes/);
        expect(draftFor(typed, methodsAfter(all, 'limited', 'totp')).method).toBe('phrase');
        // A method still offered stays where the person put it, and no methods changes nothing.
        expect(draftFor({ ...typed, method: 'phrase' }, left).method).toBe('phrase');
        expect(draftFor(typed, [])).toBe(typed);
    });
    test('the address’s own limit withdraws nothing: the same answer can go again', () => {
        expect(methodsAfter(all, 'busy', 'totp')).toEqual(['totp', 'backup', 'phrase']);
    });
    test('a wrong answer, or no connection, changes nothing', () => {
        expect(methodsAfter(all, 'wrong', 'totp')).toEqual(['totp', 'backup', 'phrase']);
        expect(methodsAfter(all, 'offline', 'backup')).toEqual(['totp', 'backup', 'phrase']);
    });
    test('a paused app is no longer offered; a backup code and the phrase are', () => {
        expect(methodsAfter(all, 'frozen', 'totp')).toEqual(['backup', 'phrase']);
    });
    test('after too many wrong codes only the phrase is: the app and the backup codes share one budget', () => {
        expect(methodsAfter(all, 'limited', 'totp')).toEqual(['phrase']);
        expect(methodsAfter(all, 'limited', 'backup')).toEqual(['phrase']);
        // Without a phrase nothing is left: the budget outlasts the step, so a code field
        // kept on screen could only be refused again.
        expect(methodsAfter(['totp', 'backup'], 'limited', 'totp')).toEqual([]);
        expect(methodsAfter(['backup'], 'limited', 'backup')).toEqual([]);
    });
    test('a method the server cannot check is withdrawn alone: the other, under its own key, is still offered', () => {
        // The app's secret is under a key the server lost; the backup codes are not.
        expect(methodsAfter(all, 'unavailable', 'totp')).toEqual(['backup', 'phrase']);
        expect(methodsAfter(all, 'unavailable', 'backup')).toEqual(['totp', 'phrase']);
        // Without a phrase too: the one that was tried goes, whatever is left stays.
        expect(methodsAfter(['totp', 'backup'], 'unavailable', 'backup')).toEqual(['totp']);
        expect(methodsAfter(['totp'], 'unavailable', 'totp')).toEqual([]);
    });
});
