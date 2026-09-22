import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site-header';

/*
 * Every line below states what the current code does, in the landing page's
 * words rather than protocol names: the password never leaves the device
 * (OPAQUE), files are sealed on the device before upload, the account key is
 * made and wrapped here, and the repository is public.
 */
const ledger = [
    ['Your password', 'Never sent to us'],
    ['Your files', 'Locked on your device'],
    ['Your key', 'Made on this device'],
    ['The code', 'Open for anyone to read'],
] as const;

export type AuthPurpose = 'login' | 'register' | 'recover';

/* Three plain sentences per flow: what this page will do, in order, and nothing it won't. */
const steps: Record<AuthPurpose, { title: string; items: readonly string[] }> = {
    login: {
        title: 'What happens when you sign in',
        items: [
            'Your browser proves your password to the server without revealing it.',
            'Your account key is unwrapped on this device. The server only ever holds it encrypted.',
            'This device stays unlocked until you lock it or sign out.',
        ],
    },
    register: {
        title: 'What happens when you create an account',
        items: [
            'We email you a link to confirm the address is yours.',
            'Your browser creates your account key and wraps it with your password. The password itself is never sent.',
            'You get a 24-word recovery phrase, the only way back in if you forget the password.',
        ],
    },
    recover: {
        title: 'What happens when you recover',
        items: [
            'We email you a link to confirm the address is yours.',
            'Your 24-word phrase unwraps your account key on this device.',
            'You choose a new password. Your account key stays the same.',
        ],
    },
};

export function SessionLedger({ purpose = 'login' }: { purpose?: AuthPurpose }) {
    const guide = steps[purpose];
    return (
        <aside className="hidden w-72 shrink-0 flex-col gap-8 lg:flex">
            <div>
                <p className="eyebrow text-muted-foreground">At a glance</p>
                <dl className="mt-2 text-sm">
                    {ledger.map(([key, value]) => (
                        <div
                            key={key}
                            className="flex justify-between gap-6 border-b border-dotted border-rule py-2"
                        >
                            <dt className="text-muted-foreground">{key}</dt>
                            <dd className={value === 'Never sent to us' ? 'font-bold' : ''}>
                                {value}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
            <div>
                <p className="eyebrow text-muted-foreground">{guide.title}</p>
                <ol className="mt-3 flex flex-col gap-3 text-sm leading-relaxed">
                    {guide.items.map((item, index) => (
                        <li key={item} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
                            <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                            <span className="text-pretty">{item}</span>
                        </li>
                    ))}
                </ol>
            </div>
            <p className="text-lg leading-snug font-bold tracking-tight text-balance">
                You hold the only key.
            </p>
        </aside>
    );
}

export function AuthCard({
    title,
    stamp,
    description,
    eyebrow,
    wide = false,
    children,
    footer,
}: {
    title: string;
    stamp?: string;
    description?: ReactNode;
    eyebrow?: ReactNode;
    wide?: boolean;
    children: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <section
            aria-labelledby="auth-title"
            className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}
        >
            <div className="sheet px-5 py-7 sm:px-8 sm:py-9">
                {eyebrow && <div className="mb-4">{eyebrow}</div>}
                {stamp && <p className="eyebrow mb-1.5 text-muted-foreground">{stamp}</p>}
                <h1 id="auth-title" className="text-2xl font-bold tracking-tight text-balance">
                    {title}
                </h1>
                {description && (
                    <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
                        {description}
                    </p>
                )}
                <div className="mt-6">{children}</div>
            </div>
            {footer && (
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 px-5 text-xs text-muted-foreground sm:px-8">
                    {footer}
                </div>
            )}
        </section>
    );
}

/* A short line under the sheet: a claim the current code actually keeps. */
export function Stamp({
    children,
}: {
    /* Kept so call sites need no change; both tones read as the same quiet line. */
    tone?: 'outline' | 'warning';
    children: ReactNode;
}) {
    return <span>{children}</span>;
}

/* The fields of a step, stacked with room between them. */
export function AuthFields({ children }: { children: ReactNode }) {
    // Rows bring their own padding for a boxed form; stacked on a sheet they sit flush, a line apart.
    return <div className="flex flex-col gap-4 *:data-[slot=form-row]:p-0">{children}</div>;
}

/* The foot of a step: the one primary action across the sheet, the quieter ways out beneath it. */
export function AuthActions({ children, action }: { children?: ReactNode; action: ReactNode }) {
    return (
        <div data-slot="form-actions" className="mt-1 flex flex-col gap-4">
            <div className="flex [&>*]:w-full">{action}</div>
            {children && (
                <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-sm leading-relaxed text-muted-foreground">
                    {children}
                </div>
            )}
        </div>
    );
}

/* A message among the fields: an error from the server, or a note about what happens next. */
export function AuthNote({
    tone = 'default',
    children,
}: {
    tone?: 'default' | 'destructive';
    children: ReactNode;
}) {
    return (
        <div
            role={tone === 'destructive' ? 'alert' : undefined}
            className={`rounded-xs px-4 py-3 text-sm leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200 ease-out-expo ${
                tone === 'destructive'
                    ? 'bg-destructive-soft text-destructive'
                    : 'bg-muted text-muted-foreground'
            }`}
        >
            {children}
        </div>
    );
}

export function AuthLayout({
    embedded = false,
    wide = false,
    notes = true,
    purpose = 'login',
    title,
    stamp,
    description,
    eyebrow,
    children,
    footer,
}: {
    embedded?: boolean;
    /* For a step whose content needs the room: the 24 recovery words. */
    wide?: boolean;
    /* The column of notes beside the sheet; a page with nothing to explain goes without. */
    notes?: boolean;
    purpose?: AuthPurpose;
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
            wide={wide || embedded}
            footer={footer}
        >
            {children}
        </AuthCard>
    );
    if (embedded) return <div className="mx-auto w-full max-w-2xl">{card}</div>;
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 items-start justify-center gap-14 px-4 py-10 sm:px-8 sm:py-16 lg:items-center">
                <div
                    className={`w-full animate-in fade-in slide-in-from-bottom-2 duration-400 ease-out-expo ${wide ? 'max-w-2xl' : 'max-w-md'}`}
                >
                    {card}
                </div>
                {notes && <SessionLedger purpose={purpose} />}
            </main>
            <SiteFooter />
        </div>
    );
}
