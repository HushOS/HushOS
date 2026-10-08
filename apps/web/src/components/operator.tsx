import { cn } from 'cn';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/*
 * The operator console's furniture: a dense heading, monospaced numbers and
 * tight tables. The sidebar's Operator group says whose pages these are.
 * Operator words (object, replica, audit) live here and never reach the
 * consumer UI.
 */

export function OperatorPage({
    title,
    description,
    actions,
    children,
}: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-1 flex-col px-5 pt-4 pb-10 sm:px-8">
            <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] wrap-anywhere">
                        {title}
                    </h1>
                    {description && (
                        <p className="max-w-[80ch] text-[13px] text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
            {children}
        </div>
    );
}

export const th =
    'h-8 border-b border-rule px-2 text-left text-[11px] font-bold tracking-[0.04em] whitespace-nowrap text-muted-foreground uppercase';
export const td = 'h-9 border-b border-rule px-2 text-[13px]';

/* A dense table that scrolls sideways on its own when the page is narrow. */
export function OperatorTable({ children }: { children: ReactNode }) {
    return (
        <div className="min-w-0 overflow-x-auto">
            <table className="w-full border-collapse">{children}</table>
        </div>
    );
}

/* Previous and Next over a list that comes a page at a time, with where you are. */
export function Pager({
    offset,
    pageSize,
    total,
    onOffset,
}: {
    offset: number;
    pageSize: number;
    total: number;
    onOffset: (offset: number) => void;
}) {
    if (total <= pageSize) return null;
    const last = Math.min(total, offset + pageSize);
    return (
        <div className="flex items-center justify-between gap-3 pt-3 text-[13px] text-muted-foreground tabular-nums">
            <span>
                {offset + 1}–{last} of {total}
            </span>
            <span className="flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => onOffset(Math.max(0, offset - pageSize))}
                >
                    Previous
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={last >= total}
                    onClick={() => onOffset(offset + pageSize)}
                >
                    Next
                </Button>
            </span>
        </div>
    );
}

/* A short segmented filter that writes to the address, so a filtered list can be shared. */
export function FilterTabs<T extends string>({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: readonly { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <fieldset className="m-0 flex min-w-0 rounded-md border-0 bg-muted p-0.5">
            <legend className="sr-only">{label}</legend>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'h-7 cursor-pointer rounded-sm px-3 text-[13px] font-semibold whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring',
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

/*
 * The heading of an operator page whose body lays itself out: the title with
 * its actions, and one line beneath. Takes what PageHeader takes.
 */
export function OperatorHeader({
    back,
    title,
    description,
    children,
}: {
    back?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-col px-5 pt-4 pb-4 sm:px-8">
            {back && <p className="pb-1 text-[13px] font-semibold text-muted-foreground">{back}</p>}
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] wrap-anywhere">
                        {title}
                    </h1>
                    {description && (
                        <p className="max-w-[80ch] text-[13px] text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {children && (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
                )}
            </div>
        </div>
    );
}
