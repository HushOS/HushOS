import { OpenAPIHono } from '@hono/zod-openapi';
import { apiReference } from '@scalar/hono-api-reference';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';

import { serverEnvs } from '@/env/server';
import { authApp } from '@/server/routes/auth';
import { waitlistApp } from '@/server/routes/waitlist';
import { ContextVariables } from '@/server/types';
import { lucia } from '@/services/auth';
import { db } from '@/services/db';

const app = new OpenAPIHono<{ Variables: ContextVariables }>();

app.use(async (c, next) => {
    c.set('db', db);

    const sessionId = await getSignedCookie(
        c,
        serverEnvs.COOKIE_SIGNING_SECRET,
        lucia.sessionCookieName
    );

    if (!sessionId) {
        c.set('user', null);
        c.set('session', null);
        return next();
    }

    const { session, user } = await lucia.validateSession(sessionId);

    if (session && session.fresh) {
        const sessionCookie = lucia.createSessionCookie(session.id);
        await setSignedCookie(
            c,
            lucia.sessionCookieName,
            sessionCookie.serialize(),
            serverEnvs.COOKIE_SIGNING_SECRET,
            {
                ...sessionCookie.attributes,
                sameSite: 'Strict',
            }
        );
    }

    if (!session) {
        const sessionCookie = lucia.createBlankSessionCookie();
        await setSignedCookie(
            c,
            lucia.sessionCookieName,
            sessionCookie.serialize(),
            serverEnvs.COOKIE_SIGNING_SECRET,
            {
                ...sessionCookie.attributes,
                sameSite: 'Strict',
            }
        );
    }

    c.set('user', user);
    c.set('session', session);
    return next();
});

app.doc31('/api/swagger.json', {
    openapi: '3.1.0',
    info: { title: 'HushOS API', version: '0.0.0' },
});

app.get(
    '/api/scalar',
    apiReference({
        spec: {
            url: '/api/swagger.json',
        },
    })
);

const routes = app.route('/', waitlistApp).route('/', authApp);

export type AppType = typeof routes;

export { app };
