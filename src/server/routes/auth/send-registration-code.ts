import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import { sendRegistrationCodeInput } from '@/schemas/auth';

export const sendRegistrationCodeRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.auth.sendRegistrationCode(),
    summary: 'Emails the user a temporary registration code.',
    tags: ['Auth'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: sendRegistrationCodeInput,
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
};
