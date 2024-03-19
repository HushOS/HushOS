import * as z from 'zod';

export const sendRegistrationCodeSchema = z.object({
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

export type SendRegistrationCode = z.infer<typeof sendRegistrationCodeSchema>;

export const initiateOpaqueRegistrationResponseSchema = z.object({
    email: z.string().email(),
    request: z.string(),
    confirmationCode: z.string().length(8, {
        message: 'Confirmation code must be 8 characters long',
    }),
});

export type InitiateOpaqueRegistrationResponse = z.infer<
    typeof initiateOpaqueRegistrationResponseSchema
>;

export const initiateOpaqueCredentialResponseSchema = z.object({
    email: z.string().email(),
    request: z.string(),
});

export type InitiateOpaqueCredentialResponse = z.infer<
    typeof initiateOpaqueCredentialResponseSchema
>;

export const initiateOpaqueResponseSchema = z.object({
    response: z.string(),
});

export type InitiateOpaqueResponse = z.infer<typeof initiateOpaqueResponseSchema>;

export const userKeysSchema = z.object({
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

export type UserKeys = z.infer<typeof userKeysSchema>;

export const storeUserRecordSchema = z.object({
    record: z.string(),
    email: z.string().email(),
    confirmationCode: z.string().length(8, {
        message: 'Confirmation code must be 8 characters long',
    }),
    userKeys: userKeysSchema,
});

export type StoreUserRecord = z.infer<typeof storeUserRecordSchema>;

export const userAuthSchema = z.object({
    email: z.string().email(),
    authU: z.string(),
});

export type UserAuth = z.infer<typeof userAuthSchema>;
