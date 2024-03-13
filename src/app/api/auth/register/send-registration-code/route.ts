import { eq } from 'drizzle-orm';
import { generateId } from 'lucia';

import { generateEmailVerificationCode, sendVerificationCode } from '@/lib/utils.server';
import { sendRegistrationCodeInput } from '@/schemas/auth';
import { ApiError, defineRoute } from '@/server/define-route';
import { users } from '@/services/db/schema';

export const POST = defineRoute({
    input: sendRegistrationCodeInput,
    output: undefined,
    parseType: 'body',
    handler: async ({ db, input: { email, agree } }) => {
        if (!agree) {
            throw new ApiError(
                'You must agree to the terms to continue.',
                {
                    message: 'You must agree to the terms to continue.',
                },
                400
            );
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
            throw new ApiError(
                'Failed to send email',
                {
                    message: 'Failed to send email',
                },
                500
            );
        }
    },
});
