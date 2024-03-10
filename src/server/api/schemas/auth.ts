import { z } from 'zod';

export const sendRegistrationCodeInput = z.object({
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
                        message: 'You must agree to the terms and conditions and privacy policy.',
                    };
                }
                return { message: error.message ?? '' };
            },
        })
        .default(false),
});

export const createRegistrationResponseInput = z.object({
    email: z.string().email(),
    request: z.string().length(64, {
        message: 'Expected request to be a hex string of length 64',
    }),
    confirmationCode: z.string().length(8, {
        message: 'Confirmation code must be 8 characters long',
    }),
});

export const userKeysInput = z.object({
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
});
