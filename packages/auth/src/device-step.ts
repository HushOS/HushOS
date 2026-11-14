import type { DeviceKind } from '@hushos/db/schema';
import type { AuthApi } from './api';
import { TOKEN_PATTERN } from './tokens';

/*
 * Approving on another device, as the second step (docs/two-step-design.md 12), on a client:
 * the device that asks, and the device that approves. Neither trusts a reply on its shape
 * alone: each is read here, and anything that is not the server's answer is no answer.
 *
 * The cryptography (the commitment, the code, the statement) is `@hushos/crypto/device-approval`,
 * loaded when a request is first made or answered: it carries the BIP-39 word list, which the
 * sign-in page has no use for until then.
 */

const crypto_ = () => import('@hushos/crypto/device-approval');
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key32 = (value: unknown): value is string => typeof value === 'string' && B64_32.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
const random32 = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/* The step token's digest as every statement names it: SHA-256 of its UTF-8 bytes, base64url. */
async function digestOf(stepToken: string) {
    return base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stepToken))),
    );
}

/* Why a request could not be made or answered, for the page to act on rather than read. */
export class DeviceStepError extends Error {
    constructor(
        /*
         * `unsupported`: this browser has no device key to ask or approve with. `mismatch`: the
         * other device did not show what it committed to (the request was ended). `wrong`: the
         * typed code did not match (the request was ended).
         */
        readonly reason: 'unsupported' | 'mismatch' | 'wrong',
        message: string,
    ) {
        super(message);
        this.name = 'DeviceStepError';
    }
}

/* ------------------------------------------------------------------------- */
/* The device that asks                                                       */
/* ------------------------------------------------------------------------- */

/* Where a request stands, as the asking device shows it. */
export type DeviceAskState =
    /* No device has opened the request yet: there is no code to show, only the QR code. */
    | { state: 'waiting' }
    /* A device opened it: the code to read out or type there. */
    | { state: 'code'; code: string }
    /* Approved: the step can be answered with this request. */
    | { state: 'approved'; code: string | null }
    /* Over without an approval: replaced by a newer request, timed out, or refused. */
    | { state: 'ended'; ended: 'replaced' | 'over' | 'refused' };

export type DeviceAsk = {
    requestId: string;
    /* What a camera on the approving device reads instead of the person typing the code. */
    qr: string;
    expiresAt: string;
    /* Asks the server where the request stands, revealing this device's keys once it may. */
    poll(): Promise<DeviceAskState>;
};

/*
 * Makes a request for `stepToken`. `deviceSigningKey` is this device's own signing key
 * (base64url): the one the server knows it by, or the one it is about to register. The
 * commitment goes first; the key and the nonce are revealed only once an approving device has
 * fixed its own value, and only once.
 */
export async function askAnotherDevice(
    api: AuthApi,
    input: {
        stepToken: string;
        /* `login`, a step-up's purpose, or `device-approval` when the method is being turned on. */
        purpose: string;
        deviceSigningKey: string;
        describe?: () => { kind: DeviceKind; name: string };
        /* Turning the method on: the device the person chose, the only one that may answer. */
        approverDeviceId?: string;
    },
): Promise<DeviceAsk> {
    const { approvalQr, deviceStepCode, deviceStepCommitment } = await crypto_();
    if (!TOKEN_PATTERN.test(input.stepToken) || !key32(input.deviceSigningKey))
        throw new DeviceStepError('unsupported', 'This device can’t ask another one right now.');
    const tokenDigest = await digestOf(input.stepToken);
    const nonce = random32();
    const commitment = await deviceStepCommitment({
        purpose: input.purpose,
        tokenDigest,
        deviceSigningKey: input.deviceSigningKey,
        nonce,
    });
    const started = await api.approvalStart({
        stepToken: input.stepToken,
        commitment,
        ...input.describe?.(),
        ...(input.approverDeviceId ? { approverDeviceId: input.approverDeviceId } : {}),
    });
    if (!record(started) || !uuid(started.requestId) || !uuid(started.userId))
        throw new Error('Please try again.');
    const { requestId, userId } = started;
    const expiresAt =
        started.expiresAt instanceof Date
            ? started.expiresAt.toISOString()
            : text(started.expiresAt)
              ? started.expiresAt
              : new Date(Date.now() + 5 * 60_000).toISOString();
    let revealed = false;
    let code: string | null = null;
    return {
        requestId,
        qr: approvalQr({ requestId, commitment }),
        expiresAt,
        async poll() {
            const status = await api.approvalStatus(requestId, input.stepToken);
            if (!record(status) || !text(status.state)) throw new Error('Please try again.');
            if (status.state === 'ended')
                return {
                    state: 'ended',
                    ended:
                        status.ended === 'replaced' || status.ended === 'over'
                            ? status.ended
                            : 'refused',
                };
            if (status.state === 'waiting') return { state: 'waiting' };
            // The approving device's value is fixed now, and this device has not seen it
            // before: only here does it show what it committed to.
            if (!code) {
                if (!key32(status.approverKey)) throw new Error('Please try again.');
                code = await deviceStepCode({
                    userId,
                    requestId,
                    purpose: input.purpose,
                    tokenDigest,
                    deviceSigningKey: input.deviceSigningKey,
                    approverKey: status.approverKey,
                    nonce,
                });
            }
            if (!revealed && status.state === 'opened') {
                await api.approvalReveal(requestId, {
                    stepToken: input.stepToken,
                    deviceSigningKey: input.deviceSigningKey,
                    nonce,
                });
                revealed = true;
            }
            return status.state === 'approved'
                ? { state: 'approved', code }
                : { state: 'code', code };
        },
    };
}

