import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Security, { frontmatter } from '@/content/security.mdx';
import { publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/security')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: `${String(frontmatter.title)} · HushOS` },
            { name: 'description', content: String(frontmatter.summary) },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/security` }] : [],
    }),
    component: () => <LegalLayout document={Security} frontmatter={frontmatter} />,
});
