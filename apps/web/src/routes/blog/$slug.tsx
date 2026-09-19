import { createFileRoute, notFound } from '@tanstack/react-router';
import { ReadingPage } from '@/components/legal-layout';
import { Mdx } from '@/components/mdx';
import { formatDate, posts } from '@/lib/content';
import { postBodies } from '@/lib/post-bodies';
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

function PostPage() {
    const { slug, meta } = Route.useLoaderData();
    const Content = postBodies[slug];
    if (!Content) return null;
    return (
        <ReadingPage
            eyebrow={`${formatDate(meta.date)} · ${meta.author}`}
            title={meta.title}
            summary={meta.description}
        >
            <Mdx document={Content} />
        </ReadingPage>
    );
}
