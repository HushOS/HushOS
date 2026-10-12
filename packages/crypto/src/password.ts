import { CryptoError } from './errors';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './protocol';

/*
 * Every password goes into OPAQUE in Unicode NFC, as the native core does, so a
 * password with accents typed on one keyboard opens the account typed on
 * another, whose input method composes the same characters differently.
 */
export function normalizePassword(password: string) {
    return password.normalize('NFC');
}

export function checkPassword(password: string | undefined): string {
    if (
        typeof password !== 'string' ||
        password.length < PASSWORD_MIN_LENGTH ||
        password.length > PASSWORD_MAX_LENGTH
    )
        throw new CryptoError(
            `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
        );
    return normalizePassword(password);
}
