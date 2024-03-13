import { eq } from 'drizzle-orm';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';

import {
    initiateOpaqueRegistrationResponseInput,
    initiateOpaqueResponseOutput,
} from '@/schemas/auth';
import { ApiError, defineRoute } from '@/server/define-route';
import { users } from '@/services/db/schema';

export const POST = defineRoute({
    input: initiateOpaqueRegistrationResponseInput,
    output: initiateOpaqueResponseOutput,
    parseType: 'body',
    handler: async ({ db, input: { request: reqHex, confirmationCode, email } }) => {
        await opaque.ready;

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new ApiError('Invalid email or confirmation code.', 400);

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

        return {
            response: opaque.uint8ArrayToHex(pub),
        };
    },
});
