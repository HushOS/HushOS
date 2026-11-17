import type { StepChallenge } from '@hushos/auth/api';
import { cn } from 'cn';
import { StepFailure } from '@hushos/auth/client';
import { useEffect, useRef, useState } from 'react';
import { AuthNote } from '@/components/auth-layout';
import { StepFields, stepAction } from '@/components/two-step-answer';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { whenPageLeaves } from '@/lib/new-phrase';
import { cancelPasskey } from '@/lib/passkeys';
import { whenBrowserLocks } from '@/lib/show-new-phrase';
import { cue } from '@/lib/sounds';
import {
    afterRefusal,
    draftAnswer,
    draftError,
    draftFor,
    emptyDraft,
    methodsAfter,
    stepNote,
} from '@/lib/two-step';

/*
 * The second step of a sign-in (docs/two-step-design.md 4, 12): the password was right, and
 * the account asks for its passkey, a code, a backup code or the recovery phrase before
 * anything is handed over. Another device answers by approving: this page shows a code for
 * it, and signs in by itself once that device has approved. It opens on the account's usual way. A passkey is a button, Use
 * your passkey: the browser's sheet opens on the press, never when the page loads. A wrong answer stays here and can be tried again. A step that is over, or a reply
 * that never arrived, goes back to the password with the reason (`onOver`): the person is
 * never left on a form that can no longer be answered.
 */
/* The step whose usual way this page already started: once per step, however often React mounts it. */
let started = '';

