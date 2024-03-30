import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';

import { storeUserRecordSchema } from '@/schemas/auth';
import { ContextVariables } from '@/server/types';
import {
    directoryNodes,
    emailVerificationCodes,
    userKeys,
    users,
    workspaces,
} from '@/services/db/schema';

export const storeUserRecord = new OpenAPIHono<{
    Variables: ContextVariables;
}>().openapi(
    createRoute({
        method: 'post',
        path: '/api/auth/register/store-user-record',
        tags: ['Auth'],
        summary: "Stores the user's OPAQUE record for future use and also stores user's key bundle",
        request: {
            body: {
                description: 'Request body',
                content: {
                    'application/json': {
                        schema: storeUserRecordSchema.openapi('StoreUserRecord'),
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
    }),
    async c => {
        const {
            email,
            confirmationCode,
            record: recHex,
            userKeys: userCryptoKeys,
        } = c.req.valid('json');
        const db = c.get('db');
        const lucia = c.get('lucia');

        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new HTTPException(400, {
            message:
                'Either the user does not exist, the email is already verified or there is no existing user secret.',
        });

        if (
            !existingUser ||
            existingUser.emailVerified ||
            !existingUser.opaqueSecret ||
            existingUser.emailVerificationCodes.length <= 0
        ) {
            throw error;
        }

        const code = existingUser.emailVerificationCodes.at(0)!;
        if (!isWithinExpirationDate(code.expiresAt) || code.code !== confirmationCode) {
            throw error;
        }

        const rec = opaque.hexToUint8Array(recHex);
        const sec = opaque.hexToUint8Array(existingUser.opaqueSecret);

        const { rec: recToStore } = opaque.storeUserRecord({
            rec,
            sec,
        });

        await db.transaction(async ctx => {
            const insertedUserKeys = await ctx
                .insert(userKeys)
                .values({
                    userId: existingUser.id,
                    ...userCryptoKeys,
                })
                .returning({
                    id: userKeys.id,
                });

            if (insertedUserKeys.length <= 0) {
                throw new HTTPException(500, {
                    message: 'Failed to perform a database operation.',
                });
            }

            const [insertedWorkspace] = await ctx
                .insert(workspaces)
                .values({
                    userId: existingUser.id,
                })
                .returning({
                    id: workspaces.id,
                });

            if (!insertedWorkspace) {
                throw new HTTPException(500, {
                    message: 'Failed to perform a database operation.',
                });
            }

            await ctx.insert(directoryNodes).values({
                workspaceId: insertedWorkspace.id,
                materializedPath: `workspace-${insertedWorkspace.id}/`,
                keyBundle: userCryptoKeys.mainKeyBundle,
                metadataBundle: {
                    nonce: '',
                    encryptedMetadata: '',
                },
            });

            await ctx
                .update(users)
                .set({
                    emailVerified: true,
                    opaqueRecord: opaque.uint8ArrayToHex(recToStore),
                    userKeysId: insertedUserKeys.at(0)!.id,
                    opaqueSecret: null,
                    workspaceId: insertedWorkspace.id,
                })
                .where(eq(users.id, existingUser.id));

            await ctx.delete(emailVerificationCodes).where(eq(emailVerificationCodes.id, code.id));
        });

        const session = await lucia.createSession(existingUser.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);
        setCookie(c, sessionCookie.name, sessionCookie.value, {
            ...sessionCookie.attributes,
            sameSite: 'Strict',
        });

        return c.json({});
    }
);
