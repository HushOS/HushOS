import { createFileRoute, Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowRightIcon } from 'lucide-react';
import { Cover } from '@/components/cover';
import { DitherAvatar } from '@/components/dither-kit/avatar';
import { DitherGradient } from '@/components/dither-kit/gradient';
import { ReadingPage } from '@/components/legal-layout';
import {
    sections,
    updated,
    type RoadmapItem,
    type RoadmapLink,
    type RoadmapStatus,
} from '@/content/roadmap';
import type { CoverTone } from '@/lib/content';
import { formatDate } from '@/lib/content';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

/*
 * The public roadmap: what has shipped, what is being built, and what is
 * planned, from content/roadmap.ts, the one place it is written. A reading
 * page in its own identity (a trail map, DESIGN.md → Dither), every item with
 * an anchor so it can be linked, and no action of its own: the header's Start
 * free stays the page's one blue button.
 */

const description =
    'What HushOS has shipped, what is being built now, and what is planned. It changes as work ships.';

export const Route = createFileRoute('/roadmap')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/roadmap',
                  card: 'roadmap',
                  title: 'Roadmap',
                  description,
              })
            : [{ title: 'Roadmap · HushOS' }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/roadmap` }] : [],
    }),
    component: RoadmapPage,
});

const REPO = 'https://github.com/HushOS/HushOS';

/*
 * Each section's mark: a short word in dots on its own tone, seeded by the section so it never
 * changes between builds. Decoration over the heading beside it, hidden from screen readers; it
 * stays in high contrast, as covers do (DESIGN.md → Dither).
 */
const MARKS: Record<RoadmapStatus, { word: string; tone: CoverTone }> = {
    shipped: { word: 'DONE', tone: 'sage' },
    now: { word: 'NOW', tone: 'lime' },
    next: { word: 'NEXT', tone: 'sun' },
    later: { word: 'LATER', tone: 'quiet' },
};
const linkClass =
    'inline-flex w-fit items-center gap-1.5 text-[15px] font-semibold text-primary underline-offset-4 hover:underline';

function ItemLink({ link }: { link: RoadmapLink }) {
    const inside = (
        <>
            {link.label}
            <ArrowRightIcon className="size-4" strokeWidth={2.3} aria-hidden="true" />
        </>
    );
    if (link.kind === 'blog')
        return (
            <Link to="/blog/$slug" params={{ slug: link.slug }} className={linkClass}>
                {inside}
            </Link>
        );
    if (link.kind === 'page')
        return (
            <Link to={link.to} className={linkClass}>
                {inside}
            </Link>
        );
    const href =
        link.kind === 'docs'
            ? `${REPO}/blob/main/${link.path}`
            : `${REPO}/releases/tag/${link.tag}`;
    return (
        <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
            {inside}
        </a>
    );
}

/*
 * The timeline (decoration only, hidden from screen readers): one rail down the page, solid from
 * Today back through what shipped, dashed above it into Next and Later, which carry no dates and
 * fade towards the top. The rail runs at the left edge on a phone and beside a column of month
 * markers from 768px. Every row shares the rail's x, `--rail`.
 */
const RAIL = '[--rail:7px] md:[--rail:calc(8rem+2rem+7px)]';
const row = 'relative grid gap-x-8 md:grid-cols-[8rem_minmax(0,1fr)]';
const node = 'pointer-events-none absolute left-[var(--rail)] -translate-x-1/2 rounded-full';
const PLANNED: RoadmapStatus[] = ['later', 'next'];

const line = 'pointer-events-none absolute left-[var(--rail)] w-0 -translate-x-1/2 border-l-2';
const dashed = 'border-dashed border-rule';
const solid = 'border-solid border-muted-foreground/40';

function Rail({ status }: { status: RoadmapStatus }) {
    // Now's rail stays dashed down to Today, its first row, and turns solid there.
    if (status === 'now')
        return (
            <>
                <span aria-hidden="true" className={cn(line, dashed, 'top-0 h-[3.4rem]')} />
                <span aria-hidden="true" className={cn(line, solid, 'top-[3.4rem] bottom-0')} />
            </>
        );
    return (
        <span
            aria-hidden="true"
            className={cn(
                line,
                'top-0 bottom-0',
                PLANNED.includes(status) ? dashed : solid,
                // The farthest plans fade into the page above them.
                status === 'later' &&
                    '[mask-image:linear-gradient(to_bottom,transparent,black_45%)]',
            )}
        />
    );
}

/* The month a shipped item reached hushos.com, as a marker once per month. */
const monthOf = (item: RoadmapItem) => (item.status === 'shipped' ? item.month : null);
const monthStart = (month: string) => Date.parse(`1 ${month} UTC`);

function Item({ item, month }: { item: RoadmapItem; month: string | null }) {
    const now = item.status === 'now';
    const planned = PLANNED.includes(item.status);
    return (
        <li id={item.id} className={cn(row, 'scroll-mt-24 py-5')}>
            {/* The month marker on the rail, said once per month; the item's own line says it too. */}
            <span
                aria-hidden="true"
                className="hidden pt-0.5 text-right text-[13px] font-semibold text-muted-foreground tabular-nums md:block"
            >
                {month}
            </span>
            <span
                aria-hidden="true"
                className={cn(
                    node,
                    'top-[1.65rem] size-3',
                    now
                        ? 'bg-accent ring-2 ring-primary'
                        : planned
                          ? 'border-2 border-field bg-card'
                          : 'bg-muted-foreground',
                    month && !now && 'size-3.5',
                )}
            />
            <div className="min-w-0 pl-8">
                {month && (
                    <p
                        aria-hidden="true"
                        className="mb-1 text-[13px] font-semibold text-muted-foreground md:hidden"
                    >
                        {month}
                    </p>
                )}
                <h3 className="text-lg leading-snug font-bold text-balance">
                    {item.title}
                    <a
                        href={`#${item.id}`}
                        className="heading-anchor"
                        aria-label={`Link to ${item.title}`}
                    >
                        #
                    </a>
                </h3>
                <p className="mt-1 flex items-center gap-2 text-[15px] text-muted-foreground">
                    {/* The area's own small dithered mark, the same everywhere it appears; gone in high contrast. */}
                    <DitherAvatar name={item.area} size={14} className="dither-mark rounded-xs" />
                    <span>
                        {item.area}
                        {item.status === 'shipped' && ` · ${item.month}`}
                    </span>
                </p>
                <p className="mt-3 leading-relaxed text-pretty">{item.body}</p>
                {item.links && item.links.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                        {item.links.map((link) => (
                            <ItemLink key={link.label} link={link} />
                        ))}
                    </div>
                )}
            </div>
        </li>
    );
}

