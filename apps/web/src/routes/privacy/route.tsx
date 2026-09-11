import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Privacy, { frontmatter } from '@/content/legal/privacy.mdx';
import { publicOrigin, readOperator } from '@/lib/social';

export const Route = createFileRoute('/privacy')({
    loader: () => ({ origin: publicOrigin(), operator: readOperator() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: `${String(frontmatter.title)} · HushOS` },
            { name: 'description', content: String(frontmatter.summary) },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/privacy` }] : [],
    }),
    component: LegalPage,
});

function LegalPage() {
    const { operator } = Route.useLoaderData();
    return <LegalLayout document={Privacy} frontmatter={frontmatter} operator={operator} />;
}
