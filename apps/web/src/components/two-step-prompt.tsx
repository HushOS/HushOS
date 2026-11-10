import type { AskStep, StepAnswer, StepAnswerKind, StepRequest } from '@hushos/auth/client';
import { cn } from 'cn';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { authLink } from '@/components/auth-layout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { authError } from '@/lib/form';
import { WORDS } from '@/lib/recovery-kit';

/*
 * The second step, asked for (docs/two-step-design.md 4): a code from the authenticator app,
 * a backup code, or the recovery phrase. The auth client owns the protocol and hands this
 * screen one request at a time (`ask`): which methods can answer now, and why it is asking
 * again. The same field serves sign-in, the unlock form and the dialogs that change the
 * account; each draws its own buttons around it.
 */

/* The server's words for a step token that ran out, said when the screen's own clock gets there first. */
export const STEP_TIMED_OUT = 'Your sign-in timed out. Sign in again.';

export const stepWords: Record<
    StepAnswerKind,
    { title: string; about: string; label: string; hint: string; choose: string }
> = {
    totp: {
        title: 'Enter your code',
        about: 'Open your authenticator app and enter the code it shows for HushOS.',
        label: 'Code from your authenticator app',
        hint: 'Six digits. A new one every 30 seconds.',
        choose: 'Use your authenticator app',
    },
    backup: {
        title: 'Use a backup code',
        about: 'Enter one of the backup codes you saved when you turned on two-step sign-in.',
        label: 'Backup code',
        hint: 'Each code works once.',
        choose: 'Use a backup code',
    },
    phrase: {
        title: 'Use your recovery phrase',
        about: 'Enter the 24 words from your recovery kit. They stay on this device.',
        label: 'Recovery phrase',
        hint: `All ${WORDS} words, in order.`,
        choose: 'Use your recovery phrase',
    },
};

