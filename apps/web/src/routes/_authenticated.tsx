import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSessionUser } from '@/lib/session';

/*
 * One guard for every signed-in surface (/app/*, /setup/*). It is route UX, not the
 * data boundary: every /api/auth handler checks the session itself. A failed lookup
 * throws, which renders the retryable error page rather than the sign-in page.
 */
export const Route = createFileRoute('/_authenticated')({
    beforeLoad: async ({ context }) => {
        const user = await ensureSessionUser(context.queryClient);
        if (!user) throw redirect({ to: '/login' });
        return { user };
    },
});
