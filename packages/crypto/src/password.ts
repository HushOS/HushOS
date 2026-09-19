import { CryptoError } from './errors';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './protocol';

export function checkPassword(password: string | undefined): string {
    if (
        typeof password !== 'string' ||
        password.length < PASSWORD_MIN_LENGTH ||
        password.length > PASSWORD_MAX_LENGTH
    )
        throw new CryptoError(
            `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
        );
    return password;
}
