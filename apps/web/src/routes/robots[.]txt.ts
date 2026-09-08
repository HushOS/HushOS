import { createFileRoute } from '@tanstack/react-router';
import { publicOrigin } from '@/lib/social';

export const Route = createFileRoute('/robots.txt')({
    server: {
        handlers: {
            GET: () =>
                new Response(
                    [
                        'User-agent: *',
                        'Allow: /',
                        'Disallow: /app',
                        'Disallow: /api',
                        '',
                        `Sitemap: ${publicOrigin()}/sitemap.xml`,
                        '',
                    ].join('\n'),
                    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
                ),
        },
    },
});
