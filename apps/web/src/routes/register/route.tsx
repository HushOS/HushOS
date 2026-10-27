import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { cardMeta, publicOrigin } from '@/lib/social';
import { ensureSessionUser } from '@/lib/session';

export const Route = createFileRoute('/register')({
    // A plan from the pricing page, and a referral or affiliate code from an invite or a creator's page.
    validateSearch: (
        search: Record<string, unknown>,
    ): { plan?: string; ref?: string; currency?: string } => ({
        ...(typeof search.plan === 'string' ? { plan: search.plan } : {}),
        // The currency a family tier was shown in on Pricing.
        ...(typeof search.currency === 'string' && /^[a-z]{3}$/.test(search.currency)
            ? { currency: search.currency }
            : {}),
        ...(typeof search.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(search.ref)
            ? { ref: search.ref }
            : {}),
    }),
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
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'Create an account · HushOS' },
            ...(loaderData
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'register',
                      title: 'Your private drive starts here',
                      description: 'Everything is locked on your device first. We can’t open it.',
                  })
                : []),
            { name: 'referrer', content: 'no-referrer' },
            { name: 'robots', content: 'noindex' },
        ],
    }),
    component: Outlet,
});
