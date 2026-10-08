import { cn } from 'cn';
import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Mdx } from '@/components/mdx';
import { container, H1, Lede } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { formatDate } from '@/lib/content';
import type { MDXComponents } from 'mdx/types';

/*
 * The security page: eight plain steps, each with its exact terms one click
 * below, then what the server sees, where it runs, and what it can't do. The
 * document is MDX; it draws its own contents list and body from the pieces
 * here, so the list and the headings come from one table of titles.
 */

export function SecurityPage({
    document,
    frontmatter,
}: {
    document: ComponentType<{ components?: MDXComponents }>;
    frontmatter: Record<string, unknown>;
}) {
    return (
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <div className={cn(container, 'pt-12 pb-10 sm:pt-16 lg:pt-20 lg:pb-14')}>
                    <div className="flex max-w-[780px] flex-col gap-5">
                        <p className="text-[15px] text-muted-foreground">
                            Updated {formatDate(String(frontmatter.updated))}
                        </p>
                        <H1>{String(frontmatter.heading)}</H1>
                        <Lede>{String(frontmatter.lede)}</Lede>
                    </div>
                </div>
                <div
                    className={cn(
                        container,
                        'pb-16 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-16 lg:pb-24',
                    )}
                >
                    <Mdx document={document} />
                </div>
            </main>
            <SiteFooter />
        </div>
    );
}

/* Section ids and titles, in page order. */
type Items = Record<string, string>;

/*
 * The contents: a fold at the top on a phone, a list that stays in view on the
 * left on a wide screen, marking the section being read.
 */
export function Contents({ items }: { items: Items }) {
    const ids = Object.keys(items);
    const [current, setCurrent] = useState(ids[0]);

    useEffect(() => {
        const ids = Object.keys(items);
        let frame = 0;
        // The section being read is the last one whose top has passed under the header.
        const update = () => {
            frame = 0;
            const atEnd =
                window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
            let reading = ids[0];
            for (const id of ids) {
                const top = document.getElementById(id)?.getBoundingClientRect().top;
                if (top !== undefined && (top <= 140 || atEnd)) reading = id;
            }
            setCurrent(reading);
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        update();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            window.removeEventListener('scroll', onScroll);
            cancelAnimationFrame(frame);
        };
    }, [items]);

    const links = (spacing: string) =>
        ids.map((id) => (
            <a
                key={id}
                href={`#${id}`}
                // On a phone, picking a section folds the list away again.
                onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
                aria-current={current === id ? 'location' : undefined}
                className={cn(
                    spacing,
                    'rounded-xs leading-snug outline-none focus-visible:outline-2 focus-visible:outline-ring',
                    current === id
                        ? 'font-bold text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                )}
            >
                {items[id]}
            </a>
        ));

    return (
        <>
            <details className="group mb-10 border-y border-rule lg:hidden">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-bold outline-none focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    On this page
                    <ChevronDownIcon
                        className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                        strokeWidth={2.2}
                        aria-hidden="true"
                    />
                </summary>
                <nav aria-label="On this page" className="flex flex-col pb-4 text-[15px]">
                    {links('py-2.5')}
                </nav>
            </details>
            <nav
                aria-label="On this page"
                className="sticky top-24 hidden flex-col gap-0.5 text-sm lg:flex"
            >
                <p className="pb-2 font-bold">On this page</p>
                {links('py-1.5')}
            </nav>
        </>
    );
}

/* The column the steps and sections run down. */
export function Body({ children }: { children: ReactNode }) {
    return <div className="flex max-w-[760px] min-w-0 flex-col">{children}</div>;
}

const sectionClass =
    'scroll-mt-24 border-t border-rule py-10 first:border-t-0 first:pt-0 sm:py-12 sm:first:pt-0';

const headingClass =
    'text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance sm:text-[28px]';

/* One numbered step: a plain account, then its exact terms. */
export function Step({
    id,
    n,
    title,
    children,
}: {
    id: string;
    n: number;
    title: string;
    children: ReactNode;
}) {
    return (
        <section id={id} aria-labelledby={`${id}-title`} className={sectionClass}>
            <h2 id={`${id}-title`} className={cn(headingClass, 'flex gap-3')}>
                <span className="text-muted-foreground tabular-nums">{n}</span>
                <span>{title}</span>
            </h2>
            <div className="text-[17px] leading-[1.65] text-pretty">{children}</div>
        </section>
    );
}

/* A section after the steps, without a number. */
export function Section({
    id,
    title,
    children,
}: {
    id: string;
    title: string;
    children: ReactNode;
}) {
    return (
        <section id={id} aria-labelledby={`${id}-title`} className={sectionClass}>
            <h2 id={`${id}-title`} className={headingClass}>
                {title}
            </h2>
            <div className="text-[17px] leading-[1.65] text-pretty [&_li]:mt-3 [&_ul]:mt-5 [&_ul]:space-y-0 [&_ul]:text-foreground">
                {children}
            </div>
        </section>
    );
}

/* "The exact terms": today's values, folded under a step. */
export function Exact({ open = false, children }: { open?: boolean; children: ReactNode }) {
    return (
        <details open={open} className="group mt-5">
            <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1.5 rounded-xs text-[15px] font-semibold text-primary outline-none focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">The exact terms</span>
                <span className="hidden group-open:inline">Hide the exact terms</span>
                <ChevronDownIcon
                    className="size-4 transition-transform group-open:rotate-180"
                    strokeWidth={2.4}
                    aria-hidden="true"
                />
            </summary>
            <div className="mt-3 rounded-xl bg-card px-4 py-3 sm:py-4 text-[15px] leading-relaxed text-muted-foreground sm:px-5 [&>:first-child]:mt-0">
                {children}
            </div>
        </details>
    );
}

/* Terms and their values; an optional small title names the group. */
export function Terms({ title, rows }: { title?: string; rows: [string, ReactNode][] }) {
    return (
        <div className="mt-6 first:mt-0">
            {title && <p className="pb-1 text-sm font-bold text-foreground">{title}</p>}
            <dl className="text-[15px]">
                {rows.map(([term, value]) => (
                    <div
                        key={term}
                        className="grid gap-x-6 gap-y-0.5 border-b border-rule py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)]"
                    >
                        <dt className="font-semibold text-foreground">{term}</dt>
                        <dd className="leading-relaxed text-muted-foreground">{value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
