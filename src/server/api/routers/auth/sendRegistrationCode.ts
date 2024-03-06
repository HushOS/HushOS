import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { generateId } from 'lucia';

import { generateEmailVerificationCode, sendVerificationCode } from '@/lib/utils.server';
import { sendRegistrationCodeInput } from '@/server/api/schemas/auth';
import { publicProcedure } from '@/server/api/trpc';
import { users } from '@/server/db/schema';

export const sendRegistrationCode = publicProcedure
    .input(sendRegistrationCodeInput)
    .mutation(async ({ input: { agree, email }, ctx: { db } }) => {
        if (!agree) {
            throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'You must agree to the terms to continue.',
            });
        }

        const normalizedEmail = email.toUpperCase();

        const existingUser = await db.query.users.findFirst({
            where: eq(users.normalizedEmail, normalizedEmail),
        });

        if (existingUser && existingUser.emailVerified) {
            return;
        }

        let id: string;
        if (!existingUser) {
            id = generateId(15);
            await db
                .insert(users)
                .values({
                    id,
                    email: email,
                    normalizedEmail,
                    agreedToTerms: agree,
                })
                .returning({ insertedUserId: users.id });
        } else {
            id = existingUser.id;
        }

        const code = await generateEmailVerificationCode(id);
        const success = await sendVerificationCode(email, code);

        if (!success) {
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to send email',
            });
        }
    });