/*
 * Top to bottom the page runs from the farthest plans down to what shipped first: Later and Next
 * fade upwards into the future, Today marks where the rail turns solid, Now sits on it, and
 * Shipped goes back in time below, newest month first.
 */
const ORDER: RoadmapStatus[] = ['later', 'next', 'now', 'shipped'];
const timeline = ORDER.map((status) => {
    const section = sections.find((entry) => entry.status === status)!;
    if (status !== 'shipped') return section;
    // Newest month first; items of one month keep the order roadmap.ts gives them.
    const items = section.items
        .map((item, index) => ({ item, index }))
        .sort(
            (a, b) =>
                monthStart(monthOf(b.item)!) - monthStart(monthOf(a.item)!) || a.index - b.index,
        )
        .map(({ item }) => item);
    return { ...section, items };
});

function RoadmapPage() {
    return (
        <ReadingPage
            identity="roadmap"
            eyebrow={<time dateTime={updated}>Last updated {formatDate(updated)}</time>}
            title="Roadmap"
            summary={description}
            headings={timeline.map((section) => ({ id: section.status, title: section.title }))}
            banner={
                // The cover on a dither-kit wash rising from its foot, as the home page's band has;
                // the wash goes in high contrast, the cover stays (identities.css).
                <div className="relative isolate px-3 pt-3 pb-8 sm:px-6 sm:pt-6 sm:pb-12">
                    <DitherGradient
                        from={150}
                        direction="up"
                        cell={4}
                        opacity={0.5}
                        className="id-wash -z-10 rounded-md"
                    />
                    <div className="cover-wipe overflow-hidden rounded-md shadow-sm">
                        <Cover word="AHEAD" tone="mint" seed="roadmap" cols={96} rows={16} dither />
                    </div>
                </div>
            }
        >
            <div className={RAIL}>
                {timeline.map((section) => (
                    <section
                        key={section.status}
                        aria-labelledby={section.status}
                        className="relative pt-12 first:pt-2"
                    >
                        <Rail status={section.status} />
                        {section.status === 'now' && (
                            // Today: where the rail turns solid. Said by the headings already, so decoration.
                            <div aria-hidden="true" className={cn(row, 'pb-6')}>
                                <span className="hidden text-right text-[13px] font-bold text-primary md:block">
                                    Today
                                </span>
                                <span className={cn(node, 'top-0.5 size-4 bg-primary')} />
                                <span className="pl-8 text-[13px] font-bold text-primary md:hidden">
                                    Today
                                </span>
                            </div>
                        )}
                        <div className={row}>
                            {/* The section's dithered cover, its marker beside the rail. */}
                            <div className="hidden md:block">
                                <div className="cover-wipe ml-auto w-28 overflow-hidden rounded-xs">
                                    <Cover
                                        word={MARKS[section.status].word}
                                        tone={MARKS[section.status].tone}
                                        seed={`roadmap-${section.status}`}
                                        cols={32}
                                        rows={11}
                                        dither
                                    />
                                </div>
                            </div>
                            <span
                                aria-hidden="true"
                                className={cn(
                                    node,
                                    // Centred on the section's cover: 96px wide on phones (33px tall at
                                    // 32x11 dots), 112px beside the rail from md (38.5px tall).
                                    'top-[6.5px] size-5 border-2 bg-card md:top-[9.25px]',
                                    section.status === 'now'
                                        ? 'border-primary'
                                        : PLANNED.includes(section.status)
                                          ? 'border-dashed border-field'
                                          : 'border-muted-foreground',
                                )}
                            />
                            <div className="min-w-0 pl-8">
                                <div className="cover-wipe mb-3 w-24 overflow-hidden rounded-xs md:hidden">
                                    <Cover
                                        word={MARKS[section.status].word}
                                        tone={MARKS[section.status].tone}
                                        seed={`roadmap-${section.status}`}
                                        cols={32}
                                        rows={11}
                                        dither
                                    />
                                </div>
                                {/* A post's section heading, as the contents list beside it expects. */}
                                <h2
                                    id={section.status}
                                    className="scroll-mt-24 text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance sm:text-[28px]"
                                >
                                    {section.title}
                                </h2>
                                <p className="mt-2 text-muted-foreground">{section.summary}</p>
                            </div>
                        </div>
                        <ul className="mt-2 flex flex-col">
                            {section.items.map((item, index) => {
                                const month = monthOf(item);
                                const first =
                                    month !== null &&
                                    (index === 0 || monthOf(section.items[index - 1]!) !== month);
                                return (
                                    <Item key={item.id} item={item} month={first ? month : null} />
                                );
                            })}
                        </ul>
                    </section>
                ))}
            </div>
        </ReadingPage>
    );
}
