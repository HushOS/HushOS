import { createFileRoute, redirect } from '@tanstack/react-router';
import { safeReturnPath } from '@/lib/return-to';
import { ensureSessionUser } from '@/lib/session';

/*
 * One guard for every signed-in surface (/app/*, /setup/*). It is route UX, not the
 * data boundary: every /api/auth handler checks the session itself. A failed lookup
 * throws, which renders the retryable error page rather than the sign-in page.
 */
export const Route = createFileRoute('/_authenticated')({
    beforeLoad: async ({ context, location }) => {
        const user = await ensureSessionUser(context.queryClient);
        // The page asked for rides along, so signing in comes back to it (see lib/return-to).
        if (!user)
            throw redirect({
                to: '/login',
                search: {
                    redirect: safeReturnPath(location.pathname + location.searchStr) ?? undefined,
                },
            });
        return { user };
    },
});
