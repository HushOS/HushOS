import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, isNotNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import opaque from 'libopaque';

import { getOpaqueIds } from '@/lib/constants';
import {
    initiateOpaqueCredentialResponseSchema,
    initiateOpaqueResponseSchema,
} from '@/schemas/auth';
import { ContextVariables } from '@/server/types';
import { users } from '@/services/db/schema';

export const createCredentialResponse = new OpenAPIHono<{ Variables: ContextVariables }>().openapi(
    createRoute({
        method: 'post',
        path: '/api/auth/login/create-credential-response',
        tags: ['Auth'],
        summary: 'Create credential response',
        request: {
            body: {
                description: 'Request body',
                content: {
                    'application/json': {
                        schema: initiateOpaqueCredentialResponseSchema.openapi(
                            'InitiateOpaqueCredentialResponse'
                        ),
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
                        schema: initiateOpaqueResponseSchema.openapi('InitiateOpaqueResponse'),
                    },
                },
            },
        },
    }),
    async c => {
        const { email, request: reqHex } = c.req.valid('json');
        const db = c.get('db');
        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: and(
                eq(users.normalizedEmail, normalizedEmail),
                isNotNull(users.opaqueRecord),
                eq(users.emailVerified, true)
            ),
        });

        if (!existingUser) {
            throw new HTTPException(400, { message: 'Invalid user details.' });
        }

        const { resp, sec } = opaque.createCredentialResponse({
            ids: getOpaqueIds(email),
            cfg: { idS: 0, idU: 0, pkS: 1, pkU: 0, skU: 0 },
            pub: opaque.hexToUint8Array(reqHex),
            rec: opaque.hexToUint8Array(existingUser.opaqueRecord!),
            infos: undefined,
        });

        await db
            .update(users)
            .set({
                opaqueSecret: opaque.uint8ArrayToHex(sec),
            })
            .where(eq(users.id, existingUser.id));

        return c.json({
            response: opaque.uint8ArrayToHex(resp),
        });
    }
);
