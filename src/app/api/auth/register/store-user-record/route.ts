import { eq } from 'drizzle-orm';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';

import { setSignedCookie } from '@/lib/utils.server';
import { storeUserRecordInput } from '@/schemas/auth';
import { ApiError, defineRoute } from '@/server/define-route';
import { lucia } from '@/services/auth';
import { emailVerificationCodes, userKeys, users } from '@/services/db/schema';

export const POST = defineRoute({
    input: storeUserRecordInput,
    output: undefined,
    parseType: 'body',
    handler: async ({
        db,
        input: { record: recHex, email, confirmationCode, userKeys: userCryptoKeys },
    }) => {
        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new ApiError(
            'Either the user does not exist, the email is already verified or there is no existing user secret.',
            {
                message:
                    'Either the user does not exist, the email is already verified or there is no existing user secret.',
            },
            400
        );

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
                throw new ApiError(
                    'Failed to perform a database operation.',
                    {
                        message: 'Failed to perform a database operation.',
                    },
                    500
                );
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
    },
});
