import { RouteConfig } from '@asteasolutions/zod-to-openapi';

import { ApiRoutes } from '@/lib/routes';
import { storeUserRecordInput } from '@/schemas/auth';

export const storeUserRecordRouteConfig: RouteConfig = {
    method: 'post',
    path: ApiRoutes.auth.storeUserRecord(),
    summary: "Stores the user's OPAQUE record for future use and also stores user's key bundle.",
    tags: ['Auth'],
    request: {
        body: {
            content: {
                'application/json': {
                    schema: storeUserRecordInput,
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
