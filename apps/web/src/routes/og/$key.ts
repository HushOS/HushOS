import { createFileRoute } from '@tanstack/react-router';
import { socialImage } from '@/lib/og.server';

/*
 * The social card for one public page: /og/about.jpg, /og/blog-<slug>.jpg,
 * /og/vs-<slug>.jpg and so on. The segment is the key plus the extension.
 */
export const Route = createFileRoute('/og/$key')({
    server: {
        handlers: {
            GET: ({ params }) =>
                params.key.endsWith('.jpg')
                    ? socialImage(params.key.slice(0, -4))
                    : new Response('Not found', { status: 404 }),
        },
    },
});
