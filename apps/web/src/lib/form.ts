import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { z } from 'zod';

/* Shared field rules. Page-specific schemas live next to their forms. */
export const emailValue = z
    .string()
    .trim()
    .email('Enter an email address like name@example.com.')
    .max(254);
export const newPasswordValue = z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Use no more than ${PASSWORD_MAX_LENGTH} characters.`);
export const agreeValue = z.boolean().refine((value) => value, 'Agree to the terms to carry on.');
/*
 * An error said as what to do. The server's own words are kept where they are
 * already plain; the few that are not are said again here.
 */
export function authError(error: unknown, { signIn = false }: { signIn?: boolean } = {}) {
    if (!(error instanceof Error)) return 'Please try again.';
    const message = error.message;
    if (/^(failed to fetch|load failed|networkerror\b)/i.test(message))
        return 'We couldn’t reach HushOS. Check your connection, then try again.';
    if (message.startsWith('Unable to sign in'))
        return signIn
            ? 'That email and password don’t match. Check them and try again.'
            : 'That password isn’t right. Check it and try again.';
    if (message === 'The recovery phrase does not match this account.')
        return 'These words didn’t open your account. Check you used your newest kit.';
    return message;
}
