import type { LoginSession, StepChallenge, StepMethod } from './api';
import { TOKEN_PATTERN } from './tokens';

/*
 * What a sign-in's reply is, decided from the reply alone (docs/two-step-design.md 4). The
 * server answers `login/finish` with a session, or, for an account that asks for a second
 * step, with the step and nothing else; `login/two-step` answers with the session. Anything
 * else that arrives with a 200 is not the server's answer: a proxy's page, an empty body, a
 * reply cut short. That is a lost reply. The server may have opened the session or not, and
 * nothing here can tell, so the client never treats it as a sign-in (there is no envelope to
 * open) or as a refusal: it drops what it holds and the person enters their password again.
 */
export type LoginReply =
    | { kind: 'session'; session: LoginSession }
    | { kind: 'step'; challenge: StepChallenge }
    | { kind: 'lost' };

const METHODS: readonly StepMethod[] = ['totp', 'backup', 'phrase'];
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function session(reply: Record<string, unknown>): LoginSession | null {
    const { user, envelope, device } = reply;
    if (!record(user) || !text(user.id) || !text(user.email)) return null;
    if (
        !record(envelope) ||
        !count(envelope.envelopeVersion) ||
        !count(envelope.keyVersion) ||
        !count(envelope.credentialVersion) ||
        !text(envelope.wrappingSalt) ||
        !text(envelope.wrappingNonce) ||
        !text(envelope.encryptedKey)
    )
        return null;
    if (!record(device) || !text(device.id)) return null;
    return reply as unknown as LoginSession;
}

function challenge(value: unknown): StepChallenge | null {
    if (!record(value) || !text(value.token) || !TOKEN_PATTERN.test(value.token)) return null;
    if (!Array.isArray(value.methods)) return null;
    // The web's API client hands a time over as a Date; anything else sends the string.
    const expiresAt =
        value.expiresAt instanceof Date && !Number.isNaN(value.expiresAt.getTime())
            ? value.expiresAt.toISOString()
            : value.expiresAt;
    if (!text(expiresAt) || Number.isNaN(Date.parse(expiresAt))) return null;
    // A method this client does not know (a security key, later) is one it cannot answer.
    const methods = METHODS.filter((method) => (value.methods as unknown[]).includes(method));
    const phrase = value.phrase;
    const signs =
        record(phrase) &&
        text(phrase.userId) &&
        text(phrase.wrappingSalt) &&
        count(phrase.recoveryVersion);
    return {
        token: value.token,
        // Without what the phrase signs with, the phrase cannot answer, whatever the list says.
        methods: signs ? methods : methods.filter((method) => method !== 'phrase'),
        expiresAt,
        ...(signs
            ? {
                  phrase: {
                      userId: phrase.userId as string,
                      recoveryVersion: phrase.recoveryVersion as number,
                      wrappingSalt: phrase.wrappingSalt as string,
                  },
              }
            : {}),
    };
}

export function readLoginReply(reply: unknown): LoginReply {
    if (!record(reply)) return { kind: 'lost' };
    // The server sends one or the other, never both: a reply with both is not its answer.
    if ('twoStep' in reply) {
        const step = 'user' in reply ? null : challenge(reply.twoStep);
        return step ? { kind: 'step', challenge: step } : { kind: 'lost' };
    }
    const signedIn = session(reply);
    return signedIn ? { kind: 'session', session: signedIn } : { kind: 'lost' };
}

/* A step reply for a change: the same shape, or null for anything else. */
export function readStepChallenge(reply: unknown) {
    return challenge(reply);
}

/*
 * The replies that say a change was made, read the same way: only the server's own answer
 * counts as done. A portal's page with a 200 after "Change password" or "Delete forever" must
 * not be read as a changed password or a deleted account, and one after a code is confirmed
 * must not be read as two-step sign-in turned on.
 */
const texts = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every(text);

/* `{ success: true }`: a security change or a deletion that the server says it made. */
export function readDone(reply: unknown) {
    return record(reply) && reply.success === true;
}
/* A pending authenticator app: its id, its key and the address the QR code holds. */
export function readEnrolment(reply: unknown) {
    if (!record(reply) || !text(reply.id) || !text(reply.secret) || !text(reply.uri)) return null;
    return { id: reply.id, secret: reply.secret, uri: reply.uri };
}
/* A confirmed app: the backup codes when this turned the step on, none when it replaced an app. */
export function readConfirmed(reply: unknown) {
    if (!record(reply)) return null;
    if (reply.backupCodes === undefined) return {};
    return texts(reply.backupCodes) ? { backupCodes: reply.backupCodes } : null;
}
export function readBackupCodes(reply: unknown) {
    return record(reply) && texts(reply.codes) ? { codes: reply.codes } : null;
}
export function readRemoved(reply: unknown) {
    if (!record(reply) || reply.removed !== true || typeof reply.on !== 'boolean') return null;
    return { removed: true as const, on: reply.on };
}
