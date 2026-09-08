import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { ReadingPage } from '@/components/legal-layout';
import { formatDate, posts } from '@/lib/content';
import { publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/blog/')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'Blog · HushOS' },
            {
                name: 'description',
                content: 'Notes on how HushOS protects your data, and what is being built next.',
            },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/blog` }] : [],
    }),
    component: () => (
        <ReadingPage
            eyebrow="Blog"
            title="Notes from the build"
            summary="How HushOS protects your data, what is done, and what is being built next. Every claim here points at code you can read."
        >
            <ul className="mt-4 border bg-card">
                {posts.map((post) => (
                    <li key={post.slug} className="border-b last:border-b-0">
                        <Link
                            to="/blog/$slug"
                            params={{ slug: post.slug }}
                            data-cuelume-hover="tick"
                            className="group flex flex-col gap-2 px-5 py-5 transition-colors hover:bg-muted"
                        >
                            <span className="eyebrow text-muted-foreground">
                                {formatDate(post.meta.date)} · {post.meta.author}
                            </span>
                            <span className="flex items-start justify-between gap-6 text-lg font-medium tracking-tight text-balance">
                                {post.meta.title}
                                <ArrowRightIcon
                                    className="mt-1 size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
                                    aria-hidden="true"
                                />
                            </span>
                            <span className="text-sm leading-relaxed text-muted-foreground">
                                {post.meta.description}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </ReadingPage>
    ),
});
