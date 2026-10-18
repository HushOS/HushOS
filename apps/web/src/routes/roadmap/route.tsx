import { createFileRoute, Link } from '@tanstack/react-router';
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

function Item({ item }: { item: RoadmapItem }) {
    return (
        <li id={item.id} className="scroll-mt-24 border-t border-rule py-6 first:border-t-0">
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
        </li>
    );
}

function RoadmapPage() {
    return (
        <ReadingPage
            identity="roadmap"
            eyebrow={<time dateTime={updated}>Last updated {formatDate(updated)}</time>}
            title="Roadmap"
            summary={description}
            headings={sections.map((section) => ({ id: section.status, title: section.title }))}
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
            {sections.map((section) => (
                <section
                    key={section.status}
                    aria-labelledby={section.status}
                    className="mt-14 first:mt-0"
                >
                    <div className="flex items-center gap-4">
                        <div className="cover-wipe w-24 shrink-0 overflow-hidden rounded-xs sm:w-32">
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
                    </div>
                    <p className="mt-2 text-muted-foreground">{section.summary}</p>
                    <ul className="mt-4 flex flex-col border-t border-rule">
                        {section.items.map((item) => (
                            <Item key={item.id} item={item} />
                        ))}
                    </ul>
                </section>
            ))}
        </ReadingPage>
    );
}