export function useStepPrompt({ onExpired }: { onExpired?: () => void } = {}) {
    const [request, setRequest] = useState<StepRequest | null>(null);
    const [kind, setKind] = useState<StepAnswerKind>('totp');
    const [value, setValue] = useState('');
    const [checking, setChecking] = useState(false);
    // Each time the client asks: the field takes focus again, and a repeated error is said again.
    const [round, setRound] = useState(0);
    const resolver = useRef<((answer: StepAnswer | null) => void) | null>(null);
    const shown = useRef<StepAnswerKind>('totp');
    const answered = useRef<StepAnswerKind | null>(null);

    // What was refused is said until the person picks another way to answer: it was about the last one.
    const [said, setSaid] = useState(true);
    const show = useCallback((next: StepAnswerKind) => {
        if (shown.current !== next) setValue('');
        shown.current = next;
        setKind(next);
    }, []);
    const ask = useCallback<AskStep>(
        (next) =>
            new Promise((resolve) => {
                resolver.current = resolve;
                // The method on screen stays while it can still answer; otherwise the first that can.
                show(next.methods.includes(shown.current) ? shown.current : next.methods[0]!);
                setChecking(false);
                setSaid(true);
                setRequest(next);
                setRound((count) => count + 1);
            }),
        [show],
    );
    const clear = useCallback(() => {
        resolver.current = null;
        answered.current = null;
        shown.current = 'totp';
        setRequest(null);
        setKind('totp');
        setValue('');
        setChecking(false);
    }, []);
    const cancel = useCallback(() => {
        resolver.current?.(null);
        clear();
    }, [clear]);
    function submit() {
        const resolve = resolver.current;
        if (!resolve) return;
        resolver.current = null;
        answered.current = kind;
        setChecking(true);
        resolve(kind === 'phrase' ? { kind, phrase: value } : { kind, code: value });
    }

    // At sign-in the step token is the sign-in: when it runs out, so does the screen.
    const expiresAt = request?.expiresAt;
    const expired = useRef(onExpired);
    useEffect(() => {
        expired.current = onExpired;
    }, [onExpired]);
    useEffect(() => {
        if (!expiresAt || !expired.current) return;
        const timer = window.setTimeout(
            () => {
                // An answer already on its way is the server's to refuse.
                if (!resolver.current) return;
                cancel();
                expired.current?.();
            },
            Math.max(0, Date.parse(expiresAt) - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [expiresAt, cancel]);
    // Left behind by a page that went away: the flow waiting on an answer ends.
    useEffect(() => () => resolver.current?.(null), []);

    return {
        /* Handed to the auth client: `authClient.login(email, password, { step: ask })`. */
        ask,
        request,
        /* Why it is asked again, while that still applies to what is on screen. */
        error: said ? (request?.error ?? '') : '',
        kind,
        value,
        checking,
        round,
        setValue,
        choose: (next: StepAnswerKind) => {
            if (next !== shown.current) setSaid(false);
            show(next);
        },
        submit,
        /* The person backs out: the flow ends with StepCancelled. */
        cancel,
        /* The flow ended, either way: nothing of the answer stays on screen. */
        done: clear,
        /* What answered in this flow, until `done`: for what follows a sign-in (a suggestion, the settings page). */
        answeredWith: () => answered.current,
    };
}
export type StepPrompt = ReturnType<typeof useStepPrompt>;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/* The field for the method on screen: its label, the input, and the error or the hint beneath. */
export function StepField({ prompt }: { prompt: StepPrompt }) {
    const id = useId();
    const { request, kind, value, checking, round } = prompt;
    const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    // Focus goes to the field when the screen appears, when the method changes, and when the
    // answer was refused; a refused code is selected, so typing replaces it.
    useEffect(() => {
        const element = field.current;
        if (!element) return;
        element.focus();
        if (kind !== 'phrase') element.select();
    }, [kind, round]);
    if (!request) return null;
    const copy = stepWords[kind];
    const error = prompt.error ? authError(new Error(prompt.error)) : '';
    const shared = {
        ref: field,
        id,
        value,
        disabled: checking,
        'aria-invalid': Boolean(error),
        'aria-describedby': `${id}-note`,
        spellCheck: false,
        autoCorrect: 'off',
    } as const;
    return (
        <div data-slot="form-row" data-step={kind} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-[13px] font-semibold">
                    {copy.label}
                </label>
                {kind === 'phrase' && (
                    <span
                        className={cn(
                            'text-[13px] tabular-nums',
                            words(value) === WORDS ? 'text-success' : 'text-muted-foreground',
                        )}
                    >
                        {words(value)} of {WORDS} words
                    </span>
                )}
            </div>
            {kind === 'phrase' ? (
                <Textarea
                    {...shared}
                    autoComplete="off"
                    autoCapitalize="none"
                    onChange={(event) => prompt.setValue(event.target.value)}
                    className="min-h-28 font-mono text-[15px]"
                />
            ) : (
                <Input
                    {...shared}
                    // A code from an app is offered by the keyboard and by password managers.
                    {...(kind === 'totp'
                        ? {
                              inputMode: 'numeric' as const,
                              autoComplete: 'one-time-code',
                              maxLength: 12,
                          }
                        : {
                              autoComplete: 'off',
                              autoCapitalize: 'characters',
                              placeholder: 'XXXXX-XXXXX',
                              maxLength: 32,
                          })}
                    onChange={(event) => prompt.setValue(event.target.value)}
                    onKeyDown={(event) => {
                        // Submit on Enter ourselves, as the other auth fields do.
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                        }
                    }}
                    className="font-mono text-[15px]"
                />
            )}
            {/* Keyed by the round, so the same refusal twice is announced twice. */}
            <p
                key={round}
                id={`${id}-note`}
                role={error ? 'alert' : undefined}
                className={cn(
                    'text-[13px] leading-snug',
                    error ? 'text-destructive' : 'text-muted-foreground',
                )}
            >
                {error || copy.hint}
            </p>
        </div>
    );
}

/* The other ways to answer, as quiet links: only what the account has and the server still takes. */
export function StepChoices({ prompt, className }: { prompt: StepPrompt; className?: string }) {
    const others = prompt.request?.methods.filter((method) => method !== prompt.kind) ?? [];
    if (others.length === 0) return null;
    return (
        <div className={cn('flex flex-wrap gap-x-5 gap-y-2 text-sm', className)}>
            {others.map((method) => (
                <button
                    key={method}
                    type="button"
                    className={authLink}
                    disabled={prompt.checking}
                    onClick={() => prompt.choose(method)}
                >
                    {stepWords[method].choose}
                </button>
            ))}
        </div>
    );
}
