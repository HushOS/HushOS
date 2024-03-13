import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import { userAuthInput, userKeys } from '@/schemas/auth';

export const userAuthRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.auth.userAuth(),
    summary: 'Authorize user.',
    tags: ['Auth'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: userAuthInput,
                },
            },
            required: true,
        },
    },
    responses: {
        200: {
            description: 'Success',
            content: {
                'application/json': {
                    schema: userKeys,
                },
            },
        },
    },
};
