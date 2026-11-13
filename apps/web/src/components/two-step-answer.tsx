import type { StepMethod } from '@hushos/auth/api';
import { cn } from 'cn';
import { useEffect, useId, useRef, useState } from 'react';
import { authLink } from '@/components/auth-layout';
import { SECRET_FIELD } from '@/components/password-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { preloadPasskeys } from '@/lib/passkeys';
import { phraseWords, stepNote, type StepDraft, type StepUp } from '@/lib/two-step';

/*
 * What a person answers a second step with (docs/two-step-design.md 4, 12): their passkey or
 * security key, a code from their authenticator app, a backup code, or their recovery phrase.
 * One way at a time, opening on the account's usual one, with the rest behind Use another
 * way. The same fields serve the sign-in page, the unlock form and the dialogs that change
 * the account. A passkey has no field: the form's own button asks for it.
 */

const labels: Record<StepMethod, string> = {
    webauthn: 'Passkey or security key',
    totp: 'Code from your authenticator app',
    backup: 'Backup code',
    phrase: 'Recovery phrase',
};
const others: Record<StepMethod, string> = {
    webauthn: 'Use your passkey or security key',
    totp: 'Use your authenticator app',
    backup: 'Use a backup code',
    phrase: 'Use your recovery phrase',
};
const hints: Record<StepMethod, string> = {
    webauthn: 'Your browser asks for it when you continue.',
    totp: 'The 6-digit code. It changes every 30 seconds.',
    backup: 'One of the ten codes you saved. Each works once.',
    phrase: 'All 24 words, in order. They stay on this device.',
};

export function StepFields({
    methods,
    draft,
    onChange,
    error,
    disabled,
    focus = false,
    refocus = 0,
    reload = false,
    note = '',
}: {
    /* What can answer this step, in the order to offer it. */
    methods: readonly StepMethod[];
    draft: StepDraft;
    onChange: (draft: StepDraft) => void;
    /* What was wrong with the last answer, or with what is typed. */
    error?: string;
    disabled?: boolean;
    /* Put the cursor in the field as it appears: where the step is the whole form. */
    focus?: boolean;
    /* Raised after an answer was refused: the field takes the cursor back, its text selected. */
    refocus?: number;
    /*
     * The step offered nothing this page can answer from the start, which a newer page might:
     * only then is reloading worth suggesting. When the ways ran out after refusals, it is not.
     */
    reload?: boolean;
    /* One line above the fields: the usual way is not on offer, or a newer HushOS has more. */
    note?: string;
}) {
    const id = useId();
    // The other ways stay behind one button until asked for; choosing one puts them away again.
    const [choosing, setChoosing] = useState(false);
    // The library a key is asked through is fetched once a key is on offer, ahead of the press.
    const keyed = methods.includes('webauthn');
    useEffect(() => {
        if (keyed) preloadPasskeys();
    }, [keyed]);
    const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    // The draft follows the methods on offer (`draftFor`); this only guards a render between.
    const method = methods.includes(draft.method) ? draft.method : methods[0];
    // After the person switched to another way, or the one they used was withdrawn, or an
    // answer was refused: the cursor goes to the field now shown, so the next thing typed
    // lands there and a screen reader is not left on a control that is gone.
    const shown = useRef(method);
    const asked = useRef(refocus);
    useEffect(() => {
        if (shown.current === method && asked.current === refocus) return;
        const refused = asked.current !== refocus;
        shown.current = method;
        asked.current = refocus;
        field.current?.focus();
        if (refused) field.current?.select();
    }, [method, refocus]);
    if (!method)
        return (
            <p role="alert" className="text-sm text-destructive">
                {reload
                    ? 'This page can’t answer this account’s second step. Reload it to get the latest HushOS, then sign in again.'
                    : 'There is no other way to answer this step from here right now. Start again in a while.'}
            </p>
        );
    const describedBy = `${id}-note`;
    const mono = 'font-mono text-[15px]';
    const count = phraseWords(draft.phrase).length;
    return (
        <div className="flex flex-col gap-2.5" data-step-method={method}>
            {note && (
                <p data-step-note className="text-[13px] text-muted-foreground">
                    {note}
                </p>
            )}
            <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                    {method === 'webauthn' ? (
                        <span className="text-[13px] font-semibold">{labels[method]}</span>
                    ) : (
                        <label htmlFor={id} className="text-[13px] font-semibold">
                            {labels[method]}
                        </label>
                    )}
                    {method === 'phrase' && (
                        <span
                            className={cn(
                                'text-[13px] tabular-nums',
                                count === 24 ? 'text-success' : 'text-muted-foreground',
                            )}
                        >
                            {count} of 24 words
                        </span>
                    )}
                </div>
                {method === 'totp' && (
                    <Input
                        id={id}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field the step asks for
                        autoFocus={focus}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={7}
                        placeholder="000000"
                        ref={field}
                        value={draft.totp}
                        // Read-only while it is checked, not disabled: the cursor stays in it.
                        readOnly={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({
                                ...draft,
                                method,
                                totp: event.target.value.replace(/[^\d\s]/g, ''),
                            })
                        }
                        className={cn(mono, 'tracking-[0.2em]')}
                        {...SECRET_FIELD}
                    />
                )}
                {method === 'backup' && (
                    <Input
                        id={id}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field the step asks for
                        autoFocus={focus}
                        autoComplete="off"
                        maxLength={16}
                        placeholder="XXXXX-XXXXX"
                        ref={field}
                        value={draft.backup}
                        readOnly={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({ ...draft, method, backup: event.target.value.toUpperCase() })
                        }
                        className={cn(mono, 'tracking-[0.08em]')}
                        {...SECRET_FIELD}
                    />
                )}
                {method === 'phrase' && (
                    <Textarea
                        id={id}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field the step asks for
                        autoFocus={focus}
                        autoComplete="off"
                        ref={field}
                        value={draft.phrase}
                        readOnly={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({ ...draft, method, phrase: event.target.value })
                        }
                        className={cn(mono, 'min-h-24')}
                        {...SECRET_FIELD}
                    />
                )}
                <p
                    id={describedBy}
                    role={error ? 'alert' : undefined}
                    className={cn(
                        'text-[13px]',
                        error ? 'text-destructive' : 'text-muted-foreground',
                    )}
                >
                    {error || hints[method]}
                </p>
            </div>
            {methods.length > 1 && (
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                    {choosing ? (
                        methods
                            .filter((other) => other !== method)
                            .map((other) => (
                                <button
                                    key={other}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => {
                                        setChoosing(false);
                                        onChange({ ...draft, method: other });
                                    }}
                                    className={cn(authLink, 'disabled:opacity-60')}
                                >
                                    {others[other]}
                                </button>
                            ))
                    ) : (
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={() => setChoosing(true)}
                            className={cn(authLink, 'disabled:opacity-60')}
                        >
                            Use another way
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/*
 * The step inside a dialog that changes the account: shown once the account turns out to need
 * it, beneath the dialog's own fields, and answered with the same press that makes the change.
 */
export function StepUpFields({ step, disabled }: { step: StepUp; disabled?: boolean }) {
    if (!step.challenge) return null;
    return (
        <div className="flex flex-col gap-2.5" data-step-up>
            <p className="text-[13px] text-muted-foreground">
                Two-step sign-in is on, so this needs your second step too.
            </p>
            <StepFields
                methods={step.methods}
                draft={step.draft}
                onChange={step.setDraft}
                error={step.invalid || step.error}
                disabled={disabled}
                refocus={step.refocus}
                note={stepNote(step.challenge, 'change')}
            />
        </div>
    );
}
