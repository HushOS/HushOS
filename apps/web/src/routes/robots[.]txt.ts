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
                        // Rules match by prefix, so /app also caught /apps, the phone apps' share
                        // link, whose card a preview must read. The longer rule wins (RFC 9309).
                        'Allow: /apps',
                        'Disallow: /api',
                        '',
                        `Sitemap: ${publicOrigin()}/sitemap.xml`,
                        '',
                    ].join('\n'),
                    {
                        headers: {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Cache-Control': 'public, max-age=3600',
                        },
                    },
                ),
        },
    },
});
