import { createFileRoute } from '@tanstack/react-router';
import { posts } from '@/lib/content';
import { publicOrigin } from '@/lib/social';

const pages = [
    '/',
    '/blog',
    ...posts.map((post) => `/blog/${post.slug}`),
    '/security',
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
