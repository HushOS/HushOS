import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Link, useRouteContext, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/* A header cell: one item in the ledger bar, separated from the next by a rule. */
function BarLink({
    to,
    children,
    exact = false,
    className = '',
}: {
    to: LinkProps['to'];
    children: ReactNode;
    exact?: boolean;
    className?: string;
}) {
    return (
        <Link
            to={to}
            activeOptions={{ exact }}
            data-cuelume-hover="tick"
            className={`eyebrow flex min-w-10 flex-auto items-center justify-center border-r px-2 whitespace-nowrap text-foreground transition-colors hover:bg-muted sm:flex-none sm:px-4 data-[status=active]:bg-muted ${className}`}
        >
            {children}
        </Link>
    );
}

export function ColourStrip({ className = '' }: { className?: string }) {
    return <div aria-hidden="true" className={`colour-strip h-full w-40 border-l ${className}`} />;
}

/* Sign in and create account, or open the app when a session exists. */
export function SessionLinks() {
    const { hasSession } = useRouteContext({ from: '__root__' });
    return hasSession ? (
        <BarLink to="/app">Go to Drive</BarLink>
    ) : (
        <>
            <BarLink to="/login">Sign in</BarLink>
            <BarLink to="/register">Create account</BarLink>
        </>
    );
}

export function SiteHeader() {
    const { billingEnabled } = useRouteContext({ from: '__root__' });
    return (
        <header className="flex h-11 items-stretch border-b bg-background">
            <Brand className="px-2 sm:px-4" />
            <SessionLinks />
            {/* The footer carries Pricing and About on phones, where the bar has room for the two that matter. */}
            {billingEnabled && (
                <BarLink to="/pricing" className="hidden sm:flex">
                    Pricing
                </BarLink>
            )}
            <BarLink to="/about" className="hidden sm:flex">
                About
            </BarLink>
            <div className="hidden flex-1 sm:block" />
            <ColourStrip className="hidden sm:block" />
            <ThemeToggle />
        </header>
    );
}

import { comparisons } from '@/lib/compare';

type FooterItem =
    | { label: string; to: LinkProps['to'] }
    | { label: string; vs: string }
    | { label: string; href: string };

const footerColumns: { title: string; items: FooterItem[] }[] = [
    {
        title: 'Product',
        items: [
            { label: 'Drive', to: '/' },
            { label: 'Pricing', to: '/pricing' },
            { label: 'Security', to: '/security' },
            { label: 'About', to: '/about' },
            { label: 'Blog', to: '/blog' },
        ],
    },
    {
        title: 'Compare',
        items: comparisons.map((entry) => ({ label: `vs ${entry.name}`, vs: entry.slug })),
    },
    {
        title: 'Project',
        items: [
            { label: 'Open source', href: 'https://github.com/HushOS/HushOS' },
            {
                label: 'Self-host guide',
                href: 'https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md',
            },
            { label: 'AGPL-3.0', href: 'https://github.com/HushOS/HushOS/blob/main/LICENSE' },
        ],
    },
    {
        title: 'Legal',
        items: [
            { label: 'Terms', to: '/terms' },
            { label: 'Privacy', to: '/privacy' },
        ],
    },
];

const footerLink =
    'flex items-center gap-2 border-b border-dotted px-4 py-2.5 text-foreground transition-colors last:border-b-0 hover:bg-muted';

function FooterLink({ item }: { item: FooterItem }) {
    if ('vs' in item)
        return (
            <Link
                to="/vs/$slug"
                params={{ slug: item.vs }}
                data-cuelume-hover="tick"
                className={footerLink}
            >
                {item.label}
            </Link>
        );
    if ('href' in item)
        return (
            <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                data-cuelume-hover="tick"
                className={footerLink}
            >
                {item.label}
            </a>
        );
    return (
        <Link to={item.to} data-cuelume-hover="tick" className={footerLink}>
            {item.label}
        </Link>
    );
}

/*
 * The footer is four columns of cells, each a link: what the product is,
 * how it compares, where the code lives, and the legal pages. Two columns on
 * phones, four from the medium breakpoint, and the copyright line beneath.
 */
export function SiteFooter() {
    const year = new Date().getFullYear();
    return (
        <footer className="eyebrow border-t text-muted-foreground">
            <nav aria-label="Footer" className="grid grid-cols-2 md:grid-cols-4">
                {footerColumns.map((column) => (
                    <div
                        key={column.title}
                        className="border-b border-r nth-[2n]:border-r-0 md:border-b-0 md:nth-[2n]:border-r md:last:border-r-0"
                    >
                        <p className="border-b px-4 py-3">{column.title}</p>
                        <ul>
                            {column.items.map((item) => (
                                <li key={item.label}>
                                    <FooterLink item={item} />
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </nav>
            <p className="border-t px-4 py-3">© {year} HushOS. Free software, yours to run.</p>
        </footer>
    );
}
