import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import opaque from 'libopaque';
import { isWithinExpirationDate } from 'oslo';
import { z } from 'zod';

import { createRegistrationResponseInput } from '@/server/api/schemas/auth';
import { publicProcedure } from '@/server/api/trpc';
import { users } from '@/server/db/schema';

export const createRegistrationResponse = publicProcedure
    .input(createRegistrationResponseInput)
    .output(
        z.object({
            response: z.string().length(128, {
                message: 'Expected response to be a hex string of length 128',
            }),
        })
    )
    .mutation(async ({ input, ctx: { db } }) => {
        await opaque.ready;

        const { request: reqHex, confirmationCode, email } = input;
        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
            with: {
                emailVerificationCodes: true,
            },
        });

        const error = new TRPCError({
            code: 'BAD_REQUEST',
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

        return {
            response: opaque.uint8ArrayToHex(pub),
        };
    });
