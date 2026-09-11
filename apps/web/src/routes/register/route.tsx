import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { ensureSessionUser } from '@/lib/session';

export const Route = createFileRoute('/register')({
    validateSearch: (search: Record<string, unknown>): { plan?: string } =>
        typeof search.plan === 'string' ? { plan: search.plan } : {},
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    beforeLoad: async ({ context, location, preload }) => {
        if (preload) return { user: null };
        const user = await ensureSessionUser(context.queryClient).catch(() => null);
        // The complete page holds a one-time link; it offers sign-out instead of bouncing.
        if (user && location.pathname !== '/register/complete') throw redirect({ to: '/app' });
        return { user };
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
