import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { getSignedCookie } from 'hono/cookie';

import { serverEnvs } from '@/env/server';
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
        const sessionId = await getSignedCookie(
            c,
            serverEnvs.COOKIE_SIGNING_SECRET,
            lucia.sessionCookieName
        );

        if (!sessionId) {
            return c.redirect(Routes.login());
        }

        await lucia.invalidateSession(sessionId);
        return c.redirect(Routes.login());
    }
);
