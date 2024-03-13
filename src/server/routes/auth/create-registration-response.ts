import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import { createRegistrationResponseInput, createRegistrationResponseOutput } from '@/schemas/auth';

export const createRegistrationResponseRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.auth.createRegistrationResponse(),
    summary: 'Create registration response',
    tags: ['Auth'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: createRegistrationResponseInput,
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
                    schema: createRegistrationResponseOutput,
                },
            },
        },
    },
};
