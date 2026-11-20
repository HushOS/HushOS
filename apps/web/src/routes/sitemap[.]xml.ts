import { comparisons } from '@/lib/site/compare';
import { createFileRoute } from '@tanstack/react-router';
import { posts } from '@/lib/site/content';
import { publicOrigin } from '@/lib/site/social';

const pages = [
    '/',
    '/about',
    ...comparisons.map((entry) => `/vs/${entry.slug}`),
    '/blog',
    ...posts.map((post) => `/blog/${post.slug}`),
    '/security',
    '/roadmap',
    '/pricing',
    '/terms',
    '/privacy',
    '/design.md',
];

export const Route = createFileRoute('/sitemap.xml')({
    server: {
        handlers: {
            GET: () => {
                const origin = publicOrigin();
                const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((path) => `    <url><loc>${origin}${path}</loc></url>`).join('\n')}
</urlset>
`;
                return new Response(body, {
                    headers: {
                        'Content-Type': 'application/xml; charset=utf-8',
                        'Cache-Control': 'public, max-age=3600',
                    },
                });
            },
        },
    },
});
