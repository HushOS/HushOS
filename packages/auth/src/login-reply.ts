import type {
    KeyCreationOptions,
    KeyDescriptor,
    KeyRequestOptions,
    LoginSession,
    NamedStepMethod,
    StepChallenge,
    StepMethod,
    TwoStepMethod,
} from './api';
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

/* What this client can answer a step with, when the reply carries what each needs. */
const METHODS: ReadonlySet<unknown> = new Set<StepMethod>(['webauthn', 'totp', 'backup', 'phrase']);
/*
 * The kinds of method this client names to the server beyond the ones every client answers
 * (docs/two-step-design.md 12): in `twoStepMethods`, when it can answer them here, and in
 * `?methods=`, to list them in settings.
 */
export const NAMED_STEP_METHODS: readonly NamedStepMethod[] = ['webauthn'];
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

function descriptors(value: unknown): KeyDescriptor[] | null {
    if (!Array.isArray(value)) return null;
    const list: KeyDescriptor[] = [];
    for (const entry of value) {
        if (!record(entry) || !text(entry.id) || entry.type !== 'public-key') return null;
        const transports = Array.isArray(entry.transports) ? entry.transports.filter(text) : [];
        list.push({
            id: entry.id,
            type: 'public-key',
            ...(transports.length ? { transports } : {}),
        });
    }
    return list;
}

