import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Terms, { frontmatter } from '@/content/legal/terms.mdx';
import { publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/terms')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: `${String(frontmatter.title)} · HushOS` },
            { name: 'description', content: String(frontmatter.summary) },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/terms` }] : [],
    }),
    component: () => <LegalLayout document={Terms} frontmatter={frontmatter} />,
});
