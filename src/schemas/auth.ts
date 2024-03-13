import { z } from '@/server/zod';

export const sendRegistrationCodeInput = z
    .object({
        email: z
            .string({
                required_error: 'Please enter your email address',
            })
            .email({
                message: 'Please enter a valid email address',
            }),
        agree: z
            .literal<boolean>(true, {
                errorMap: error => {
                    if (error.code === 'invalid_literal') {
                        return {
                            message:
                                'You must agree to the terms and conditions and privacy policy.',
                        };
                    }
                    return { message: error.message ?? '' };
                },
            })
            .default(false),
    })
    .openapi('SendRegistrationCodeInput', {
        example: {
            email: 'hey@hushos.com',
            agree: true,
        },
    });

export type SendRegistrationCodeInput = z.infer<typeof sendRegistrationCodeInput>;

export const createRegistrationResponseInput = z
    .object({
        email: z.string().email(),
        request: z.string(),
        confirmationCode: z.string().length(8, {
            message: 'Confirmation code must be 8 characters long',
        }),
    })
    .openapi('CreateRegistrationResponseInput');

export type CreateRegistrationResponseInput = z.infer<typeof createRegistrationResponseInput>;

export const createRegistrationResponseOutput = z
    .object({
        response: z.string(),
    })
    .openapi('CreateRegistrationResponseOutput');

export type CreateRegistrationResponseOutput = z.infer<typeof createRegistrationResponseOutput>;

export const userKeysInput = z
    .object({
        salt: z.string(),
        mainKeyBundle: z.object({
            nonce: z.string(),
            encryptedKey: z.string(),
        }),
        recoveryMainKeyBundle: z.object({
            nonce: z.string(),
            encryptedKey: z.string(),
        }),
        recoveryKeyBundle: z.object({
            nonce: z.string(),
            encryptedKey: z.string(),
        }),
        asymmetricKeyBundle: z.object({
            nonce: z.string(),
            publicKey: z.string(),
            encryptedPrivateKey: z.string(),
        }),
        signingKeyBundle: z.object({
            nonce: z.string(),
            publicKey: z.string(),
            encryptedPrivateKey: z.string(),
        }),
    })
    .openapi('UserKeysInput');

export type UserKeysInput = z.infer<typeof userKeysInput>;

export const storeUserRecordInput = z
    .object({
        record: z.string(),
        email: z.string().email(),
        confirmationCode: z.string().length(8, {
            message: 'Confirmation code must be 8 characters long',
        }),
        userKeys: userKeysInput,
    })
    .openapi('StoreUserRecordInput');

export type StoreUserRecordInput = z.infer<typeof storeUserRecordInput>;
