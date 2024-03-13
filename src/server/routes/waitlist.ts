import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import { waitlistInput } from '@/schemas/waitlist';

export const waitlistRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.waitlist(),
    summary: 'Add an email to the waitlist.',
    tags: ['Waitlist'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: waitlistInput,
                },
            },
            required: true,
            description: '',
        },
    },
    responses: {
        200: {
            description: 'Success',
        },
    },
};
