import { waitlistInput } from '@/schemas/waitlist';
import { defineRoute } from '@/server/define-route';
import { waitlist } from '@/services/db/schema';

export const POST = defineRoute({
    input: waitlistInput,
    output: undefined,
    parseType: 'body',
    handler: async ({ db, input }) => {
        const { email } = input;
        try {
            await db.insert(waitlist).values({
                email,
                joinedAt: new Date(),
            });
        } catch {}
    },
});
