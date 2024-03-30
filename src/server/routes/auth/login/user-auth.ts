import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, isNotNull } from 'drizzle-orm';
import { setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import opaque from 'libopaque';

import { userAuthSchema, userKeysSchema } from '@/schemas/auth';
import { ContextVariables } from '@/server/types';
import { users } from '@/services/db/schema';

export const userAuth = new OpenAPIHono<{ Variables: ContextVariables }>().openapi(
    createRoute({
        method: 'post',
        path: '/api/auth/login/user-auth',
        tags: ['Auth'],
        summary: 'Authorize user',
        request: {
            body: {
                description: 'Request body',
                content: {
                    'application/json': {
                        schema: userAuthSchema.openapi('UserAuth'),
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
                        schema: userKeysSchema.openapi('UserKeys'),
                    },
                },
            },
        },
    }),
    async c => {
        const { authU: authUHex, email } = c.req.valid('json');
        const db = c.get('db');
        const lucia = c.get('lucia');

        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: and(
                eq(users.normalizedEmail, normalizedEmail),
                isNotNull(users.opaqueSecret),
                isNotNull(users.opaqueRecord),
                eq(users.emailVerified, true)
            ),
            with: {
                userKeys: true,
            },
        });

        if (!existingUser) {
            throw new HTTPException(400, {
                message: 'Authentication failed.',
            });
        }

        const authSuccess = opaque.userAuth({
            sec: opaque.hexToUint8Array(existingUser.opaqueSecret!),
            authU: opaque.hexToUint8Array(authUHex),
        });

        if (!authSuccess) {
            throw new HTTPException(400, {
                message: 'Authentication failed.',
            });
        }

        const session = await lucia.createSession(existingUser.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);
        setCookie(c, sessionCookie.name, sessionCookie.value, {
            ...sessionCookie.attributes,
            sameSite: 'Strict',
        });

        if (!existingUser.userKeys) {
            throw new HTTPException(400, {
                message: 'User keys not found.',
            });
        }

        return c.json({
            asymmetricKeyBundle: existingUser.userKeys.asymmetricKeyBundle,
            mainKeyBundle: existingUser.userKeys.mainKeyBundle,
            recoveryKeyBundle: existingUser.userKeys.recoveryKeyBundle,
            signingKeyBundle: existingUser.userKeys.signingKeyBundle,
            recoveryMainKeyBundle: existingUser.userKeys.recoveryMainKeyBundle,
            salt: existingUser.userKeys.salt,
        });
    }
);
