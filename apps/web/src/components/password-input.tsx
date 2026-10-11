import { cn } from 'cn';
import { useState, type ComponentProps } from 'react';
import { TextSwap } from '@/components/motion';
import { Input } from '@/components/ui/input';

/*
 * A password field with Show beside it, as on sign-in, so what was typed can be
 * checked before it is used. `wrapperClassName` sizes the field in its row.
 */
export function PasswordInput({
    className,
    wrapperClassName,
    ...props
}: Omit<ComponentProps<typeof Input>, 'type'> & { wrapperClassName?: string }) {
    const [shown, setShown] = useState(false);
    return (
        <div className={cn('relative', wrapperClassName)}>
            <Input
                {...props}
                type={shown ? 'text' : 'password'}
                className={cn('pr-16', className)}
            />
            <button
                type="button"
                onClick={() => setShown((value) => !value)}
                aria-label={shown ? 'Hide password' : 'Show password'}
                aria-pressed={shown}
                disabled={props.disabled}
                className="absolute inset-y-1 right-1 flex cursor-pointer items-center rounded-sm px-2.5 text-[13px] font-semibold text-primary transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
            >
                <TextSwap>{shown ? 'Hide' : 'Show'}</TextSwap>
            </button>
        </div>
    );
}
