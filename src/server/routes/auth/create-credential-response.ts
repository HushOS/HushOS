import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import {
    initiateOpaqueCredentialResponseInput,
    initiateOpaqueResponseOutput,
} from '@/schemas/auth';

export const createCredentialResponseRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.auth.createCredentialResponse(),
    summary: 'Create credential response.',
    tags: ['Auth'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: initiateOpaqueCredentialResponseInput,
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
                    schema: initiateOpaqueResponseOutput,
                },
            },
        },
    },
};
