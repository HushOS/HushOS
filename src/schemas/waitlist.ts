import * as z from 'zod';

export const waitlistSchema = z.object({
    email: z.string().email(),
});

export type Waitlist = z.infer<typeof waitlistSchema>;
