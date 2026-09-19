import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { ReadingPage } from '@/components/legal-layout';
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
    component: () => (
        <ReadingPage
            eyebrow="Blog"
            title="Notes from the build"
            summary="How HushOS protects your data, what is done, and what is being built next. Every claim here points at code you can read."
        >
            <ul>
                {posts.map((post) => (
                    <li key={post.slug} className="border-b border-rule last:border-b-0">
                        <Link
                            to="/blog/$slug"
                            params={{ slug: post.slug }}
                            className="group flex flex-col gap-2 py-6"
                        >
                            <span className="text-xs text-muted-foreground tabular-nums">
                                {formatDate(post.meta.date)} · {post.meta.author}
                            </span>
                            <span className="flex items-start justify-between gap-6 text-xl font-bold tracking-tight text-balance transition-colors group-hover:text-primary">
                                {post.meta.title}
                                <ArrowRightIcon
                                    className="mt-1.5 size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
                                    aria-hidden="true"
                                />
                            </span>
                            <span className="leading-relaxed text-muted-foreground">
                                {post.meta.description}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </ReadingPage>
    ),
});
