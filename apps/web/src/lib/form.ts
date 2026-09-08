import { z } from 'zod';

/* Shared field rules. Page-specific schemas live next to their forms. */
export const emailValue = z.string().trim().email('Enter a valid email address.').max(254);
export const newPasswordValue = z
    .string()
    .min(12, 'Use at least 12 characters.')
    .max(128, 'Use no more than 128 characters.');
export const agreeValue = z.boolean().refine((value) => value, 'Agree to the terms to continue.');
export function authError(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}
