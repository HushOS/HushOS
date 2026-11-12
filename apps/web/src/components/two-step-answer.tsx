import type { StepMethod } from '@hushos/auth/api';
import { cn } from 'cn';
import { useId } from 'react';
import { authLink } from '@/components/auth-layout';
import { SECRET_FIELD } from '@/components/password-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { phraseWords, type StepDraft, type StepUp } from '@/lib/two-step';

/*
 * What a person answers a second step with (docs/two-step-design.md 4): a code from their
 * authenticator app, a backup code, or their recovery phrase. One field at a time, with the
 * other ways offered beneath it in plain words. The same fields serve the sign-in page, the
 * unlock form and the dialogs that change the account.
 */

const labels: Record<StepMethod, string> = {
    totp: 'Code from your authenticator app',
    backup: 'Backup code',
    phrase: 'Recovery phrase',
};
const others: Record<StepMethod, string> = {
    totp: 'Use your authenticator app',
    backup: 'Use a backup code',
    phrase: 'Use your recovery phrase',
};
const hints: Record<StepMethod, string> = {
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
}) {
    const id = useId();
    // A method that stopped being offered (a paused app) gives way to the next one.
    const method = methods.includes(draft.method) ? draft.method : methods[0];
    if (!method)
        return (
            <p role="alert" className="text-sm text-destructive">
                This browser can’t answer this account’s second step. Reload the page to update
                HushOS, then try again.
            </p>
        );
    const describedBy = `${id}-note`;
    const field = 'font-mono text-[15px]';
    const count = phraseWords(draft.phrase).length;
    return (
        <div className="flex flex-col gap-2.5" data-step-method={method}>
            <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor={id} className="text-[13px] font-semibold">
                        {labels[method]}
                    </label>
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
                        value={draft.totp}
                        disabled={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({
                                ...draft,
                                method,
                                totp: event.target.value.replace(/[^\d\s]/g, ''),
                            })
                        }
                        className={cn(field, 'tracking-[0.2em]')}
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
                        value={draft.backup}
                        disabled={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({ ...draft, method, backup: event.target.value.toUpperCase() })
                        }
                        className={cn(field, 'tracking-[0.08em]')}
                        {...SECRET_FIELD}
                    />
                )}
                {method === 'phrase' && (
                    <Textarea
                        id={id}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field the step asks for
                        autoFocus={focus}
                        autoComplete="off"
                        value={draft.phrase}
                        disabled={disabled}
                        aria-invalid={Boolean(error)}
                        aria-describedby={describedBy}
                        onChange={(event) =>
                            onChange({ ...draft, method, phrase: event.target.value })
                        }
                        className={cn(field, 'min-h-24')}
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
                    {methods
                        .filter((other) => other !== method)
                        .map((other) => (
                            <button
                                key={other}
                                type="button"
                                disabled={disabled}
                                onClick={() => onChange({ ...draft, method: other })}
                                className={cn(authLink, 'disabled:opacity-60')}
                            >
                                {others[other]}
                            </button>
                        ))}
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
            />
        </div>
    );
}
