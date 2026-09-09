import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { ensureSessionUser } from '@/lib/session';

export const Route = createFileRoute('/register')({
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    beforeLoad: async ({ context, preload }) => {
        if (preload) return;
        const user = await ensureSessionUser(context.queryClient).catch(() => null);
        if (user) throw redirect({ to: '/app' });
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
