import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { getCookie } from 'hono/cookie';

import { Routes } from '@/lib/routes';
import { ContextVariables } from '@/server/types';
import { lucia } from '@/services/auth';

export const logoutApp = new OpenAPIHono<{ Variables: ContextVariables }>().openapi(
    createRoute({
        method: 'get',
        path: '/api/auth/logout',
        tags: ['Auth'],
        summary: 'Logout',
        responses: {
            200: {
                description: 'Success',
            },
        },
    }),
    async c => {
        const sessionId = getCookie(c, lucia.sessionCookieName);
        if (!sessionId) {
            return c.redirect(Routes.login());
        }

        await lucia.invalidateSession(sessionId);
        return c.redirect(Routes.login());
    }
);
