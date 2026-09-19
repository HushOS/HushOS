import { cn } from 'cn';
import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Link, useRouteContext, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/* A quiet text link in the header; the page you are on reads in ink. */
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
            // Merged, not joined: a caller's `hidden` has to beat the link's own display.
            className={cn(
                'inline-flex h-9 items-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[status=active]:text-foreground',
                className,
            )}
        >
            {children}
        </Link>
    );
}

/* Sign in and create account, or open the app when a session exists. */
export function SessionLinks() {
    const { hasSession } = useRouteContext({ from: '__root__' });
    return hasSession ? (
        <Button render={<Link to="/app/drive" />} nativeButton={false} size="sm">
            Go to Drive
        </Button>
    ) : (
        <>
            <BarLink to="/login">Sign in</BarLink>
            <Button render={<Link to="/register" />} nativeButton={false} size="sm">
                Create account
            </Button>
        </>
    );
}

export function SiteHeader() {
    const { billingEnabled } = useRouteContext({ from: '__root__' });
    return (
        <header className="border-b border-rule">
            <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1 px-4 sm:gap-2 sm:px-8">
                <Brand className="mr-1 sm:mr-4" />
                {/* Links appear as the bar finds room for them; on a phone the footer carries them all. */}
                {billingEnabled && (
                    <BarLink to="/pricing" className="hidden sm:inline-flex">
                        Pricing
                    </BarLink>
                )}
                <BarLink to="/security" className="hidden md:inline-flex">
                    Security
                </BarLink>
                <BarLink to="/blog" className="hidden sm:inline-flex">
                    Blog
                </BarLink>
                <BarLink to="/about" className="hidden md:inline-flex">
                    About
                </BarLink>
                <div className="flex-1" />
                <SessionLinks />
                {/* The toggle is drawn as a bar cell elsewhere; here it sits as one more quiet item. */}
                <div className="flex h-9 [&_button]:rounded-md [&_button]:border-l-0 [&_button]:px-2.5 [&_button]:text-muted-foreground">
                    <ThemeToggle />
                </div>
            </div>
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

const footerLink = 'transition-colors hover:text-foreground';

function FooterLink({ item }: { item: FooterItem }) {
    if ('vs' in item)
        return (
            <Link to="/vs/$slug" params={{ slug: item.vs }} className={footerLink}>
                {item.label}
            </Link>
        );
    if ('href' in item)
        return (
            <a href={item.href} target="_blank" rel="noreferrer" className={footerLink}>
                {item.label}
            </a>
        );
    return (
        <Link to={item.to} className={footerLink}>
            {item.label}
        </Link>
    );
}

/*
 * The footer is four quiet columns of links: what the product is, how it
 * compares, where the code lives, and the legal pages. Two columns on phones,
 * four from the medium breakpoint, and the copyright line beneath.
 */
export function SiteFooter() {
    const year = new Date().getFullYear();
    const { operatorName } = useRouteContext({ from: '__root__' });
    return (
        <footer className="border-t border-rule text-sm text-muted-foreground">
            <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8">
                <nav
                    aria-label="Footer"
                    className="grid grid-cols-2 gap-x-8 gap-y-8 md:grid-cols-4"
                >
                    {footerColumns.map((column) => (
                        <div key={column.title}>
                            <p className="eyebrow text-foreground">{column.title}</p>
                            <ul className="mt-3 flex flex-col items-start gap-2">
                                {column.items.map((item) => (
                                    <li key={item.label}>
                                        <FooterLink item={item} />
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </nav>
                <p className="mt-10 text-xs">
                    © {year} {operatorName ?? 'HushOS'}. Free software, yours to run.
                </p>
            </div>
        </footer>
    );
}
