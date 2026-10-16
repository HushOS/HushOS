import { createFileRoute, Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowRightIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Cover } from '@/components/cover';
import { container, H1, Lede, SitePage } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { formatDate, posts } from '@/lib/content';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/blog/')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/blog',
                  card: 'blog',
                  title: 'Blog',
                  description:
                      'Notes on how HushOS protects your data, and what is being built next.',
              })
            : [{ title: 'Blog · HushOS' }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/blog` }] : [],
    }),
    component: BlogIndex,
});

type Post = (typeof posts)[number];

/*
 * The notebook: the newest post large with its cover, then every other post as
 * an index row. Pointing at a row shows its cover in the space the title
 * leaves, so the list stays a list and the covers still get seen.
 */
function BlogIndex() {
    const [latest, ...rest] = posts;
    return (
        <SitePage identity="blog">
            <SiteHeader />
            <main className="flex-1">
                <div className={cn(container, 'pt-12 pb-10 sm:pt-16 lg:pt-20 lg:pb-14')}>
                    <div className="flex max-w-[780px] flex-col gap-5">
                        <p className="id-meta text-muted-foreground">Blog</p>
                        <H1>Notes from the build</H1>
                        <Lede>
                            How HushOS protects your data, what is done, and what is being built
                            next. Every claim here points at code you can read.
                        </Lede>
                    </div>
                </div>
                {latest && <Featured post={latest} />}
                {rest.length > 0 && <Index posts={rest} />}
            </main>
            <SiteFooter />
        </SitePage>
    );
}

function PostCover({ post, rows, className }: { post: Post; rows?: number; className?: string }) {
    return (
        <Cover
            word={post.meta.cover ?? 'HUSH'}
            tone={post.meta.tone}
            seed={post.slug}
            rows={rows}
            className={className}
        />
    );
}

function Featured({ post }: { post: Post }) {
    return (
        <section aria-label="Latest" className={cn(container, 'pb-14 lg:pb-20')}>
            <Link
                to="/blog/$slug"
                params={{ slug: post.slug }}
                className="group grid gap-6 lg:grid-cols-[7fr_5fr] lg:items-end lg:gap-12"
            >
                <div className="cover-wipe">
                    <PostCover post={post} />
                </div>
                <div className="flex flex-col gap-3 lg:pb-2">
                    <span className="id-meta text-muted-foreground">
                        {formatDate(post.meta.date)} · {post.meta.author}
                    </span>
                    <span className="text-[28px] leading-[1.1] font-extrabold tracking-[-0.025em] text-balance underline-offset-[6px] group-hover:underline sm:text-[36px]">
                        {post.meta.title}
                    </span>
                    <span className="text-[17px] leading-relaxed text-pretty text-muted-foreground">
                        {post.meta.description}
                    </span>
                    <span className="mt-1 inline-flex items-center gap-1.5 font-semibold text-primary">
                        Read it
                        <ArrowRightIcon
                            className="size-4 transition-transform group-hover:translate-x-0.5"
                            strokeWidth={2.3}
                            aria-hidden="true"
                        />
                    </span>
                </div>
            </Link>
        </section>
    );
}

type Preview = { post: Post; left: number; top: number; width: number; visible: boolean };

function Index({ posts }: { posts: Post[] }) {
    // Hiding keeps the last cover and place, so it fades out where it was.
    const [preview, setPreview] = useState<Preview | null>(null);
    const hide = () => setPreview((current) => current && { ...current, visible: false });
    const visible = preview?.visible ?? false;

    // The preview is fixed to the window, so any scroll or resize would leave it on the wrong row.
    useEffect(() => {
        if (!visible) return;
        const away = () => setPreview((current) => current && { ...current, visible: false });
        window.addEventListener('scroll', away, { passive: true });
        window.addEventListener('resize', away);
        return () => {
            window.removeEventListener('scroll', away);
            window.removeEventListener('resize', away);
        };
    }, [visible]);

    /*
     * Fits the cover between where the title's text ends and the author column,
     * centred on the row; no room, no preview. Measured on every enter, since
     * titles wrap differently at every width.
     */
    function show(post: Post, row: HTMLElement) {
        const title = row.querySelector<HTMLElement>('[data-title]');
        const author = row.querySelector<HTMLElement>('[data-author]');
        if (!title || !author) return;
        const range = document.createRange();
        range.selectNodeContents(title);
        const textRight = Math.min(
            range.getBoundingClientRect().right,
            title.getBoundingClientRect().right,
        );
        const start = textRight + 24;
        const room = author.getBoundingClientRect().left - 24 - start;
        if (room < 140) return hide();
        const width = Math.min(room, 280);
        const box = row.getBoundingClientRect();
        setPreview({
            post,
            left: start + (room - width) / 2,
            top: box.top + box.height / 2,
            width,
            visible: true,
        });
    }

    return (
        <section aria-labelledby="index-title" className={cn(container, 'pb-16 lg:pb-24')}>
            <h2 id="index-title" className="sr-only">
                Earlier notes
            </h2>
            <div
                aria-hidden="true"
                className="id-meta grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-x-6 border-b border-rule pb-3 text-muted-foreground max-sm:grid-cols-[minmax(0,1fr)]"
            >
                <span className="max-sm:hidden">Date</span>
                <span className="max-sm:hidden">Title</span>
                <span className="sm:hidden">Earlier notes</span>
                <span className="max-sm:hidden">By</span>
            </div>
            <ol onPointerLeave={hide}>
                {posts.map((post) => (
                    <li key={post.slug} className="border-b border-rule">
                        <Link
                            to="/blog/$slug"
                            params={{ slug: post.slug }}
                            onPointerEnter={(event) =>
                                event.pointerType === 'mouse' && show(post, event.currentTarget)
                            }
                            onFocus={hide}
                            className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 py-4 transition-colors duration-150 hover:bg-[var(--id-hover,var(--muted))] max-sm:grid-cols-[minmax(0,1fr)] sm:px-2 sm:-mx-2"
                        >
                            <span className="id-meta text-muted-foreground tabular-nums">
                                {formatDate(post.meta.date)}
                            </span>
                            <span
                                data-title
                                className="text-[19px] leading-snug font-semibold tracking-tight text-balance"
                            >
                                {post.meta.title}
                            </span>
                            <span
                                data-author
                                className="id-meta text-muted-foreground max-sm:hidden"
                            >
                                {post.meta.author}
                            </span>
                        </Link>
                    </li>
                ))}
            </ol>
            <div
                aria-hidden="true"
                className="post-preview"
                data-shown={preview?.visible ? '' : undefined}
                style={
                    preview
                        ? { left: preview.left, top: preview.top, width: preview.width }
                        : undefined
                }
            >
                {preview && <PostCover post={preview.post} />}
            </div>
        </section>
    );
}
