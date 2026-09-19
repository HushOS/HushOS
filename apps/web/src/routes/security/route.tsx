import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Security from '@/content/security.mdx';
import { frontmatter } from '@/content/security.mdx?meta';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/security')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/security',
                  card: 'security',
                  title: String(frontmatter.title),
                  description: String(frontmatter.summary),
              })
            : [{ title: `${String(frontmatter.title)} · HushOS` }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/security` }] : [],
    }),
    component: () => <LegalLayout document={Security} frontmatter={frontmatter} />,
});
