import { createFileRoute, notFound } from '@tanstack/react-router';
import { Cover } from '@/components/cover';
import { ReadingPage } from '@/components/legal-layout';
import { Mdx, mdxComponents } from '@/components/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps, ReactNode } from 'react';
import { formatDate, posts } from '@/lib/content';
import { postBodies, postHeadings } from '@/lib/post-bodies';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/blog/$slug')({
    loader: ({ params }) => {
        const post = posts.find((entry) => entry.slug === params.slug);
        if (!post) throw notFound();
        return { origin: publicOrigin(), slug: post.slug, meta: post.meta };
    },
    head: ({ loaderData }) =>
        loaderData
            ? {
                  meta: [
                      ...pageSocialMeta({
                          origin: loaderData.origin,
                          path: `/blog/${loaderData.slug}`,
                          card: `blog-${loaderData.slug}`,
                          title: loaderData.meta.title,
                          description: loaderData.meta.description,
                          type: 'article',
                      }),
                      { name: 'author', content: loaderData.meta.author },
                      { property: 'article:published_time', content: loaderData.meta.date },
                      { property: 'article:author', content: loaderData.meta.author },
                  ],
                  links: [
                      { rel: 'canonical', href: `${loaderData.origin}/blog/${loaderData.slug}` },
                  ],
                  scripts: [
                      {
                          type: 'application/ld+json',
                          children: JSON.stringify({
                              '@context': 'https://schema.org',
                              '@type': 'Article',
                              headline: loaderData.meta.title,
                              description: loaderData.meta.description,
                              datePublished: loaderData.meta.date,
                              author: { '@type': 'Organization', name: loaderData.meta.author },
                              publisher: {
                                  '@type': 'Organization',
                                  name: 'HushOS',
                                  logo: `${loaderData.origin}/brand/hushos-logo.svg`,
                              },
                              mainEntityOfPage: `${loaderData.origin}/blog/${loaderData.slug}`,
                          }),
                      },
                  ],
              }
            : {},
    component: PostPage,
});

/*
 * A post's sections carry their own link, shown beside the heading on hover, for
 * quoting a part. It sits after the words and out of the reading order, so a
 * screen reader's list of headings reads only the headings; the contents list
 * links every section for keyboards.
 */
const H2 = mdxComponents.h2 as (props: ComponentProps<'h2'>) => ReactNode;
const postComponents: MDXComponents = {
    h2: ({ children, ...props }) => (
        <H2 {...props}>
            {children}
            {props.id && (
                <a
                    href={`#${props.id}`}
                    className="heading-anchor"
                    aria-hidden="true"
                    tabIndex={-1}
                >
                    #
                </a>
            )}
        </H2>
    ),
};

function PostPage() {
    const { slug, meta } = Route.useLoaderData();
    const Content = postBodies[slug];
    if (!Content) return null;
    return (
        <ReadingPage
            identity="blog"
            meta={
                <span className="id-meta">
                    {formatDate(meta.date)} · {meta.author}
                </span>
            }
            title={meta.title}
            summary={meta.description}
            headings={postHeadings[slug]}
            banner={
                <div className="cover-wipe">
                    <Cover word={meta.cover ?? 'HUSH'} tone={meta.tone} seed={slug} rows={16} />
                </div>
            }
        >
            <Mdx document={Content} components={postComponents} />
        </ReadingPage>
    );
}
