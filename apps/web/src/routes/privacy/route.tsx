import { createFileRoute } from '@tanstack/react-router';
import { LegalLayout } from '@/components/legal-layout';
import Privacy, { frontmatter } from '@/content/legal/privacy.mdx';
import { publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/privacy')({
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: `${String(frontmatter.title)} · HushOS` },
            { name: 'description', content: String(frontmatter.summary) },
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/privacy` }] : [],
    }),
    component: () => <LegalLayout document={Privacy} frontmatter={frontmatter} />,
});
