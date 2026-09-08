import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-header';

/*
 * Every line below states what the current code does. Keep it that honest:
 * OPAQUE keeps the password on the device, account keys are made and wrapped
 * on the device, and the repository is public. Drive content encryption is
 * not implemented yet, so it is never mentioned here.
 */
const ledger = [
    ['Protocol', 'OPAQUE'],
    ['Password sent', 'Never'],
    ['Key created on', 'This device'],
    ['Source', 'AGPL · Public'],
] as const;

export function SessionLedger() {
    return (
        <aside className="hidden flex-col border-r lg:flex">
            <p className="eyebrow border-b px-5 py-4 text-muted-foreground">Session ledger</p>
            <dl className="border-b px-5 py-5 font-mono text-[13px]">
                {ledger.map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-6 py-1.5">
                        <dt className="eyebrow text-muted-foreground">{key}</dt>
                        <dd className={value === 'Never' ? 'font-semibold' : ''}>{value}</dd>
                    </div>
                ))}
            </dl>
            <ul className="flex flex-col gap-2.5 px-5 py-5 font-mono text-xs text-muted-foreground">
                <li className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="size-2.5 bg-success" />
                    Server reachable
                </li>
                <li className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="size-2.5 bg-ink" />
                    Device locked until you sign in
                </li>
            </ul>
            <p className="mt-auto border-t px-5 py-6 font-mono text-[2.6rem] leading-[1.05] font-medium tracking-tight text-balance">
                A private place for your work.
            </p>
        </aside>
    );
}

export function AuthCard({
    title,
    stamp,
    description,
    eyebrow,
    children,
    footer,
}: {
    title: string;
    stamp?: string;
    description?: ReactNode;
    eyebrow?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <section aria-labelledby="auth-title" className="w-full max-w-2xl">
            {eyebrow && <div className="mb-5">{eyebrow}</div>}
            <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <h1 id="auth-title" className="text-2xl font-medium tracking-tight text-balance">
                    {title}
                </h1>
                {stamp && (
                    <span className="eyebrow border px-2 py-1.5 text-muted-foreground">
                        {stamp}
                    </span>
                )}
            </div>
            {description && (
                <p className="mb-6 max-w-lg text-sm leading-relaxed text-pretty text-muted-foreground">
                    {description}
                </p>
            )}
            {children}
            {footer && (
                <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs text-muted-foreground">
                    {footer}
                </div>
            )}
        </section>
    );
}

/* Small uppercase stamps under a form: the claims the current code actually keeps. */
export function Stamp({
    tone = 'outline',
    children,
}: {
    tone?: 'outline' | 'warning';
    children: ReactNode;
}) {
    return (
        <span
            className={`eyebrow border px-2 py-1.5 ${tone === 'warning' ? 'bg-warning text-warning-foreground' : 'text-muted-foreground'}`}
        >
            {children}
        </span>
    );
}

export function AuthLayout({
    embedded = false,
    title,
    stamp,
    description,
    eyebrow,
    children,
    footer,
}: {
    embedded?: boolean;
    title: string;
    stamp?: string;
    description?: ReactNode;
    eyebrow?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}) {
    const card = (
        <AuthCard
            title={title}
            stamp={stamp}
            description={description}
            eyebrow={eyebrow}
            footer={footer}
        >
            {children}
        </AuthCard>
    );
    if (embedded) return <div className="mx-auto w-full max-w-2xl">{card}</div>;
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="grid flex-1 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
                <SessionLedger />
                <div className="flex flex-col justify-center px-5 py-10 animate-in fade-in slide-in-from-bottom-2 duration-400 ease-out-expo sm:px-10 lg:px-16">
                    {card}
                </div>
            </main>
            <SiteFooter />
        </div>
    );
}
