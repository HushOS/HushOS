import { cn } from 'cn';
import type { ReactNode } from 'react';

/*
 * Ledger forms: a bordered table where every field is a row with a label cell
 * on the left and the control on the right. Rows share one rule; nothing floats.
 */
export function FormTable({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div
            data-slot="form-table"
            className={cn('flex flex-col border bg-card *:border-b *:last:border-b-0', className)}
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
            className={cn('grid sm:grid-cols-[9.5rem_minmax(0,1fr)]', className)}
        >
            <label
                htmlFor={htmlFor}
                className={cn(
                    'eyebrow flex h-12 items-center px-4 text-muted-foreground sm:border-r',
                    invalid && 'text-destructive',
                )}
            >
                {label}
            </label>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

/* The last row: secondary links on the left, the one primary block on the right. */
export function FormActions({ children, action }: { children?: ReactNode; action: ReactNode }) {
    return (
        <div data-slot="form-actions" className="grid sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3.5 font-mono text-xs text-muted-foreground sm:border-r">
                {children}
            </div>
            <div className="flex border-t sm:border-t-0 [&>*]:h-14 [&>*]:w-full [&>*]:justify-between [&>*]:border-0 [&>*]:px-5 sm:[&>*]:w-56">
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
                'px-4 py-3 font-mono text-xs leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200 ease-out-expo',
                tone === 'destructive'
                    ? 'bg-destructive/15 text-foreground'
                    : 'text-muted-foreground',
            )}
        >
            {children}
        </div>
    );
}