/* ------------------------------------------------------------------------- */
/* The device that approves                                                   */
/* ------------------------------------------------------------------------- */

/* A request this device may answer, as its prompt shows it. */
export type ApprovalPrompt = {
    id: string;
    /* `login` for a sign-in, else what the other device is about to change. */
    purpose: string;
    class: 'unknown' | 'known' | 'change';
    device: { kind: DeviceKind | null; name: string | null };
    /* Roughly where the asking device is, in the server's words ("near Lyon, France"), or null. */
    location: string | null;
    /*
     * The name is the asking device's own words: the server does not know it as one of the
     * account's devices. Anything but the server's plain `false` reads as true.
     */
    selfNamed: boolean;
    /* The asking device chose this device to answer. */
    chosen: boolean;
    createdAt: string;
    expiresAt: string;
    tokenDigest: string;
    commitment: string;
    /* This device opened it, with this value of its own. */
    approverKey: string | null;
    /* What the asking device revealed after that. */
    reveal: { deviceSigningKey: string; nonce: string } | null;
};

const time = (value: unknown) =>
    value instanceof Date ? value.toISOString() : text(value) ? value : null;

function prompt(value: unknown): ApprovalPrompt | null {
    if (!record(value) || !uuid(value.id) || !text(value.purpose)) return null;
    if (value.class !== 'unknown' && value.class !== 'known' && value.class !== 'change')
        return null;
    if (!key32(value.tokenDigest) || !key32(value.commitment)) return null;
    const createdAt = time(value.createdAt);
    const expiresAt = time(value.expiresAt);
    if (!createdAt || !expiresAt) return null;
    const device = record(value.device) ? value.device : {};
    const kind = device.kind;
    const reveal = value.reveal;
    return {
        id: value.id,
        purpose: value.purpose,
        class: value.class,
        device: {
            kind: kind === 'web' || kind === 'ios' || kind === 'android' ? kind : null,
            name: text(device.name) ? device.name : null,
        },
        // Words for a line of a prompt, and nothing longer or stranger than that.
        location:
            text(value.location) &&
            value.location.length <= 200 &&
            !/[\p{Cc}\p{Cf}]/u.test(value.location)
                ? value.location
                : null,
        selfNamed: value.selfNamed !== false,
        chosen: value.chosen === true,
        createdAt,
        expiresAt,
        tokenDigest: value.tokenDigest,
        commitment: value.commitment,
        approverKey: key32(value.approverKey) ? value.approverKey : null,
        reveal:
            record(reveal) && key32(reveal.deviceSigningKey) && key32(reveal.nonce)
                ? { deviceSigningKey: reveal.deviceSigningKey, nonce: reveal.nonce }
                : null,
    };
}

/* The requests the server says this device may answer; an odd entry is left out by itself. */
export function readApprovals(reply: unknown): ApprovalPrompt[] {
    if (!record(reply) || !Array.isArray(reply.approvals)) return [];
    return reply.approvals.flatMap((entry: unknown) => {
        const read = prompt(entry);
        return read ? [read] : [];
    });
}

/* What this device keeps of a request it opened: the commitment as it stood before it posted its own value. */
export type OpenedApproval = {
    id: string;
    purpose: string;
    tokenDigest: string;
    commitment: string;
    approverKey: string;
};

/*
 * What this page opened, by request: the value it made and the commitment it saw before it
 * posted it. Kept in memory only. The value is this device's half of the code: it must be one
 * this device made after the commitment was fixed, never one the server hands it.
 */
const openedHere = new Map<string, OpenedApproval>();

/*
 * Opens a request: this device posts 32 fresh bytes of its own, and remembers them with the
 * commitment it saw before it did. `scanned` is the commitment a camera read from the asking
 * device's screen: the server's copy must be that one, or the request is not the one on that
 * screen.
 *
 * The server answers with the value the request was opened with. It must be the one this
 * device just made (or made before, for a request it opened earlier on this page): a server
 * that answers another has chosen the value itself, after seeing the commitment, and could
 * steer the code. So has one that says this device opened the request when this page holds no
 * value for it (the page was reloaded since). Either ends the request, and nothing is typed.
 */
