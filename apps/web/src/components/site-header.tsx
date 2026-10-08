import { Link, useLocation, useRouteContext, type LinkProps } from '@tanstack/react-router';
import { cn } from 'cn';
import { CheckIcon, MenuIcon } from 'lucide-react';
import { useState } from 'react';
import { Brand, Wordmark } from '@/components/brand';
import { container, StartFree } from '@/components/site';
import { ThemeToggle } from '@/components/theme-toggle';
import { buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { comparisons } from '@/lib/compare';
import { useInApp } from '@/lib/in-app';
import { rememberReturn, safeReturnPath } from '@/lib/return-to';

/*
 * The public site's header and footer. The header names every page (the one
 * you are on in ink and bold), Sign in as text and Start free as the only
 * filled button; on a phone the pages move into a sheet from the top. The
 * pages about plans show only where this server sells them.
 */

type Page = { to: LinkProps['to']; label: string; selling?: boolean };

const pages: Page[] = [
    { to: '/pricing', label: 'Pricing', selling: true },
    { to: '/teams', label: 'For teams', selling: true },
    { to: '/security', label: 'Security' },
    { to: '/about', label: 'About' },
    { to: '/blog', label: 'Blog' },
];

function usePages() {
    const { billingEnabled } = useRouteContext({ from: '__root__' });
    return pages.filter((page) => !page.selling || billingEnabled);
}

const isAt = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/* Sign in comes back to the page it was pressed on; a shared link keeps its key in this browser. */
function useSignIn() {
    const location = useLocation();
    const onLink = location.pathname.startsWith('/s/');
    const redirect = onLink
        ? undefined
        : (safeReturnPath(location.pathname + location.searchStr) ?? undefined);
    return {
        redirect,
        remember: () =>
            onLink &&
            rememberReturn(
                window.location.pathname + window.location.search + window.location.hash,
            ),
    };
}

/* Sign in as quiet text, or nothing when signed in: Start free then reads Go to Drive. */
export function SessionLinks() {
    const { hasSession } = useRouteContext({ from: '__root__' });
    const signIn = useSignIn();
    return (
        <>
            {!hasSession && (
                <Link
                    to="/login"
                    search={{ redirect: signIn.redirect }}
                    onClick={signIn.remember}
                    className="flex h-9 items-center rounded-md px-3 text-[15px] font-semibold whitespace-nowrap hover:bg-muted"
                >
                    Sign in
                </Link>
            )}
            <StartFree short className="ml-1" />
        </>
    );
}

export function SiteHeader() {
    const shown = usePages();
    const { pathname } = useLocation();
    if (useInApp()) return <AppHeader />;
    return (
        <header className="sticky top-0 z-30 border-b border-rule bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
            <div className={cn(container, 'flex h-14 items-center gap-1 sm:h-16')}>
                <Brand className="mr-2 lg:mr-6" />
                <nav aria-label="Site" className="hidden items-center gap-1 lg:flex">
                    {shown.map((page) => {
                        const here = isAt(pathname, page.to as string);
                        return (
                            <Link
                                key={page.label}
                                to={page.to}
                                aria-current={here ? 'page' : undefined}
                                className={cn(
                                    'flex h-9 items-center rounded-md px-3 text-[15px] whitespace-nowrap hover:bg-muted',
                                    here ? 'font-bold text-foreground' : 'text-muted-foreground',
                                )}
                            >
                                {page.label}
                            </Link>
                        );
                    })}
                </nav>
                <span className="flex-1" />
                <span className="max-lg:hidden">
                    <ThemeToggle />
                </span>
                <span className="flex items-center max-sm:hidden">
                    <SessionLinks />
                </span>
                <span className="sm:hidden">
                    <StartFree short />
                </span>
                <PhoneMenu shown={shown} pathname={pathname} />
            </div>
        </header>
    );
}

/* Opened from a phone app: the wordmark alone, leading nowhere. */
function AppHeader() {
    return (
        <header className="border-b border-rule bg-card">
            <div className={cn(container, 'flex h-14 items-center sm:h-16')}>
                <Wordmark />
            </div>
        </header>
    );
}

/* Below the wide breakpoint: every page in a sheet from the top, with the same two actions. */
function PhoneMenu({ shown, pathname }: { shown: Page[]; pathname: string }) {
    const [open, setOpen] = useState(false);
    const { hasSession } = useRouteContext({ from: '__root__' });
    const signIn = useSignIn();
    const all: Page[] = [{ to: '/', label: 'Drive' }, ...shown];
    return (
        <>
            <button
                type="button"
                aria-label="Menu"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                className="-mr-2 ml-1 flex size-10 cursor-pointer items-center justify-center rounded-md hover:bg-muted lg:hidden"
            >
                <MenuIcon className="size-[22px]" strokeWidth={2} aria-hidden="true" />
            </button>
            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent
                    side="top"
                    className="gap-0 rounded-b-2xl border-rule bg-card px-4 pt-3 pb-5"
                >
                    <SheetTitle className="flex h-11 items-center">
                        <Brand />
                    </SheetTitle>
                    <nav aria-label="Site" className="mt-2 flex flex-col">
                        {all.map((page) => {
                            const here =
                                page.to === '/'
                                    ? pathname === '/'
                                    : isAt(pathname, page.to as string);
                            return (
                                <Link
                                    key={page.label}
                                    to={page.to}
                                    onClick={() => setOpen(false)}
                                    aria-current={here ? 'page' : undefined}
                                    className={cn(
                                        'flex h-[52px] items-center justify-between border-b border-rule text-[19px]',
                                        here ? 'font-bold' : 'font-medium',
                                    )}
                                >
                                    {page.label}
                                    {here && (
                                        <CheckIcon
                                            className="size-5 text-primary"
                                            strokeWidth={2.6}
                                            aria-hidden="true"
                                        />
                                    )}
                                </Link>
                            );
                        })}
                    </nav>
                    <div className="mt-5 flex flex-col gap-2.5">
                        <StartFree className="w-full" />
                        {!hasSession && (
                            <Link
                                to="/login"
                                search={{ redirect: signIn.redirect }}
                                onClick={signIn.remember}
                                className={buttonVariants({
                                    size: 'lg',
                                    variant: 'outline',
                                    className: 'w-full',
                                })}
                            >
                                Sign in
                            </Link>
                        )}
                        <div className="flex items-center justify-between pt-1">
                            <span className="text-sm text-muted-foreground">
                                {hasSession ? '' : 'No card needed.'}
                            </span>
                            <ThemeToggle />
                        </div>
                    </div>
                </SheetContent>
            </Sheet>
        </>
    );
}

type FooterItem =
    | { label: string; to: LinkProps['to'] }
    | { label: string; vs: string }
    | { label: string; href: string };

const footerLink =
    'w-fit text-muted-foreground transition-colors hover:text-foreground hover:underline';

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
 * One line on what HushOS is, then four columns: the site, how it compares,
 * the code, and the legal pages. The last line says where the hosted service
 * runs, and only on the hosted service.
 */
export function SiteFooter() {
    if (useInApp()) return null;
    return <FullFooter />;
}

function FullFooter() {
    const year = new Date().getFullYear();
    const { operatorName, billingEnabled } = useRouteContext({ from: '__root__' });
    const shown = usePages();
    const columns: { title: string; items: FooterItem[] }[] = [
        {
            title: 'HushOS',
            items: [{ label: 'Drive', to: '/' }, ...shown.map(({ to, label }) => ({ to, label }))],
        },
        {
            title: 'Compare',
            items: comparisons.map((entry) => ({ label: `vs ${entry.name}`, vs: entry.slug })),
        },
        {
            title: 'Open source',
            items: [
                { label: 'Code on GitHub', href: 'https://github.com/HushOS/HushOS' },
                {
                    label: 'Run it yourself',
                    href: 'https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md',
                },
                {
                    label: 'Licence (AGPL-3.0)',
                    href: 'https://github.com/HushOS/HushOS/blob/main/LICENSE',
                },
            ],
        },
        {
            title: 'Legal',
            items: [
                { label: 'Support', to: '/support' },
                { label: 'Terms', to: '/terms' },
                { label: 'Privacy', to: '/privacy' },
            ],
        },
    ];
    return (
        <footer className="border-t border-rule bg-muted/50 text-[15px]">
            <div className={cn(container, 'py-10 sm:py-14')}>
                <div className="grid grid-cols-2 gap-x-8 gap-y-9 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
                    <div className="col-span-2 flex flex-col gap-3 lg:col-span-1">
                        <Brand className="w-fit" />
                        <p className="max-w-[19.9em] text-muted-foreground">
                            Private storage that works like the drive you already use.
                        </p>
                    </div>
                    {columns.map((column) => (
                        <nav
                            key={column.title}
                            aria-label={column.title}
                            className="flex flex-col gap-2.5"
                        >
                            <span className="font-bold">{column.title}</span>
                            {column.items.map((item) => (
                                <FooterLink key={item.label} item={item} />
                            ))}
                        </nav>
                    ))}
                </div>
                <div className="mt-12 flex flex-col gap-2 border-t border-rule pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span>
                        © {year} {(operatorName ?? 'HushOS').replace(/\.$/, '')}. Free software,
                        yours to run.
                    </span>
                    {billingEnabled && <span>Servers and storage in the EU.</span>}
                </div>
            </div>
        </footer>
    );
}
