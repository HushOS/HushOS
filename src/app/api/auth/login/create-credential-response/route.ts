import { and, eq, isNotNull } from 'drizzle-orm';
import opaque from 'libopaque';

import { getOpaqueIds } from '@/lib/constants';
import {
    initiateOpaqueCredentialResponseInput,
    initiateOpaqueResponseOutput,
} from '@/schemas/auth';
import { ApiError, defineRoute } from '@/server/define-route';
import { users } from '@/services/db/schema';

export const POST = defineRoute({
    input: initiateOpaqueCredentialResponseInput,
    output: initiateOpaqueResponseOutput,
    parseType: 'body',
    handler: async ({ db, input: { request: reqHex, email } }) => {
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
            throw new ApiError(
                'Invalid user details.',
                {
                    error: 'Invalid user details.',
                },
                400
            );
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

        return {
            response: opaque.uint8ArrayToHex(resp),
        };
    },
});
