import type { AskStep, StepAnswer, StepAnswerKind, StepRequest } from '@hushos/auth/client';
import { cn } from 'cn';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AuthNote, authLink } from '@/components/auth-layout';
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

/* A change left waiting at the step is given up on after this long: it holds passwords in memory. */
export const STEP_LIMIT_MS = 10 * 60_000;

export const stepWords: Record<
    StepAnswerKind,
    { title: string; about: string; label: string; choose: string }
> = {
    totp: {
        title: 'Enter your code',
        about: 'Open your authenticator app and enter the code it shows for HushOS.',
        label: 'Six-digit code',
        choose: 'Use your authenticator app',
    },
    backup: {
        title: 'Use a backup code',
        about: 'Enter one of the backup codes you saved.',
        label: 'Backup code',
        choose: 'Use a backup code',
    },
    phrase: {
        title: 'Use your recovery phrase',
        about: `Enter the ${WORDS} words from your recovery kit. They stay on this device.`,
        label: 'Recovery phrase',
        choose: 'Use your recovery phrase',
    },
};

/*
 * `onExpired` runs when the screen gives the step up by itself: at sign-in when the step
 * token's time is out (counted from when the token arrived, on this device's own clock, so a
 * clock that runs fast or slow changes nothing; the server stays the judge of an answer sent
 * in time), and at a change after `limitMs` at the step.
 */
export function useStepPrompt({
    onExpired,
    limitMs,
}: { onExpired?: () => void; limitMs?: number } = {}) {
    const [request, setRequest] = useState<StepRequest | null>(null);
    const [kind, setKind] = useState<StepAnswerKind>('totp');
    const [value, setValue] = useState('');
    const [checking, setChecking] = useState(false);
    // Each time the client asks: the field takes focus again, and a repeated error is said again.
    const [round, setRound] = useState(0);
    // When the screen gives up, on this device's clock: set as the token (or the flow) arrives.
    const [deadline, setDeadline] = useState<number | null>(null);
    const resolver = useRef<((answer: StepAnswer | null) => void) | null>(null);
    const shown = useRef<StepAnswerKind>('totp');
    const began = useRef<number | null>(null);
    // The page that drew this went away: nobody is left to answer.
    const gone = useRef(false);

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
                // Asked after the page went away (it left while the password was being
                // proved): backed out, or the flow would wait for ever, holding the worker.
                if (gone.current) return resolve(null);
                resolver.current = resolve;
                began.current ??= Date.now();
                // The method on screen stays while it can still answer; otherwise the first that can.
                show(next.methods.includes(shown.current) ? shown.current : next.methods[0]!);
                setChecking(false);
                setSaid(true);
                setRequest(next);
                setDeadline(
                    limitMs === undefined ? Date.now() + next.endsIn : began.current + limitMs,
                );
                setRound((count) => count + 1);
            }),
        [show, limitMs],
    );
    const clear = useCallback(() => {
        resolver.current = null;
        began.current = null;
        shown.current = 'totp';
        setRequest(null);
        setDeadline(null);
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
        setChecking(true);
        resolve(kind === 'phrase' ? { kind, phrase: value } : { kind, code: value });
    }

    const expired = useRef(onExpired);
    useEffect(() => {
        expired.current = onExpired;
    }, [onExpired]);
    useEffect(() => {
        if (deadline === null || !expired.current) return;
        const timer = window.setTimeout(
            () => {
                // An answer already on its way is the server's to refuse.
                if (!resolver.current) return;
                cancel();
                expired.current?.();
            },
            Math.max(0, deadline - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [deadline, cancel]);
    // Left behind by a page that went away: the flow waiting on an answer ends, and so does
    // one that asks later.
    useEffect(() => {
        gone.current = false;
        return () => {
            gone.current = true;
            resolver.current?.(null);
        };
    }, []);

    return {
        /* Handed to the auth client: `authClient.login(email, password, { step: ask })`. */
        ask,
        request,
        /* What was wrong with the last answer, while that answer's field is still on screen. */
        error: said ? (request?.error ?? '') : '',
        /* What changed about the step itself (a method paused, a new token): above the field. */
        notice: request?.notice ?? '',
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
    };
}
export type StepPrompt = ReturnType<typeof useStepPrompt>;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/*
 * The field for the method on screen: a notice about the step above it when there is one, its
 * label, the input, and the error beneath when the answer typed in it was refused.
 */
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
        'aria-describedby': error ? `${id}-error` : undefined,
        spellCheck: false,
        autoCorrect: 'off',
    } as const;
    return (
        <div className="flex flex-col gap-4">
            {/* Keyed by the round, so the same notice twice is announced twice. */}
            {prompt.notice && (
                <AuthNote key={round} tone="warning">
                    {authError(new Error(prompt.notice))}
                </AuthNote>
            )}
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
                {error && (
                    <p
                        key={round}
                        id={`${id}-error`}
                        role="alert"
                        className="text-[13px] leading-snug text-destructive"
                    >
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}

/*
 * The other ways to answer, as quiet links: only what the account has and the server still
 * takes. On a touch screen each is 44px tall, so two of them are not one target.
 */
export function StepChoices({ prompt, className }: { prompt: StepPrompt; className?: string }) {
    const others = prompt.request?.methods.filter((method) => method !== prompt.kind) ?? [];
    if (others.length === 0) return null;
    return (
        <div
            className={cn(
                'flex flex-wrap gap-x-5 gap-y-2 text-sm pointer-coarse:gap-y-0',
                className,
            )}
        >
            {others.map((method) => (
                <button
                    key={method}
                    type="button"
                    className={cn(authLink, 'pointer-coarse:min-h-11')}
                    disabled={prompt.checking}
                    onClick={() => prompt.choose(method)}
                >
                    {stepWords[method].choose}
                </button>
            ))}
        </div>
    );
}
