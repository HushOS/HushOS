import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Terms, { frontmatter } from '@/content/legal/terms.mdx';
import { publicOrigin, readOperator } from '@/lib/social';

export const Route = createFileRoute('/terms')({
    loader: () => ({ origin: publicOrigin(), operator: readOperator() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: `${String(frontmatter.title)} · HushOS` },
            { name: 'description', content: String(frontmatter.summary) },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/terms` }] : [],
    }),
    component: LegalPage,
});

function LegalPage() {
    const { operator } = Route.useLoaderData();
    return <LegalLayout document={Terms} frontmatter={frontmatter} operator={operator} />;
}
