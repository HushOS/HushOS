import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/register')({
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    beforeLoad: ({ context }) => {
        if (context.user) throw redirect({ to: '/app' });
    },
    head: () => ({
        meta: [
            { title: 'Create an account · HushOS' },
            { name: 'referrer', content: 'no-referrer' },
            { name: 'robots', content: 'noindex' },
        ],
    }),
    component: Outlet,
});