export async function openApproval(
    api: AuthApi,
    asked: ApprovalPrompt,
    scanned?: string,
): Promise<OpenedApproval> {
    const before = openedHere.get(asked.id);
    const refuse = async (message: string) => {
        openedHere.delete(asked.id);
        await api.approvalDeny(asked.id, 'mismatch').catch(() => {});
        return new DeviceStepError('mismatch', message);
    };
    if (scanned !== undefined && scanned !== (before ?? asked).commitment)
        throw await refuse('That code is for another request. Start again.');
    if (!before && asked.approverKey)
        throw await refuse(
            'This request was opened before this page was reloaded. Ask again on the other device.',
        );
    const mine: OpenedApproval = before ?? {
        id: asked.id,
        purpose: asked.purpose,
        tokenDigest: asked.tokenDigest,
        commitment: asked.commitment,
        approverKey: random32(),
    };
    const opened = await api.approvalOpen(asked.id, mine.approverKey);
    if (!record(opened) || !key32(opened.approverKey)) throw new Error('Please try again.');
    if (opened.approverKey !== mine.approverKey)
        throw await refuse(
            'The server changed this device’s part of the code, so nothing was approved. Ask again on the other device.',
        );
    openedHere.set(asked.id, mine);
    return mine;
}

/*
 * The code this device expects the person to type, once the asking device has revealed. What
 * was revealed must be what was committed to before this device posted its own value: if it is
 * not, no honest device is on the other side, and the request is ended.
 */
export async function approvalCode(
    api: AuthApi,
    opened: OpenedApproval,
    reveal: { deviceSigningKey: string; nonce: string },
    userId: string,
) {
    const { deviceStepCode, deviceStepCommitment } = await crypto_();
    const committed = await deviceStepCommitment({
        purpose: opened.purpose,
        tokenDigest: opened.tokenDigest,
        deviceSigningKey: reveal.deviceSigningKey,
        nonce: reveal.nonce,
    });
    if (committed !== opened.commitment) {
        await api.approvalDeny(opened.id, 'mismatch').catch(() => {});
        throw new DeviceStepError(
            'mismatch',
            'The other device didn’t match its request, so nothing was approved.',
        );
    }
    return deviceStepCode({
        userId,
        requestId: opened.id,
        purpose: opened.purpose,
        tokenDigest: opened.tokenDigest,
        deviceSigningKey: reveal.deviceSigningKey,
        approverKey: opened.approverKey,
        nonce: reveal.nonce,
    });
}

/*
 * Approves: only when what the person typed is exactly the code (`typed` is left out after a
 * scan, where the commitment was the check). A code that does not match ends the request, as
 * a wrong answer to any step does. The signature is this device's own key's, over the
 * statement that names the account, the request, its purpose, its token and the asking device.
 */
export async function approve(
    api: AuthApi,
    input: {
        opened: OpenedApproval;
        reveal: { deviceSigningKey: string; nonce: string };
        userId: string;
        privateKey: CryptoKey;
        typed?: string;
    },
) {
    const { normalizeApprovalCode, signDeviceStep } = await crypto_();
    const expected = await approvalCode(api, input.opened, input.reveal, input.userId);
    if (input.typed !== undefined && normalizeApprovalCode(input.typed) !== expected) {
        await api.approvalDeny(input.opened.id, 'wrong-code').catch(() => {});
        throw new DeviceStepError('wrong', 'That code didn’t match, so nothing was approved.');
    }
    const signature = await signDeviceStep(input.privateKey, {
        userId: input.userId,
        requestId: input.opened.id,
        purpose: input.opened.purpose,
        tokenDigest: input.opened.tokenDigest,
        deviceSigningKey: input.reveal.deviceSigningKey,
    });
    const approved = await api.approvalApprove(input.opened.id, signature);
    if (!record(approved) || approved.approved !== true) throw new Error('Please try again.');
}

/* ------------------------------------------------------------------------- */
/* Turning the method on                                                      */
/* ------------------------------------------------------------------------- */

/* A pending method and the step token its one approval runs from, or null for anything else. */
export function readDeviceEnrolment(reply: unknown) {
    if (!record(reply) || !uuid(reply.id) || !text(reply.token)) return null;
    if (!TOKEN_PATTERN.test(reply.token)) return null;
    return { id: reply.id, token: reply.token };
}
/* The confirmed method: the backup codes when this turned the step on, or `added`. Nothing else is one. */
export function readDeviceConfirmed(
    reply: unknown,
): { backupCodes: string[] } | { added: true } | null {
    if (!record(reply)) return null;
    const keys = Object.keys(reply);
    if (keys.length !== 1) return null;
    if (keys[0] === 'added') return reply.added === true ? { added: true } : null;
    if (keys[0] !== 'backupCodes' || !Array.isArray(reply.backupCodes)) return null;
    const codes = reply.backupCodes;
    return codes.length > 0 && codes.every(text) ? { backupCodes: codes as string[] } : null;
}
