import { createFileRoute, notFound } from '@tanstack/react-router';
import { ReadingPage } from '@/components/legal-layout';
import { Mdx } from '@/components/mdx';
import { formatDate, posts } from '@/lib/content';
import { publicOrigin } from '@/lib/social';

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
                      { title: `${loaderData.meta.title} · HushOS` },
                      { name: 'description', content: loaderData.meta.description },
                      { name: 'author', content: loaderData.meta.author },
                      { property: 'og:type', content: 'article' },
                      { property: 'og:title', content: loaderData.meta.title },
                      { property: 'og:description', content: loaderData.meta.description },
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

function PostPage() {
    const { slug, meta } = Route.useLoaderData();
    const post = posts.find((entry) => entry.slug === slug);
    if (!post) return null;
    return (
        <ReadingPage
            eyebrow={`${formatDate(meta.date)} · ${meta.author}`}
            title={meta.title}
            summary={meta.description}
        >
            <Mdx document={post.Content} />
        </ReadingPage>
    );
}
