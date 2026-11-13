import type { StepChallenge, StepInput, StepMethod, StepPurpose } from '@hushos/auth/api';
import { stepFailure, stepRefused, type StepAnswer } from '@hushos/auth/client';
import { twoStepEnv } from '@hushos/env/two-step';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { useCallback, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { whenPageLeaves } from '@/lib/new-phrase';
import { whenBrowserLocks } from '@/lib/show-new-phrase';

/*
 * Two-step sign-in in the web app (docs/two-step-design.md): whether this server offers it,
 * what the account's settings show, and what a person types to answer a step, wherever a
 * step is asked (signing in, unlocking, and before a security change).
 */

/* Whether this server lets accounts turn the step on (TWO_STEP_ENABLED): asked once and kept. */
const getTwoStepEnabledServerFn = createServerFn().handler(() => twoStepEnv.TWO_STEP_ENABLED);
const twoStepEnabledQueryOptions = queryOptions({
    queryKey: ['two-step', 'enabled'],
    queryFn: () => getTwoStepEnabledServerFn(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
});
/* False until the server has answered: nothing about the step shows on a server that has it off. */
export function useTwoStepEnabled() {
    return useQuery(twoStepEnabledQueryOptions).data === true;
}

export const twoStepQueryOptions = queryOptions({
    queryKey: ['account', 'two-step'],
    queryFn: () => authClient.twoStep(),
    staleTime: 15_000,
    retry: false,
});
export const securityEventsQueryOptions = queryOptions({
    queryKey: ['account', 'security-events'],
    queryFn: async () => (await authClient.securityEvents()).events,
    staleTime: 15_000,
    retry: false,
});

/*
 * What a person has typed for a step: one field for each method, so switching loses nothing.
 * A passkey or security key has no field: its answer is made when the step is sent.
 */
export type StepDraft = { method: StepMethod; totp: string; backup: string; phrase: string };
export const emptyDraft = (methods: readonly StepMethod[]): StepDraft => ({
    method: methods[0] ?? 'totp',
    totp: '',
    backup: '',
    phrase: '',
});
export const phraseWords = (text: string) => text.trim().toLowerCase().split(/\s+/).filter(Boolean);
/* Why the draft cannot be sent yet, in the field's own words; empty when it can. */
export function draftError(draft: StepDraft) {
    if (draft.method === 'webauthn') return '';
    if (draft.method === 'totp')
        return /^\d{6}$/.test(draft.totp.replace(/\s/g, ''))
            ? ''
            : 'Enter the 6-digit code from your authenticator app.';
    if (draft.method === 'backup')
        return draft.backup.replace(/[\s-]/g, '').length === 10
            ? ''
            : 'Enter one of your backup codes, 10 characters.';
    const count = phraseWords(draft.phrase).length;
    return count === 24 ? '' : `Enter all 24 words of your recovery phrase. ${count} so far.`;
}
export function draftAnswer(draft: StepDraft): StepAnswer {
    if (draft.method === 'webauthn') return { kind: 'webauthn' };
    if (draft.method === 'totp') return { kind: 'totp', code: draft.totp.replace(/\s/g, '') };
    if (draft.method === 'backup') return { kind: 'backup', code: draft.backup.trim() };
    return { kind: 'phrase', phrase: phraseWords(draft.phrase).join(' ') };
}

/*
 * The draft, for the methods now on offer: when the method it was typed for is no longer
 * among them (a paused app, a spent budget), it moves to the first that is. What is shown and
 * what is sent must be the same method, or a code typed earlier goes out under a field the
 * person can no longer see.
 */
export function draftFor(draft: StepDraft, methods: readonly StepMethod[]): StepDraft {
    const first = methods[0];
    return methods.includes(draft.method) || !first ? draft : { ...draft, method: first };
}

/*
 * After an answer was refused: which methods are still worth offering on this step.
 * - A paused app is not (`frozen`).
 * - After too many wrong codes (`limited`) only a passkey or security key and the recovery
 *   phrase are: the app's codes and the backup codes share one budget, and those two have
 *   none. Without either nothing is: the budget lasts 15 minutes and a step five, so a code
 *   field left on screen could only be refused again.
 * - A method the server cannot check right now (`unavailable`) is withdrawn alone, the one
 *   that was `tried`: the app's secret and the backup codes can sit under different keys, so
 *   one being unreadable says nothing of the other.
 */
export function methodsAfter(
    methods: readonly StepMethod[],
    reason: string,
    tried: StepMethod,
): StepMethod[] {
    if (reason === 'frozen') return methods.filter((method) => method !== 'totp');
    if (reason === 'unavailable') return methods.filter((method) => method !== tried);
    if (reason === 'limited')
        return methods.filter((method) => method === 'phrase' || method === 'webauthn');
    return [...methods];
}

/*
 * The second step before a change this session makes (a new password, a rotation, deleting the
 * account, a change to the step itself). `ask` finds out whether the account needs one and,
 * if so, shows the fields; `prove` turns what was typed into what the change carries; `failed`
 * says whether an error was the step's, and puts its words beside the fields.
 */
export function useStepUp(purpose: StepPurpose) {
    const enabled = useTwoStepEnabled();
    const status = useQuery({ ...twoStepQueryOptions, enabled });
    const [challenge, setChallenge] = useState<StepChallenge | null>(null);
    const [methods, setMethods] = useState<StepMethod[]>([]);
    const [draft, setDraft] = useState<StepDraft>(emptyDraft([]));
    const [error, setError] = useState('');
    const [tried, setTried] = useState(false);
    // Raised when an answer was refused, so the field takes the cursor back.
    const [refocus, setRefocus] = useState(0);
    // A lock or a sign-out, here or in another tab, takes what was typed (a recovery phrase,
    // perhaps) off the screen with the step itself: the page stays mounted when it locks.
    // So does leaving the page: one brought back by the Back button would show it again.
    useEffect(() => {
        const forget = () => {
            setChallenge(null);
            setMethods([]);
            setDraft(emptyDraft([]));
            setTried(false);
        };
        const locked = whenBrowserLocks(forget);
        const leaving = whenPageLeaves(forget);
        return () => {
            locked();
            leaving();
        };
    }, []);
    const start = useCallback(
        async (keep = false) => {
            const next = await authClient.stepChallenge(purpose);
            setChallenge(next);
            setMethods(next?.methods ?? []);
            setTried(false);
            if (next)
                setDraft((typed) =>
                    keep ? draftFor(typed, next.methods) : emptyDraft(next.methods),
                );
            return next;
        },
        [purpose],
    );
    return {
        challenge,
        methods,
        draft,
        error,
        refocus,
        /* The field's own complaint, once the person has tried to send it. */
        invalid: tried && challenge ? draftError(draft) : '',
        setDraft: (next: StepDraft) => {
            setDraft(next);
            setError('');
        },
        /*
         * Before the change: true when a step must be answered first and was not asked yet,
         * so the form shows its fields and waits. On a server with the step off the answer
         * is no without asking: if an account there has the step, the change's own refusal
         * (`failed`) brings the fields up.
         */
        ask: async () => {
            if (challenge) return false;
            if (!enabled || status.data?.on === false) return false;
            return (await start()) !== null;
        },
        /* What the change carries, or null when what was typed cannot be sent yet. */
        prove: async (): Promise<StepInput | undefined | null> => {
            if (!challenge) return undefined;
            setTried(true);
            if (draftError(draft)) {
                setRefocus((count) => count + 1);
                return null;
            }
            return authClient.proveStep(challenge, draftAnswer(draft));
        },
        /* True when the error was about the step: its words are shown beside the fields. */
        failed: async (cause: unknown) => {
            const code = (cause as { code?: unknown } | null)?.code;
            // A mistyped phrase is refused on this device, before anything is sent.
            const typed = challenge && (cause as { kept?: unknown } | null)?.kept === true;
            if (!stepRefused(cause) && !typed) return false;
            const failure = stepFailure(cause);
            setError(code === 'two-step' && !challenge ? '' : authError(cause));
            if (code === 'two-step' || !failure.again) {
                // The step was not asked yet, or this one is over: a new one, what was typed kept.
                await start(true).catch(() => setChallenge(null));
            } else {
                // What is offered and what the draft is for change together.
                const left = methodsAfter(methods, failure.reason, draft.method);
                setMethods(left);
                setDraft((typed) => draftFor(typed, left));
            }
            setRefocus((count) => count + 1);
            return true;
        },
        reset: () => {
            setChallenge(null);
            setMethods([]);
            setDraft(emptyDraft([]));
            setError('');
            setTried(false);
        },
    };
}
export type StepUp = ReturnType<typeof useStepUp>;

/*
 * What a step says above its fields when the server left something out (docs/two-step-design.md
 * 12). One line, never the reason: someone who has only the password learns nothing about the
 * owner's devices from it.
 * - A way was left out though this browser named every kind it knows: a newer HushOS has it.
 * - Otherwise, the account's usual way is not first: it can't be used here, whyever.
 */
export function stepNote(
    challenge: Pick<StepChallenge, 'withheld' | 'defaultUnavailable'>,
    flow: 'sign-in' | 'change',
) {
    if (challenge.withheld && authClient.canUsePasskeys())
        return 'Update HushOS to use your passkey or another device.';
    if (challenge.defaultUnavailable)
        return flow === 'sign-in'
            ? 'Your usual way isn’t available for this sign-in.'
            : 'Your usual way isn’t available for this change.';
    return '';
}
