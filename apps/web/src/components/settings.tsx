import { cn } from 'cn';
import { CircleCheckIcon } from 'lucide-react';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';

/*
 * The pieces Account and Plan and storage are built from: a group with its
 * title and a rule beneath, rows with the label left and the action right, a
 * line that confirms what just happened, a segmented choice, and a labelled
 * field for the dialogs that ask for a password.
 */

export function SettingsGroup({
    title,
    description,
    action,
    children,
}: {
    title: string;
    description?: string;
    action?: ReactNode;
    children?: ReactNode;
}) {
    const id = useId();
    return (
        <section aria-labelledby={id} className="flex flex-col">
            <div className="flex items-end justify-between gap-4 border-b border-rule pb-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 id={id} className="text-lg font-bold tracking-[-0.01em]">
                        {title}
                    </h2>
                    {description && <p className="text-sm text-muted-foreground">{description}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

/* One row: label, what it is now, and the action. On a phone they stack. */
export function Setting({
    label,
    children,
    action,
    below,
}: {
    label: ReactNode;
    children?: ReactNode;
    action?: ReactNode;
    below?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-2 border-b border-rule py-4 last:border-0">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
                <span className="text-sm font-semibold max-sm:col-span-2">{label}</span>
                <div className="min-w-0 text-[15px]">{children}</div>
                <div className="flex items-center justify-end gap-2">{action}</div>
            </div>
            {below && <div className="sm:pl-[calc(11rem+1.5rem)]">{below}</div>}
        </div>
    );
}

/* What just happened, said once beside the row it concerns. */
export function Done({ children }: { children: ReactNode }) {
    return (
        <output className="flex items-start gap-1.5 text-sm font-semibold text-success">
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {children}
        </output>
    );
}

export function Segmented<T extends string>({
    label,
    options,
    value,
    onChange,
    disabled,
}: {
    label: string;
    options: readonly { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
    disabled?: boolean;
}) {
    return (
        <fieldset className="m-0 flex w-fit max-w-full min-w-0 flex-wrap gap-1 rounded-md border-0 bg-muted p-1">
            <legend className="sr-only">{label}</legend>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    disabled={disabled}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'h-8 cursor-pointer rounded-sm px-3.5 text-sm font-semibold whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default',
                        value === option.value
                            ? 'bg-card text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                    )}
                >
                    {option.label}
                </button>
            ))}
        </fieldset>
    );
}

/* A labelled field for a dialog: the label above, a hint or the error below, and Show for passwords. */
export function DialogField({
    label,
    hint,
    error,
    type,
    className,
    ...props
}: Omit<ComponentProps<typeof Input>, 'id'> & {
    label: string;
    hint?: ReactNode;
    error?: string;
}) {
    const id = useId();
    const [shown, setShown] = useState(false);
    const secret = type === 'password';
    const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ');
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-[13px] font-semibold">
                {label}
            </label>
            <div className="relative">
                <Input
                    id={id}
                    type={secret && shown ? 'text' : type}
                    aria-invalid={Boolean(error)}
                    aria-describedby={describedBy || undefined}
                    className={cn('text-[15px]', secret && 'pr-16', className)}
                    {...props}
                />
                {secret && (
                    <button
                        type="button"
                        onClick={() => setShown((value) => !value)}
                        aria-label={shown ? 'Hide password' : 'Show password'}
                        aria-pressed={shown}
                        className="absolute inset-y-1 right-1 cursor-pointer rounded-sm px-2.5 text-[13px] font-semibold text-primary hover:bg-muted"
                    >
                        {shown ? 'Hide' : 'Show'}
                    </button>
                )}
            </div>
            {error ? (
                <p id={`${id}-error`} className="text-[13px] text-destructive">
                    {error}
                </p>
            ) : (
                hint && (
                    <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">
                        {hint}
                    </p>
                )
            )}
        </div>
    );
}
