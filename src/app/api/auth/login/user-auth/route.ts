import { and, eq, isNotNull } from 'drizzle-orm';
import opaque from 'libopaque';

import { setSignedCookie } from '@/lib/utils.server';
import { userAuthInput, userKeys } from '@/schemas/auth';
import { ApiError, defineRoute } from '@/server/define-route';
import { lucia } from '@/services/auth';
import { users } from '@/services/db/schema';

export const POST = defineRoute({
    input: userAuthInput,
    output: userKeys,
    parseType: 'body',
    handler: async ({ db, input: { authU: authUHex, email } }) => {
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
            throw new ApiError(
                'Authentication failed.',
                {
                    error: 'Authentication failed.',
                },
                400
            );
        }

        const authSuccess = opaque.userAuth({
            sec: opaque.hexToUint8Array(existingUser.opaqueSecret!),
            authU: opaque.hexToUint8Array(authUHex),
        });

        if (!authSuccess) {
            throw new ApiError(
                'Authentication failed.',
                {
                    error: 'Authentication failed.',
                },
                400
            );
        }

        const session = await lucia.createSession(existingUser.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);
        setSignedCookie(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

        return existingUser.userKeys;
    },
});
