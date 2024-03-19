import { createRoute, OpenAPIHono } from '@hono/zod-openapi';

import { waitlistSchema } from '@/schemas/waitlist';
import { ContextVariables } from '@/server/types';
import { waitlist } from '@/services/db/schema';

export const waitlistApp = new OpenAPIHono<{ Variables: ContextVariables }>().openapi(
    createRoute({
        method: 'post',
        path: '/api/waitlist',
        tags: ['Waitlist'],
        summary: 'Add an email to the waitlist',
        request: {
            body: {
                description: 'Request body',
                content: {
                    'application/json': {
                        schema: waitlistSchema.openapi('Waitlist', {
                            example: {
                                email: 'hey@hushos.com',
                            },
                        }),
                    },
                },
                required: true,
            },
        },
        responses: {
            200: {
                description: 'Success',
            },
        },
    }),
    async c => {
        const { email } = c.req.valid('json');
        const db = c.get('db');

        try {
            await db.insert(waitlist).values({
                email,
                joinedAt: new Date(),
            });
        } catch {}

        return c.json({});
    }
);
