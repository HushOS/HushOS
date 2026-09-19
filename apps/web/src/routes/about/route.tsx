import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import About from '@/content/about.mdx';
import { frontmatter } from '@/content/about.mdx?meta';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/about')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/about',
                  card: 'about',
                  title: String(frontmatter.title),
                  description: String(frontmatter.summary),
              })
            : [{ title: `${String(frontmatter.title)} · HushOS` }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/about` }] : [],
    }),
    component: () => <LegalLayout document={About} frontmatter={frontmatter} />,
});
