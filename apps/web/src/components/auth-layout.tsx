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

/*
 * The pages for getting in: the mark at the top left, one card in the middle
 * of the ground, and one quiet line beneath it. Each card asks for one thing
 * and says why in a line. Nothing here explains cryptography; errors sit on
 * the field they are about, or in one line above the form.
 */

export function AuthLayout({
    title,
    description,
    icon,
    wide = false,
    children,
    footer,
}: {
    title: string;
    description?: ReactNode;
    /* A round mark above the title: the inbox, a lock. */
    icon?: ReactNode;
    /* For the 24 words. */
    wide?: boolean;
    children?: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <div className="flex min-h-svh flex-col bg-background">
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
                    {icon && (
                        <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground [&_svg]:size-6">
                            {icon}
                        </span>
                    )}
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
                    <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>
                )}
            </main>
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
