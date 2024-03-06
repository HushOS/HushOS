import { z } from 'zod';

import { createTRPCRouter, publicProcedure } from '@/server/api/trpc';
import { db } from '@/server/db';
import { waitlist } from '@/server/db/schema';

export const waitlistRouter = createTRPCRouter({
    join: publicProcedure
        .input(
            z.object({
                email: z.string().email(),
            })
        )
        .mutation(async ({ input: { email } }) => {
            try {
                await db.insert(waitlist).values({
                    email,
                    joinedAt: new Date(),
                });
            } catch {}
        }),
});
