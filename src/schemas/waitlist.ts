import { z } from '@/server/zod';

export const waitlistInput = z
    .object({
        email: z.string().email(),
    })
    .openapi('WaitlistInput', {
        example: {
            email: 'hey@hushos.com',
        },
    });

export type WaitlistInput = z.infer<typeof waitlistInput>;
