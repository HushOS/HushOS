import { authRouter } from '@/server/api/routers/auth';
import { waitlistRouter } from '@/server/api/routers/waitlist';
import { createTRPCRouter } from '@/server/api/trpc';

export const appRouter = createTRPCRouter({
    auth: authRouter,
    waitlist: waitlistRouter,
});

export type AppRouter = typeof appRouter;
