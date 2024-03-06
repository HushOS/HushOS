import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';
import { z } from 'zod';

import { setSignedCookie } from '@/lib/utils.server';
import { userKeysInput } from '@/server/api/schemas/auth';
import { publicProcedure } from '@/server/api/trpc';
import { db } from '@/server/db';
import { emailVerificationCodes, userKeys, users } from '@/server/db/schema';
import { lucia } from '@/services/auth';

export const storeUserRecord = publicProcedure
    .input(
        z.object({
            record: z.string().length(400, 'Expected record to be a hex string of length 400'),
            email: z.string().email(),
            confirmationCode: z.string().length(6, {
                message: 'Confirmation code must be 6 characters long',
            }),
            userKeys: userKeysInput,
        })
    )
    .mutation(async ({ input }) => {
        await opaque.ready;

        const { record: recHex, email, confirmationCode, userKeys: userCryptoKeys } = input;
        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new TRPCError({
            code: 'BAD_REQUEST',
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

            if (!insertedUserKeys || insertedUserKeys.length <= 0) {
                throw new TRPCError({
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Failed to perform a database operation.',
                });
            }

            await ctx
                .update(users)
                .set({
                    emailVerified: true,
                    opaqueRecord: opaque.uint8ArrayToHex(recToStore),
                    userKeysId: insertedUserKeys.at(0)!.id,
                })
                .where(eq(users.id, existingUser.id));

            await ctx.delete(emailVerificationCodes).where(eq(emailVerificationCodes.id, code.id));
        });

        const session = await lucia.createSession(existingUser.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);
        setSignedCookie(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
    });