export function SignInStep({
    challenge,
    onSignedIn,
    onOver,
    owner,
    size = 'lg',
}: {
    challenge: StepChallenge;
    onSignedIn: () => void | Promise<void>;
    /* Back to the password: with why, or with nothing when the person chose to start again. */
    onOver: (reason: string) => void;
    /* The form that started this sign-in (`LoginOptions.owner`): what it leaves is its own. */
    owner?: object;
    /* `lg` on the sign-in page, where the action spans the card; `default` in a dialog. */
    size?: 'lg' | 'default';
}) {
    const [methods, setMethods] = useState(challenge.methods);
    const [draft, setDraft] = useState(() => emptyDraft(challenge.methods));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [refused, setRefused] = useState('');
    const [refocus, setRefocus] = useState(0);
    // A lock or a sign-out, here or in another tab, ends the step (the worker has let go of it)
    // and takes what was typed off the screen: a recovery phrase never stays on a locked page.
    useEffect(
        () => {
            const locked = whenBrowserLocks(() => {
                setDraft(emptyDraft(challenge.methods));
                onOver('This browser was locked. Sign in again.');
            });
            // Leaving the page takes what was typed with it: one brought back by the Back button
            // would show it again. The step itself is let go by the auth client on the same event.
            const leaving = whenPageLeaves(() => setDraft(emptyDraft(challenge.methods)));
            return () => {
                locked();
                leaving();
            };
        },
        // Only while this step is on screen.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );
    // Another device approved: the sign-in goes on by itself, as the person is watching the
    // other screen by then. Each approval is sent once.
    const sent = useRef('');
    useEffect(() => {
        if (draft.method !== 'device' || !draft.device || sent.current === draft.device) return;
        sent.current = draft.device;
        void submit();
        // Only when an approval arrives.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.method, draft.device]);
    /*
     * The usual way starts by itself as the step opens: a passkey's sheet, or the request to
     * another device (StepFields' `start`). A sheet that was closed, or that the browser would
     * not open without a press (Safari), says nothing: Use your passkey asks again.
     */
    // The answer the step started by itself, while its sheet is open: the page stays usable
    // meanwhile. Choosing another way or leaving closes it, and an answer the person sends waits
    // until it has (the sign-in takes one answer at a time).
    const auto = useRef<Promise<void> | null>(null);
    const signedIn = useRef(false);
    async function settle() {
        while (auto.current) {
            // Asked again until it ends: the sheet may not have opened yet when first asked.
            void cancelPasskey();
            await Promise.race([auto.current, new Promise((done) => setTimeout(done, 150))]);
        }
    }
    useEffect(() => {
        if (started !== challenge.token && methods[0] === 'webauthn') {
            started = challenge.token;
            const running = submit(true).finally(() => {
                if (auto.current === running) auto.current = null;
            });
            auto.current = running;
        }
        return () => {
            void settle();
        };
        // Once, as the step opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        if (draft.method !== 'webauthn') void settle();
    }, [draft.method]);
    async function submit(quiet = false) {
        const invalid = draftError(draft);
        setError(invalid);
        setRefused('');
        if (invalid) {
            setRefocus((count) => count + 1);
            return;
        }
        // Opened by itself, the sheet holds nothing else on the page back.
        if (!quiet) {
            setPending(true);
            await settle();
            // The sheet that opened by itself was answered meanwhile: signed in already.
            if (signedIn.current) return;
        }
        try {
            await authClient.answerStep(draftAnswer(draft));
            signedIn.current = true;
            cue('success');
            // Kept busy while what signing in opens takes over.
            await onSignedIn();
        } catch (cause) {
            // The sheet the page opened by itself, closed or refused: nothing went wrong yet.
            if (quiet && cause instanceof StepFailure && cause.reason === 'wrong') return;
            cue('error');
            if (cause instanceof StepFailure && cause.again) {
                // What is offered and what the draft is for change together: an answer is
                // never sent for a method that is no longer shown.
                const left = methodsAfter(methods, cause.reason, draft.method);
                setMethods(left);
                setDraft((typed) => draftFor(afterRefusal(typed, cause.reason), left));
                setRefocus((count) => count + 1);
                // A wrong answer is the field's own error; anything else is said above it.
                if (cause.reason === 'wrong') setError(cause.message);
                else setRefused(cause.message);
            } else {
                // Over for a reason that was not the step's own (a sign-out elsewhere, say):
                // what the sign-in held is let go before the password is asked for again.
                authClient.cancelStep(owner);
                onOver(authError(cause));
            }
        } finally {
            if (!quiet) setPending(false);
        }
    }
    const wide = size === 'lg';
    const startOver = () => {
        authClient.cancelStep(owner);
        onOver('');
    };
    const startAgain = wide ? (
        <button
            type="button"
            disabled={pending}
            onClick={startOver}
            className={cn(stepAction, 'font-normal text-muted-foreground hover:text-foreground')}
        >
            Start again
        </button>
    ) : (
        <Button type="button" variant="outline" disabled={pending} onClick={startOver}>
            Start again
        </Button>
    );
    /*
     * Another device has no button of this form's: its approval signs in. Only when that
     * sign-in got no answer (the approval is still held) is there one, to send the same
     * approval again.
     */
    const submitButton = methods.length > 0 &&
        (draft.method !== 'device' || pending || draft.device !== '') && (
            <Button
                type="submit"
                size={size}
                disabled={pending}
                className={wide ? 'h-11 w-full text-[15px]' : undefined}
            >
                {pending
                    ? 'Checking'
                    : draft.method === 'webauthn'
                      ? 'Use your passkey'
                      : draft.method === 'device'
                        ? 'Try again'
                        : 'Continue'}
            </Button>
        );
    return (
        <form
            noValidate
            aria-busy={pending}
            data-step-form
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <div className="flex flex-col gap-4">
                {refused && <AuthNote tone="warning">{refused}</AuthNote>}
                <StepFields
                    methods={methods}
                    draft={draft}
                    onChange={(next) => {
                        setDraft(next);
                        setError('');
                    }}
                    error={error}
                    disabled={pending}
                    focus
                    refocus={refocus}
                    reload={challenge.methods.length === 0}
                    note={stepNote(challenge, 'sign-in')}
                    ask={{ token: challenge.token, purpose: 'login' }}
                    start
                    // On the sign-in page the button spans the card under the field, with Use
                    // another way and Start again in one row beneath it.
                    actions={
                        wide && submitButton ? (
                            <div className="mt-1">{submitButton}</div>
                        ) : undefined
                    }
                    aside={wide ? startAgain : undefined}
                />
                {!wide && (
                    <div className="flex justify-end gap-2">
                        {startAgain}
                        {submitButton}
                    </div>
                )}
            </div>
        </form>
    );
}
