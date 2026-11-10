/*
 * Two-step sign-in, how a typed code is read (docs/two-step-design.md 2). Pure
 * text, shared by the server, which decides, and by a client, which says what
 * is wrong with an answer before sending it: a code that is not a code is a
 * slip of the hand, and a request spent on it would cost the password proof
 * a change carries. Nothing secret is computed here, so it is safe to import
 * anywhere; what only the server computes lives in two-step-server.ts.
 */

/*
 * What a person typed, as the six digits it stands for: authenticator apps show
 * a code as `123 456`, and people type it that way, so spaces and hyphens are
 * ignored. Null when that is not six digits: not a code at all, which is a
 * mistyped field and never a guess.
 */
export function normalizeTotpCode(input: string) {
    const code = input.replace(/[\s-]/g, '');
    return /^[0-9]{6}$/.test(code) ? code : null;
}

export const BACKUP_CODE_LENGTH = 10;

/* A code as a person reads it: `7KQ2M-9XD4P`. */
export function formatBackupCode(code: string) {
    return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/*
 * What a person typed, as the code it stands for: case, spaces and hyphens are
 * ignored, I and L read as 1 and O as 0. Null when that is not ten characters
 * of the alphabet (Crockford base32: no I, L, O or U).
 */
export function normalizeBackupCode(input: string) {
    const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}
