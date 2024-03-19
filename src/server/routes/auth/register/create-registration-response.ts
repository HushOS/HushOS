import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';

import {
    initiateOpaqueRegistrationResponseSchema,
    initiateOpaqueResponseSchema,
} from '@/schemas/auth';
import { ContextVariables } from '@/server/types';
import { users } from '@/services/db/schema';

export const createRegistrationResponse = new OpenAPIHono<{
    Variables: ContextVariables;
}>().openapi(
    createRoute({
        method: 'post',
        path: '/api/auth/register/create-registration-response',
        tags: ['Auth'],
        summary: 'Create registration response',
        request: {
            body: {
                description: 'Request body',
                content: {
                    'application/json': {
                        schema: initiateOpaqueRegistrationResponseSchema.openapi(
                            'InitiateOpaqueRegistrationResponse'
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
        const { confirmationCode, email, request: reqHex } = c.req.valid('json');
        const db = c.get('db');

        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new HTTPException(400, {
            message: 'Invalid email or confirmation code.',
        });

        if (
            !existingUser ||
            existingUser.emailVerified ||
            existingUser.emailVerificationCodes.length <= 0
        ) {
            throw error;
        }

        const code = existingUser.emailVerificationCodes[0]!;
        if (!isWithinExpirationDate(code.expiresAt) || code.code !== confirmationCode) {
            throw error;
        }

        const { pub, sec } = opaque.createRegistrationResponse({
            M: opaque.hexToUint8Array(reqHex),
        });

        await db
            .update(users)
            .set({
                opaqueSecret: opaque.uint8ArrayToHex(sec),
            })
            .where(eq(users.id, existingUser.id));

        return c.json({
            response: opaque.uint8ArrayToHex(pub),
        });
    }
);
