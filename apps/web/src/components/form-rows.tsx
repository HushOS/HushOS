import { cn } from 'cn';
import type { ReactNode } from 'react';

/*
 * A quiet form on a sheet: a hairline box where every field is a row with its
 * label on the left and the control on the right, a hairline between rows.
 */
export function FormTable({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div
            data-slot="form-table"
            className={cn(
                'flex flex-col rounded-md border border-rule bg-card *:border-b *:border-rule *:last:border-b-0',
                className,
            )}
        >
            {children}
        </div>
    );
}

export function FormRow({
    label,
    htmlFor,
    invalid,
    children,
    className,
}: {
    label: ReactNode;
    htmlFor?: string;
    invalid?: boolean;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            data-slot="form-row"
            data-invalid={invalid}
            className={cn('@container px-4 py-3', className)}
        >
            {/* Beside the field where the row is wide enough, above it where it is not. */}
            <div className="grid gap-x-4 gap-y-1.5 @lg:grid-cols-[9rem_minmax(0,1fr)] @lg:items-start">
                <label
                    htmlFor={htmlFor}
                    className={cn(
                        'eyebrow flex items-center text-muted-foreground @lg:h-10',
                        invalid && 'text-destructive',
                    )}
                >
                    {label}
                </label>
                {/*
                 * A field has to look like one: whatever the caller passed, the control in a row
                 * gets its own border and ground, so it can be found without a rule drawn round it.
                 */}
                <div className="min-w-0 [&_[data-slot=input]]:h-10! [&_[data-slot=input]]:rounded-md! [&_[data-slot=input]]:border! [&_[data-slot=input]]:border-input! [&_[data-slot=input]]:bg-card! [&_[data-slot=input]]:px-3! [&_[data-slot=select-trigger]]:h-10! [&_[data-slot=select-trigger]]:w-full [&_[data-slot=select-trigger]]:rounded-md! [&_[data-slot=select-trigger]]:border! [&_[data-slot=select-trigger]]:border-input! [&_[data-slot=select-trigger]]:bg-card! [&_[data-slot=select-trigger]]:px-3! [&_[data-slot=textarea]]:rounded-md! [&_[data-slot=textarea]]:border! [&_[data-slot=textarea]]:border-input! [&_[data-slot=textarea]]:bg-card!">
                    {children}
                </div>
            </div>
        </div>
    );
}

/* The last row: secondary links and notes on the left, the one primary button on the right. */
export function FormActions({ children, action }: { children?: ReactNode; action: ReactNode }) {
    return (
        <div
            data-slot="form-actions"
            className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
        >
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                {children}
            </div>
            {/* Call sites pass buttons of several sizes; here they are all the ordinary one. */}
            <div className="flex shrink-0 *:h-10 *:w-full *:px-4 *:text-sm sm:justify-end sm:*:w-auto">
                {action}
            </div>
        </div>
    );
}

/* A row that carries only a message: an error from the server, a note. */
export function FormNote({
    tone = 'default',
    children,
}: {
    tone?: 'default' | 'destructive';
    children: ReactNode;
}) {
    return (
        <div
            role={tone === 'destructive' ? 'alert' : undefined}
            className={cn(
                'px-4 py-3 text-sm leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200 ease-out-expo',
                tone === 'destructive'
                    ? 'bg-destructive-soft text-destructive'
                    : 'text-muted-foreground',
            )}
        >
            {children}
        </div>
    );
}
