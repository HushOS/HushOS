import { cn } from 'cn';
import {
    CircleAlertIcon,
    CircleCheckIcon,
    InfoIcon,
    TriangleAlertIcon,
    type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Brand } from '@/components/brand';
import { Cover } from '@/components/cover';

/*
 * The pages for getting in: the mark at the top left, one card in the middle
 * of the ground, and one quiet line beneath it. Each card asks for one thing
 * and says why in a line. Nothing here explains cryptography; errors sit on
 * the field they are about, or in one line above the form.
 */

export function AuthLayout({
    title,
    description,
    wide = false,
    art = 'HUSH',
    children,
    footer,
}: {
    title: string;
    description?: ReactNode;
    /* For the 24 words. */
    wide?: boolean;
    /* The word the panel beside the card spells in dots on a wide screen: the step's own. */
    art?: string;
    children?: ReactNode;
    footer?: ReactNode;
}) {
    // A row, not a grid: when high contrast hides the panel, the card takes the whole width.
    return (
        <div className="flex min-h-svh bg-background">
            <div className="flex min-h-svh min-w-0 flex-1 flex-col">
                <header className="flex h-16 shrink-0 items-center px-5 sm:px-7">
                    <Brand />
                </header>
                <main className="flex flex-1 flex-col items-center px-4 pt-4 pb-12 sm:justify-center sm:pt-0">
                    <section
                        aria-labelledby="auth-title"
                        className={cn(
                            'flex w-full flex-col gap-5 rounded-2xl border border-rule bg-card p-6 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-400 ease-out-expo sm:p-8',
                            wide ? 'max-w-[600px]' : 'max-w-[420px]',
                        )}
                    >
                        <div className="flex flex-col gap-1.5">
                            <h1
                                id="auth-title"
                                className="text-[26px] leading-[1.15] font-extrabold tracking-[-0.03em] text-balance"
                            >
                                {title}
                            </h1>
                            {description && (
                                <p className="text-[15px] leading-snug text-pretty text-muted-foreground">
                                    {description}
                                </p>
                            )}
                        </div>
                        {children}
                    </section>
                    {footer && (
                        <div className="mt-4 text-center text-sm text-muted-foreground">
                            {footer}
                        </div>
                    )}
                </main>
            </div>
            {/*
             * The dot-matrix panel (DESIGN.md → Dither): Hush blue, the step's word, a dithered
             * wash at its foot. Decoration only, so wide screens alone, and none in high contrast.
             * It fills its column by cropping the art's sides, so it shows only on screens wide
             * enough for their height to keep a five-letter word whole (identities.css).
             */}
            <aside
                aria-hidden="true"
                className="dither-panel sticky top-0 hidden h-svh shrink-0 basis-[38%] lg:block"
            >
                <Cover word={art} tone="blue" seed={art} cols={40} rows={64} dither fill />
            </aside>
        </div>
    );
}

/* The fields of a step, stacked with room between them. */
export function AuthFields({ children }: { children: ReactNode }) {
    return <div className="flex flex-col gap-4">{children}</div>;
}

/* The one primary action, across the card. */
export function AuthActions({ children, action }: { children?: ReactNode; action: ReactNode }) {
    return (
        <div data-slot="form-actions" className="mt-1 flex flex-col gap-3">
            <div className="flex *:h-11 *:w-full *:text-[15px]">{action}</div>
            {children && (
                <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-sm text-muted-foreground">
                    {children}
                </div>
            )}
        </div>
    );
}

export type NoteTone = 'danger' | 'info' | 'success' | 'warning';

const noteIcon: Record<NoteTone, LucideIcon> = {
    danger: CircleAlertIcon,
    info: InfoIcon,
    success: CircleCheckIcon,
    warning: TriangleAlertIcon,
};

/* One line above the form: what went wrong, or why the person is here. */
export function AuthNote({
    tone = 'info',
    title,
    children,
}: {
    tone?: NoteTone | 'destructive' | 'default';
    title?: string;
    children: ReactNode;
}) {
    const kind: NoteTone = tone === 'destructive' ? 'danger' : tone === 'default' ? 'info' : tone;
    const Icon = noteIcon[kind];
    return (
        <div
            role={kind === 'danger' ? 'alert' : 'status'}
            className={cn(
                'flex items-start gap-2.5 rounded-md px-3.5 py-3 text-sm leading-snug animate-in fade-in slide-in-from-top-1 duration-200 ease-out-expo',
                kind === 'danger' && 'bg-destructive-soft text-destructive',
                kind === 'info' && 'bg-accent text-accent-foreground',
                kind === 'success' && 'bg-success-soft text-success',
                kind === 'warning' && 'border border-rule bg-muted text-foreground',
            )}
        >
            <Icon
                className={cn('mt-0.5 size-4 shrink-0', kind === 'warning' && 'text-warning')}
                aria-hidden="true"
            />
            <span className="flex flex-col gap-0.5">
                {title && <span className="font-semibold">{title}</span>}
                <span>{children}</span>
            </span>
        </div>
    );
}

/* An underlined text button or link, the quiet way out. */
export const authLink =
    'cursor-pointer font-semibold text-primary underline underline-offset-4 hover:text-primary-hover';
