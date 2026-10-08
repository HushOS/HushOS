import { useState, type ComponentProps, type ReactNode } from 'react';
import { TextSwap } from '@/components/motion';
import { Input } from '@/components/ui/input';

export function messagesOf(errors: unknown[]) {
    return errors
        .map((error) =>
            typeof error === 'string'
                ? error
                : error && typeof error === 'object' && 'message' in error
                  ? String(error.message)
                  : '',
        )
        .filter(Boolean)
        .join(' ');
}

/*
 * One field: the label above (with an optional note and an action beside it,
 * like "Forgot your password?"), the input, and the hint or the error beneath.
 */
export function AuthInput({
    label,
    hint,
    errors,
    type,
    className,
    optional,
    action,
    ...props
}: ComponentProps<typeof Input> & {
    label: ReactNode;
    hint?: ReactNode;
    errors: unknown[];
    optional?: boolean;
    action?: ReactNode;
}) {
    const [revealed, setRevealed] = useState(false);
    const message = messagesOf(errors);
    const invalid = message.length > 0;
    const secret = type === 'password';
    const describedBy =
        [invalid && `${props.id}-error`, hint && `${props.id}-hint`].filter(Boolean).join(' ') ||
        undefined;
    return (
        <div data-slot="form-row" data-invalid={invalid} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px]">
                    <label htmlFor={props.id} className="font-semibold">
                        {label}
                    </label>
                    {/* The field isn't required, which is what a screen reader says; this is for the eye. */}
                    {optional && (
                        <span aria-hidden="true" className="text-muted-foreground">
                            {' '}
                            · optional
                        </span>
                    )}
                </span>
                {action && <span className="text-[13px]">{action}</span>}
            </div>
            <div className="relative">
                <Input
                    type={secret && revealed ? 'text' : type}
                    onKeyDown={(event) => {
                        props.onKeyDown?.(event);
                        // Submit on Enter ourselves; implicit submission has proven unreliable here.
                        if (event.key === 'Enter' && !event.defaultPrevented && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                        }
                    }}
                    className={`text-[15px] ${secret ? 'pr-16!' : ''} ${className ?? ''}`}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    {...props}
                />
                {secret && (
                    <button
                        type="button"
                        onClick={() => setRevealed((value) => !value)}
                        aria-label={revealed ? 'Hide password' : 'Show password'}
                        aria-pressed={revealed}
                        className="absolute inset-y-1 right-1 flex cursor-pointer items-center rounded-sm px-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-muted"
                    >
                        <TextSwap>{revealed ? 'Hide' : 'Show'}</TextSwap>
                    </button>
                )}
            </div>
            {invalid ? (
                <p
                    id={`${props.id}-error`}
                    role="alert"
                    className="text-[13px] leading-snug text-destructive animate-in fade-in duration-200 ease-out-expo"
                >
                    {message}
                </p>
            ) : (
                hint && (
                    <p
                        id={`${props.id}-hint`}
                        className="text-[13px] leading-snug text-muted-foreground"
                    >
                        {hint}
                    </p>
                )
            )}
        </div>
    );
}

/*
 * How hard the password would be to guess, as it is typed. A rough guide only:
 * length counts most, then a mix of kinds. The server's rule is the length.
 */
export function strength(password: string, min: number) {
    if (password.length === 0)
        return {
            score: 0,
            label: '',
            hint: `At least ${min} characters. A few unrelated words work well.`,
        };
    if (password.length < min) {
        const left = min - password.length;
        return {
            score: 0,
            label: 'Too short',
            hint: `${left} more ${left === 1 ? 'character' : 'characters'} to go.`,
        };
    }
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/, /\s/].filter((re) =>
        re.test(password),
    ).length;
    if (password.length >= 20 || (password.length >= 14 && kinds >= 3))
        return { score: 3, label: 'Strong', hint: 'Hard to guess. Make sure you can remember it.' };
    if (kinds >= 2)
        return { score: 2, label: 'Good', hint: 'Longer is stronger. Another word would help.' };
    return { score: 1, label: 'Weak', hint: 'Easy to guess. Add another word or two.' };
}

export function StrengthHint({ password, min }: { password: string; min: number }) {
    const s = strength(password, min);
    const fill = s.score === 3 ? 'bg-success' : s.score === 2 ? 'bg-primary' : 'bg-destructive';
    return (
        <div className="-mt-2 flex flex-col gap-1.5">
            <div className="flex gap-1" aria-hidden="true">
                {[1, 2, 3].map((step) => (
                    <span
                        key={step}
                        className={`h-1 flex-1 rounded-full ${
                            password.length > 0 &&
                            (s.score >= step || (s.score === 0 && step === 1))
                                ? fill
                                : 'bg-rule'
                        }`}
                    />
                ))}
            </div>
            <p aria-live="polite" className="text-[13px] text-muted-foreground">
                {s.label && (
                    <span
                        className={`font-semibold ${
                            s.score === 3
                                ? 'text-success'
                                : s.score === 0
                                  ? 'text-destructive'
                                  : 'text-foreground'
                        }`}
                    >
                        {s.label}.{' '}
                    </span>
                )}
                {s.hint}
            </p>
        </div>
    );
}
