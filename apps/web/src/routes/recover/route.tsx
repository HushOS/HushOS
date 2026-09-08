import { createFileRoute, Outlet } from '@tanstack/react-router';
export const Route = createFileRoute('/recover')({
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({
        meta: [
            { title: 'Recover your account · HushOS' },
            { name: 'referrer', content: 'no-referrer' },
            { name: 'robots', content: 'noindex' },
        ],
    }),
    component: Outlet,
});
