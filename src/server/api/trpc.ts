import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';

import { getUser } from '@/lib/utils.server';
import { db } from '@/server/db';

export const createTRPCContext = async ({ headers }: { headers: Headers }) => {
    const user = await getUser();
    return {
        db,
        user,
        headers,
    };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
    transformer: superjson,
    errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: {
            ...shape.data,
            zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
        },
    }),
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async function isAuthed({ ctx: { user }, next }) {
    if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return next();
});