/* What a key is asked at a step: the challenge, the RP ID and the account's keys, or null. */
function keyRequest(value: unknown): KeyRequestOptions | null {
    if (!record(value) || !text(value.challenge) || !text(value.rpId)) return null;
    const allowCredentials = descriptors(value.allowCredentials);
    // With no key to ask, there is nothing a key could answer.
    if (!allowCredentials?.length) return null;
    return {
        challenge: value.challenge,
        rpId: value.rpId,
        timeout: count(value.timeout) ? value.timeout : 300_000,
        userVerification: 'discouraged',
        allowCredentials,
    };
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
    // A method this client does not know (another device, later) is one it cannot answer.
    // The order is the server's: the account's usual way comes first (design 12).
    const [first] = value.methods as unknown[];
    const listed = [...new Set(value.methods as unknown[])].filter((method): method is StepMethod =>
        METHODS.has(method),
    );
    const phrase = value.phrase;
    const signs =
        record(phrase) &&
        text(phrase.userId) &&
        text(phrase.wrappingSalt) &&
        count(phrase.recoveryVersion);
    const webauthn = listed.includes('webauthn') ? keyRequest(value.webauthn) : null;
    // Without what a method answers with, it cannot answer, whatever the list says: the
    // phrase without what it signs with, a key without its challenge.
    const methods = listed.filter(
        (method) => (method !== 'phrase' || signs) && (method !== 'webauthn' || webauthn),
    );
    return {
        token: value.token,
        methods,
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
        ...(webauthn ? { webauthn } : {}),
        ...(value.withheld === true ? { withheld: true as const } : {}),
        // Also when a way the server put first was dropped here: the usual way is not on offer.
        ...(value.defaultUnavailable === true || (first !== undefined && first !== methods[0])
            ? { defaultUnavailable: true as const }
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

/* `{ user }`: a reset the server says it applied. */
export function readReset(reply: unknown) {
    return record(reply) && record(reply.user) && text(reply.user.id);
}
/* `{ success: true }`: a security change or a deletion that the server says it made. */
export function readDone(reply: unknown) {
    return record(reply) && reply.success === true;
}
/* A pending authenticator app: its id, its key and the address the QR code holds. */
export function readEnrolment(reply: unknown) {
    if (!record(reply) || !text(reply.id) || !text(reply.secret) || !text(reply.uri)) return null;
    return { id: reply.id, secret: reply.secret, uri: reply.uri };
}
/*
 * A confirmed app, exactly as the server answers: `{ backupCodes }` when this turned the step
 * on, `{ replaced: true }` when it replaced an app. Nothing else is one. An empty object, or
 * one that merely lacks `backupCodes` (a proxy's `{ "error": … }` with a 200), is not a
 * confirmation.
 */
export function readConfirmed(
    reply: unknown,
): { backupCodes: string[] } | { replaced: true } | null {
    if (!record(reply)) return null;
    const keys = Object.keys(reply);
    if (keys.length !== 1) return null;
    if (keys[0] === 'replaced') return reply.replaced === true ? { replaced: true } : null;
    if (keys[0] !== 'backupCodes') return null;
    return texts(reply.backupCodes) ? { backupCodes: reply.backupCodes } : null;
}
export function readBackupCodes(reply: unknown) {
    return record(reply) && texts(reply.codes) ? { codes: reply.codes } : null;
}
export function readRemoved(reply: unknown) {
    if (!record(reply) || reply.removed !== true || typeof reply.on !== 'boolean') return null;
    return { removed: true as const, on: reply.on };
}

/* A time as the server sent it. The web's API client hands one over as a Date; anything else sends the string. */
function time(value: unknown) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    return text(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}
/* A method as the settings list shows it. */
function method(value: unknown): TwoStepMethod | null {
    if (!record(value) || !text(value.id) || (value.kind !== 'webauthn' && value.kind !== 'totp'))
        return null;
    const createdAt = time(value.createdAt);
    if (!createdAt) return null;
    return {
        id: value.id,
        kind: value.kind,
        name: typeof value.name === 'string' ? value.name : null,
        createdAt,
        lastUsedAt: time(value.lastUsedAt),
        synced: value.synced === true,
    };
}
/*
 * A key about to be added: the registration token and what the key is asked. Read whole: the
 * options go to the browser or the phone as they are, so a reply that lacks any of what the
 * server always sets is not its answer.
 */
export function readKeyOptions(
    reply: unknown,
): { registrationToken: string; options: KeyCreationOptions } | null {
    if (!record(reply) || !text(reply.registrationToken) || !record(reply.options)) return null;
    if (!TOKEN_PATTERN.test(reply.registrationToken)) return null;
    const { challenge: asked, rp, user, pubKeyCredParams } = reply.options;
    const exclude = descriptors(reply.options.excludeCredentials);
    if (
        !text(asked) ||
        !record(rp) ||
        !text(rp.id) ||
        !text(rp.name) ||
        !record(user) ||
        !text(user.id) ||
        !text(user.name) ||
        !Array.isArray(pubKeyCredParams) ||
        !exclude
    )
        return null;
    const algorithms = pubKeyCredParams.flatMap((entry: unknown) =>
        record(entry) && entry.type === 'public-key' && Number.isSafeInteger(entry.alg)
            ? [{ type: 'public-key' as const, alg: entry.alg as number }]
            : [],
    );
    if (algorithms.length === 0) return null;
    return {
        registrationToken: reply.registrationToken,
        options: {
            challenge: asked,
            rp: { id: rp.id, name: rp.name },
            user: {
                id: user.id,
                name: user.name,
                displayName: text(user.displayName) ? user.displayName : user.name,
            },
            pubKeyCredParams: algorithms,
            timeout: count(reply.options.timeout) ? reply.options.timeout : 300_000,
            // Whatever a reply says, this client asks a key for no attestation, no resident
            // key and no user verification: a second step needs none of them.
            attestation: 'none',
            excludeCredentials: exclude,
            authenticatorSelection: {
                residentKey: 'discouraged',
                userVerification: 'discouraged',
                requireResidentKey: false,
            },
        },
    };
}
/*
 * An added key, exactly as the server answers: the key as the list shows it, and the backup
 * codes when this turned the step on. Anything else with a 200 is not a key added.
 */
export function readKeyAdded(
    reply: unknown,
): { method: TwoStepMethod; backupCodes?: string[] } | null {
    if (!record(reply)) return null;
    const added = method(reply.method);
    if (!added || added.kind !== 'webauthn') return null;
    if (reply.backupCodes === undefined) return { method: added };
    return texts(reply.backupCodes) ? { method: added, backupCodes: reply.backupCodes } : null;
}
