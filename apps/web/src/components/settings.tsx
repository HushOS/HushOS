import { cn } from 'cn';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { SECRET_FIELD } from '@/components/password-input';
import { segmentOn, segmentTrack } from '@/components/ui/segment';

/*
 * The pieces Account, Plan and storage and Family are built from: the page's one
 * centred column, a group with its title and no rule beneath, rows with the label
 * left and the actions right, a segmented choice, and a labelled field for the
 * dialogs that ask for a password.
 */

const pageWidths = { narrow: 'max-w-2xl', column: 'max-w-3xl', wide: 'max-w-4xl' } as const;

/*
 * A settings page: its header and its content in one column, centred in the pane. The
 * header sits inside the column, so the title starts where the rows do. Files and the
 * other lists fill the pane; a column of settings does not, and hugging one edge of a
 * wide pane it reads as a page that failed to load its other half.
 */
export function SettingsPage({
    width = 'column',
    className,
    children,
    ...props
}: ComponentProps<'div'> & { width?: keyof typeof pageWidths }) {
    return (
        <div
            className={cn('mx-auto flex w-full flex-col', pageWidths[width], className)}
            {...props}
        >
            {children}
        </div>
    );
}

/*
 * A group of rows under its title. `status` says the group's state once, beside the
 * title (On, Off); `action` is the group's own, at the end of that line. A group says
 * what it is in its title and has no sentence beneath: `description` is for the pages
 * that explain a choice (a plan, a family), not for Account.
 */
export function SettingsGroup({
    title,
    status,
    description,
    action,
    children,
}: {
    title: string;
    status?: ReactNode;
    description?: string;
    action?: ReactNode;
    children?: ReactNode;
}) {
    const id = useId();
    return (
        <section aria-labelledby={id} className="flex flex-col">
            <div className="hang-end flex items-end justify-between gap-4 pb-1">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <h2 id={id} className="text-lg font-bold tracking-[-0.01em]">
                            {title}
                        </h2>
                        {status}
                    </div>
                    {description && <p className="text-sm text-muted-foreground">{description}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

/*
 * One row: label, what it is now, and its actions. Rows, and groups, are told apart by
 * their spacing, not by rules. The label column fits the longest fixed label ("Member
 * list version") on one line; a long name wraps.
 *
 * The actions are one column down the whole page: every row's end at the same right
 * edge, centred on the row, each a 36px button (44px for a finger) with the same gap.
 * Use `outline` for an action and `destructive-outline` for one that removes, so a row
 * of them has one shape and one baseline. (A quiet button that ends a row still hangs its
 * padding, `hang-end`, for the pages that have one: its words end on the same edge.) A row without a label (a key under its kind,
 * a device) keeps the columns: its text starts where the values do.
 *
 * On a phone the label has a line of its own and the actions stay at the right edge:
 * beside the value while they fit, on a line beneath it when they don't. A row with no
 * value (a switch) keeps its label and its action on one line.
 */
export function Setting({
    label,
    children,
    action,
    below,
    top = false,
    data,
}: {
    label?: ReactNode;
    children?: ReactNode;
    action?: ReactNode;
    below?: ReactNode;
    /* A value many lines tall (a list): the label sits beside its first line, not its middle. */
    top?: boolean;
    /* `data-*` attributes for the row, which tests and verification find it by. */
    data?: Record<`data-${string}`, string | boolean>;
}) {
    const bare = children === undefined || children === null || children === false;
    return (
        <div {...data} className="flex flex-col gap-2 py-3">
            <div
                className={cn(
                    'flex flex-wrap gap-x-4 gap-y-1.5 sm:grid sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:gap-x-6',
                    top ? 'items-start' : 'items-center',
                )}
            >
                {label !== undefined && (
                    <span
                        className={cn(
                            'text-sm font-semibold wrap-break-word',
                            bare ? 'min-w-0 flex-1 sm:col-span-2' : 'w-full sm:w-auto',
                        )}
                    >
                        {label}
                    </span>
                )}
                {!bare && (
                    <div className="min-w-0 flex-1 basis-28 text-[15px] sm:col-start-2">
                        {children}
                    </div>
                )}
                <div
                    data-setting-actions
                    className="hang-end ms-auto flex flex-wrap items-center justify-end gap-2 empty:hidden sm:col-start-3"
                >
                    {action}
                </div>
            </div>
            {below && <div className="sm:pl-[calc(8.5rem+1.5rem)]">{below}</div>}
        </div>
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
        <fieldset
            className={cn(
                'm-0 flex w-fit max-w-full min-w-0 flex-wrap gap-1 rounded-md border-0 p-1',
                segmentTrack,
            )}
        >
            <legend className="sr-only">{label}</legend>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    disabled={disabled}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'h-8 cursor-pointer rounded-sm px-3.5 text-sm font-semibold whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:cursor-default',
                        value === option.value
                            ? segmentOn
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
                    // Shown as text, a password would go to the browser's cloud spellcheck.
                    {...(secret ? SECRET_FIELD : {})}
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
                <p id={`${id}-error`} role="alert" className="text-[13px] text-destructive">
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
