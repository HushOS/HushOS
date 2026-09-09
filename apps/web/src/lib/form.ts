import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { z } from 'zod';

/* Shared field rules. Page-specific schemas live next to their forms. */
export const emailValue = z.string().trim().email('Enter a valid email address.').max(254);
export const newPasswordValue = z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use no more than ${PASSWORD_MAX_LENGTH} characters.`);
export const agreeValue = z.boolean().refine((value) => value, 'Agree to the terms to continue.');
export function authError(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}
