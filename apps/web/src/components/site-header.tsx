import { Brand } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Link, useRouteContext, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/* A header cell: one item in the ledger bar, separated from the next by a rule. */
function BarLink({
    to,
    children,
    exact = false,
}: {
    to: LinkProps['to'];
    children: ReactNode;
    exact?: boolean;
}) {
    return (
        <Link
            to={to}
            activeOptions={{ exact }}
            data-cuelume-hover="tick"
            className="eyebrow flex min-w-10 flex-auto items-center justify-center border-r px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex-none sm:px-4 data-[status=active]:bg-muted data-[status=active]:text-foreground"
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
    const { user } = useRouteContext({ from: '__root__' });
    return user ? (
        <BarLink to="/app">Open app</BarLink>
    ) : (
        <>
            <BarLink to="/login">Sign in</BarLink>
            <BarLink to="/register">Create account</BarLink>
        </>
    );
}

export function SiteHeader() {
    return (
        <header className="flex h-11 items-stretch border-b bg-background">
            <Brand className="px-2 sm:px-4" />
            <SessionLinks />
            <div className="hidden flex-1 sm:block" />
            <ColourStrip className="hidden sm:block" />
            <ThemeToggle />
        </header>
    );
}

const footerCell =
    'flex items-center gap-2 border-r border-b px-4 py-3 transition-colors hover:bg-muted hover:text-foreground even:border-r-0 sm:border-b-0 sm:even:border-r';

function FooterLink({
    to,
    href,
    children,
}: {
    to?: LinkProps['to'];
    href?: string;
    children: ReactNode;
}) {
    if (href)
        return (
            <a
                href={href}
                target="_blank"
                rel="noreferrer"
                data-cuelume-hover="tick"
                className={footerCell}
            >
                {children}
            </a>
        );
    return (
        <Link to={to} data-cuelume-hover="tick" className={footerCell}>
            {children}
        </Link>
    );
}

/*
 * Every footer item is a cell and every cell is a link. Two columns on phones,
 * one bar from the small breakpoint, and the copyright line beneath.
 */
export function SiteFooter() {
    const year = new Date().getFullYear();
    return (
        <footer className="eyebrow border-t text-muted-foreground">
            <nav aria-label="Footer" className="grid grid-cols-2 sm:flex sm:items-stretch">
                <FooterLink to="/">HushOS</FooterLink>
                <FooterLink href="https://github.com/HushOS/HushOS">Open source</FooterLink>
                <FooterLink href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md">
                    Self-host guide
                </FooterLink>
                <FooterLink to="/blog">Blog</FooterLink>
                <FooterLink to="/security">Security</FooterLink>
                <FooterLink to="/terms">Terms</FooterLink>
                <FooterLink to="/privacy">Privacy</FooterLink>
                <a
                    href="https://www.gnu.org/licenses/agpl-3.0.html"
                    target="_blank"
                    rel="noreferrer"
                    data-cuelume-hover="tick"
                    className={`${footerCell} sm:border-r-0`}
                >
                    AGPL-3.0
                </a>
            </nav>
            <p className="px-4 py-3 sm:border-t">© {year} HushOS. Free software, yours to run.</p>
        </footer>
    );
}
