import { createFileRoute } from '@tanstack/react-router';
import guidelines from '../../../../DESIGN.md?raw';

/* Public design guidelines, served as plain markdown like vercel.com/design.md. */
export const Route = createFileRoute('/design.md')({
    server: {
        handlers: {
            GET: () =>
                new Response(guidelines, {
                    headers: {
                        'Content-Type': 'text/markdown; charset=utf-8',
                        'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'public, max-age=300',
                    },
                }),
        },
    },
});
