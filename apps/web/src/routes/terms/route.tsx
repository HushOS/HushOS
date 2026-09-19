import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Terms from '@/content/legal/terms.mdx';
import { frontmatter } from '@/content/legal/terms.mdx?meta';
import { pageSocialMeta, publicOrigin, readOperator } from '@/lib/social';

export const Route = createFileRoute('/terms')({
    loader: () => ({ origin: publicOrigin(), operator: readOperator() }),
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/terms',
                  card: 'terms',
                  title: String(frontmatter.title),
                  description: String(frontmatter.summary),
              })
            : [{ title: `${String(frontmatter.title)} · HushOS` }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/terms` }] : [],
    }),
    component: LegalPage,
});

function LegalPage() {
    const { operator } = Route.useLoaderData();
    return <LegalLayout document={Terms} frontmatter={frontmatter} operator={operator} />;
}
