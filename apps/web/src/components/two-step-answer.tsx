import type { StepMethod } from '@hushos/auth/api';
import { cn } from 'cn';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { DeviceAsk } from '@/components/device-ask';
import { SECRET_FIELD } from '@/components/password-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { preloadPasskeys } from '@/lib/passkeys';
import { phraseWords, stepNote, type StepDraft, type StepUp } from '@/lib/two-step';

/*
 * What a person answers a second step with (docs/two-step-design.md 4, 12): their passkey or
 * security key, a code from their authenticator app, another of their devices, a backup code,
 * or their recovery phrase.
 * One way at a time, opening on the account's usual one, with the rest behind Use another
 * way. The same fields serve the sign-in page, the unlock form and the dialogs that change
 * the account. A passkey has no field: the form's own button asks for it.
 */

const labels: Record<StepMethod, string> = {
    webauthn: 'Passkey or security key',
    totp: 'Code from your authenticator app',
    device: 'Another device',
    backup: 'Backup code',
    phrase: 'Recovery phrase',
};
const others: Record<StepMethod, string> = {
    webauthn: 'Use your passkey or security key',
    totp: 'Use your authenticator app',
    device: 'Use another device',
    backup: 'Use a backup code',
    phrase: 'Use your recovery phrase',
};
/* Another device has no field: the request's own panel says what to do. */
const hints: Record<StepMethod, string> = {
    webauthn: 'Your browser asks for it when you continue.',
    // The label and the field say what to type: nothing beneath but what was wrong with it.
    totp: '',
    device: '',
    backup: '',
    phrase: '',
};

/* The quiet text actions under the step: Use another way, and the sign-in's Start again. */
export const stepAction =
    'h-9 cursor-pointer rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60';

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
    ask,
    start = false,
    actions,
    aside,
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
    /* The step itself, for asking another device: its token, and what it is for. */
    ask?: { token: string; purpose: string };
    /* The usual way starts as the form opens: another device is asked without a press. */
    start?: boolean;
    /* The form's own button, under the field: put away with it while another way is chosen. */
    actions?: ReactNode;
    /* Beside Use another way, at the end of its row: the sign-in's Start again. */
    aside?: ReactNode;
}) {
    const id = useId();
    // The other ways stay behind one button until asked for; choosing one puts them away again.
    const [choosing, setChoosing] = useState(false);
    // Opened from the keyboard, the cursor goes into the list: it comes before Back in the page.
    const list = useRef<HTMLUListElement>(null);
    const [opened, setOpened] = useState(0);
    useEffect(() => {
        if (opened) list.current?.querySelector('button')?.focus();
    }, [opened]);
    // Another device is asked on a press, or as the sign-in step opens on it (`start`). Choosing
    // it among the other ways is that press; a dialog that merely opened on it shows a button first.
    const [pressed, setPressed] = useState(start);
    // The library a key is asked through is fetched once a key is on offer, ahead of the press.
    const keyed = methods.includes('webauthn');
    useEffect(() => {
        if (keyed) preloadPasskeys();
    }, [keyed]);
    const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    // The draft follows the methods on offer (`draftFor`); this only guards a render between.
    const method = methods.includes(draft.method) ? draft.method : methods[0];
    // A refusal, or a way taken away, puts the list back too: the field it shows is the news.
    // Noticed while rendering (React's "adjusting state when a prop changes"), not in an effect.
    const [seen, setSeen] = useState({ refocus, method });
    if (seen.refocus !== refocus || seen.method !== method) {
        setSeen({ refocus, method });
        setChoosing(false);
    }
    // With one way left there is nothing to choose: never a list with no way back out of it.
    const open = choosing && methods.length > 1;
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
            <div className="flex flex-col gap-2.5">
                <p role="alert" className="text-sm text-destructive">
                    {reload
                        ? 'This page can’t answer this account’s second step. Reload it to get the latest HushOS, then sign in again.'
                        : 'There is no other way to answer this step from here right now. Start again in a while.'}
                </p>
                {aside && <div className="flex min-h-9 items-center text-sm">{aside}</div>}
            </div>
        );
    const describedBy = `${id}-note`;
    // What is typed has a label of its own. A passkey has one only where the form's button is
    // a dialog's Continue: on the sign-in page its button says Use your passkey. Another
    // device's panel says what it is.
    const typed = method === 'totp' || method === 'backup' || method === 'phrase';
    const bare = method === 'device' || (method === 'webauthn' && Boolean(actions));
    // The phrase, monospaced at the same size at every width.
    const mono = 'font-mono text-[15px] sm:text-[15px]';
    const count = phraseWords(draft.phrase).length;
    return (
        <div className="flex flex-col gap-2.5" data-step-method={method}>
            {note && (
                <p data-step-note className="text-[13px] text-muted-foreground">
                    {note}
                </p>
            )}
            {/*
             * Put away while the other ways are chosen from only where the form's button goes with
             * it (`actions`, the sign-in page). A dialog's own button stays pressable, and what it
             * checks (an empty code, say) must stay in sight.
             */}
            <div className="flex flex-col gap-1.5" hidden={open && Boolean(actions)}>
                {!bare && (
                    <div className="flex items-baseline justify-between gap-3">
                        {typed ? (
                            <label htmlFor={id} className="text-[13px] font-semibold">
                                {labels[method]}
                            </label>
                        ) : (
                            <span className="text-[13px] font-semibold">{labels[method]}</span>
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
                )}
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
                        className="h-12 font-mono text-xl tracking-[0.3em] sm:text-xl"
                        {...SECRET_FIELD}
                    />
                )}
                {method === 'device' && ask && (
                    <DeviceAsk
                        key={ask.token}
                        token={ask.token}
                        purpose={ask.purpose}
                        approved={draft.device}
                        auto={pressed}
                        disabled={disabled}
                        onApproved={(requestId) =>
                            onChange({ ...draft, method: 'device', device: requestId })
                        }
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
                        className="h-12 font-mono text-lg tracking-[0.08em] sm:text-lg"
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
                {(error || (!bare && hints[method])) && (
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
                )}
            </div>
            {!open && actions}
            {open && (
                <ul
                    ref={list}
                    aria-label="Other ways"
                    className="divide-y divide-rule overflow-hidden rounded-lg border border-rule"
                >
                    {methods
                        .filter((other) => other !== method)
                        .map((other) => (
                            <li key={other}>
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => {
                                        setChoosing(false);
                                        setPressed(other === 'device');
                                        onChange({ ...draft, method: other });
                                    }}
                                    className="flex h-11 w-full items-center justify-between gap-3 px-3.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60"
                                >
                                    {others[other]}
                                    <ChevronRightIcon
                                        aria-hidden
                                        className="size-4 text-muted-foreground"
                                    />
                                </button>
                            </li>
                        ))}
                </ul>
            )}
            {(methods.length > 1 || aside) && (
                <div className="flex min-h-9 items-center justify-between gap-3 text-sm">
                    {methods.length > 1 && (
                        <button
                            type="button"
                            disabled={disabled}
                            aria-expanded={open}
                            onClick={() => {
                                if (!open) setOpened((count) => count + 1);
                                setChoosing(!open);
                            }}
                            className={stepAction}
                        >
                            {open ? 'Back' : 'Use another way'}
                        </button>
                    )}
                    {aside && <div className="ml-auto">{aside}</div>}
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
                ask={{ token: step.challenge.token, purpose: step.purpose }}
            />
        </div>
    );
}
