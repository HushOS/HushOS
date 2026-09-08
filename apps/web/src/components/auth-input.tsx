import { useState, type ComponentProps, type ReactNode } from 'react';
import { FormRow } from '@/components/form-rows';
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

/* One ledger row: label cell, borderless input cell, and the hint or error beneath the value. */
export function AuthInput({
    label,
    hint,
    errors,
    type,
    className,
    ...props
}: ComponentProps<typeof Input> & { label: ReactNode; hint?: ReactNode; errors: unknown[] }) {
    const [revealed, setRevealed] = useState(false);
    const message = messagesOf(errors);
    const invalid = message.length > 0;
    const secret = type === 'password';
    const describedBy =
        [invalid && `${props.id}-error`, hint && `${props.id}-hint`].filter(Boolean).join(' ') ||
        undefined;
    return (
        <FormRow label={label} htmlFor={props.id} invalid={invalid}>
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
                    className={`h-12 border-0 bg-transparent px-4 ${secret ? 'pr-20' : ''} ${className ?? ''}`}
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
                        data-cuelume-toggle=""
                        className="eyebrow absolute inset-y-0 right-0 flex w-16 cursor-pointer items-center justify-center border-l text-foreground transition-colors hover:bg-muted"
                    >
                        <TextSwap>{revealed ? 'Hide' : 'Show'}</TextSwap>
                    </button>
                )}
            </div>
            {(invalid || hint) && (
                <p
                    id={invalid ? `${props.id}-error` : `${props.id}-hint`}
                    role={invalid ? 'alert' : undefined}
                    className={`border-t px-4 py-2 font-mono text-[11px] leading-relaxed animate-in fade-in duration-200 ease-out-expo ${invalid ? 'bg-destructive/15 text-foreground' : 'text-muted-foreground'}`}
                >
                    {invalid ? message : hint}
                </p>
            )}
        </FormRow>
    );
}
