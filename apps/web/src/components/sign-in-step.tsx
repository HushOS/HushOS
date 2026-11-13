import type { StepChallenge } from '@hushos/auth/api';
import { StepFailure } from '@hushos/auth/client';
import { useEffect, useState } from 'react';
import { AuthNote } from '@/components/auth-layout';
import { StepFields } from '@/components/two-step-answer';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { whenBrowserLocks } from '@/lib/show-new-phrase';
import { cue } from '@/lib/sounds';
import { draftAnswer, draftError, draftFor, emptyDraft, methodsAfter } from '@/lib/two-step';

/*
 * The second step of a sign-in (docs/two-step-design.md 4): the password was right, and the
 * account asks for a code, a backup code or the recovery phrase before anything is handed
 * over. A wrong answer stays here and can be tried again. A step that is over, or a reply
 * that never arrived, goes back to the password with the reason (`onOver`): the person is
 * never left on a form that can no longer be answered.
 */
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
        () =>
            whenBrowserLocks(() => {
                setDraft(emptyDraft(challenge.methods));
                onOver('This browser was locked. Sign in again.');
            }),
        // Only while this step is on screen.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );
    async function submit() {
        const invalid = draftError(draft);
        setError(invalid);
        setRefused('');
        if (invalid) {
            setRefocus((count) => count + 1);
            return;
        }
        setPending(true);
        try {
            await authClient.answerStep(draftAnswer(draft));
            cue('success');
            // Kept busy while what signing in opens takes over.
            await onSignedIn();
        } catch (cause) {
            cue('error');
            if (cause instanceof StepFailure && cause.again) {
                // What is offered and what the draft is for change together: an answer is
                // never sent for a method that is no longer shown.
                const left = methodsAfter(methods, cause.reason, draft.method);
                setMethods(left);
                setDraft((typed) => draftFor(typed, left));
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
            setPending(false);
        }
    }
    const wide = size === 'lg';
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
                />
                <div className={wide ? 'mt-1 flex flex-col gap-3' : 'flex justify-end gap-2'}>
                    {!wide && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                                authClient.cancelStep(owner);
                                onOver('');
                            }}
                        >
                            Start again
                        </Button>
                    )}
                    {methods.length > 0 && (
                        <Button
                            type="submit"
                            size={size}
                            disabled={pending}
                            className={wide ? 'h-11 w-full text-[15px]' : undefined}
                        >
                            {pending ? 'Checking' : 'Continue'}
                        </Button>
                    )}
                    {wide && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="lg"
                            className="h-11 w-full text-[15px]"
                            disabled={pending}
                            onClick={() => {
                                authClient.cancelStep(owner);
                                onOver('');
                            }}
                        >
                            Start again
                        </Button>
                    )}
                </div>
            </div>
        </form>
    );
}
