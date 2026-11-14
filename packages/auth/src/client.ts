import type { SecurityAction } from '@hushos/crypto';
/* Shown on the contacts page; re-exported so the app needs no direct crypto dependency. */
export {
    fingerprint,
    fingerprintOfKeys,
    fingerprintWords,
    keyDigest,
    publicKeyBytes,
} from '@hushos/crypto/fingerprint';
export { pinVerified, settingsRolledBack } from '@hushos/crypto/pins';
export { NAMED_STEP_METHODS } from './login-reply';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import type {
    AuthApi,
    KeyAssertion,
    KeyCreationOptions,
    KeyRegistration,
    KeyRequestOptions,
    LoginSession,
    StepChallenge,
    StepInput,
    StepPurpose,
    TwoStepDefaultKind,
} from './api';
import type { CryptoTransport, RequestOptions } from './crypto-transport';
import {
    readBackupCodes,
    readConfirmed,
    readDone,
    readEnrolment,
    readLoginReply,
    readRemoved,
    readReset,
    NAMED_STEP_METHODS,
    readKeyAdded,
    readKeyOptions,
    readStepChallenge,
} from './login-reply';
import { ordinaryFailure } from './ordinary-failure';
import { createAuthStore } from './store';
import { withStorageEvents } from './with-storage-events';
import {
    createDeviceSigningKey,
    emailDigest,
    signDeviceSession,
} from '@hushos/crypto/device-identity';
import {
    DeviceStorageBlocked,
    DeviceStorageTimeout,
    type DeviceIdentityStore,
    type DeviceKeyStore,
    type StoredDeviceIdentity,
} from './device-storage';
import {
    DeviceStepError,
    approve,
    askAnotherDevice,
    openApproval,
    readApprovals,
    readDeviceConfirmed,
    readDeviceEnrolment,
    type ApprovalPrompt,
    type OpenedApproval,
} from './device-step';
import type { RestoreStep } from './store';
import type { AuthUser, DeviceKind, SessionDevice, SessionUser, SignupIntent } from './protocol';
import type { WorkerRequests, WorkerResults } from './worker';

/*
 * The device key and what this device says about itself (docs/devices-design.md,
 * step 1). Without `identities`, sign-in makes a new device every time; without
 * `describeDevice`, the device never registers. `onRemoved` runs when the server
 * says this device was removed, after the auth client cleared its own storage,
 * for the app to clear the rest (Drive's mirror and stashes).
 */
export { DeviceStepError } from './device-step';
export type { ApprovalPrompt, DeviceAsk, DeviceAskState, OpenedApproval } from './device-step';

export type AuthClientOptions = {
    identities?: DeviceIdentityStore;
    describeDevice?: () => { kind: DeviceKind; name: string };
    onRemoved?: () => Promise<void> | void;
    /* How this device talks to passkeys and security keys; without it, it names none. */
    passkeys?: PasskeyDriver;
};

/*
 * Passkeys and security keys on this device (docs/two-step-design.md 3): WebAuthn in a
 * browser, the platform's own sheet in an app. `supported` says whether this device can use
 * one for this server at all; the two ceremonies resolve with the key's answer in WebAuthn's
 * JSON form, and reject when the person closed the sheet or no key answered.
 */
export type PasskeyDriver = {
    supported(): boolean;
    get(options: KeyRequestOptions): Promise<KeyAssertion>;
    create(options: KeyCreationOptions): Promise<KeyRegistration>;
};
/* Nothing was sent: the sheet was closed, timed out, or found no key it could use. */
const PASSKEY_UNUSED = 'Your passkey or security key wasn’t used. Try again, or use another way.';
const PASSKEY_NOT_ADDED = 'Your passkey or security key wasn’t added. Try again.';
const passkeyUnused = (cause: unknown, message = PASSKEY_UNUSED) =>
    // `kept`: refused on this device, before anything was sent, so the step is still there.
    Object.assign(new Error(message, { cause }), { kept: true });

/*
 * Whether the server said it reads `twoStepMethods` (docs/two-step-design.md 12), as of this
 * browser's last sign-in: remembered across reloads, because a session lasts up to 30 days
 * and its step-ups name methods too. Never said (a session from before this client): the
 * field is tried once, and a server that refuses it (422) is remembered as one that does not.
 *
 * "Does not" is kept for a day and no longer. A server is updated while sessions on it live
 * on, and a session that went on believing the old answer would never be offered its passkey
 * at a change. After a day the field is tried once more, and a refusal remembered again.
 */
const ADVERT_KEY = 'hushos-step-methods';
export const ADVERT_NO_MS = 24 * 60 * 60 * 1000;
function readAdvert(now = Date.now()): boolean | null {
    try {
        const saved = localStorage.getItem(ADVERT_KEY);
        if (saved === '1') return true;
        const since = saved?.startsWith('0:') ? Number(saved.slice(2)) : Number.NaN;
        // A time from the future is a clock that moved: not trusted, and tried again.
        return Number.isFinite(since) && now >= since && now - since < ADVERT_NO_MS ? false : null;
    } catch {
        return null;
    }
}
function writeAdvert(advertised: boolean, now = Date.now()) {
    try {
        localStorage.setItem(ADVERT_KEY, advertised ? '1' : `0:${now}`);
    } catch {
        /* Storage may be disabled. The next sign-in says it again. */
    }
}
/*
 * The server's schema may have refused a field it does not know: a 422, or the 400 this
 * server's auth routes answer a body they cannot read with. (A release from before passkeys
 * drops an unknown field instead, so in practice this is a server that changed the field's
 * shape, or something in front of it.) Asking once more without the field settles it.
 */
const unknownField = (error: unknown) => {
    const status = (error as { status?: unknown } | null)?.status;
    return status === 422 || status === 400;
};

const REMOVED_NOTICE = 'hushos-device-removed';
/* How long a sign-in waits before reading a busy or slow device store once more. */
export const DEVICE_STORAGE_RETRY_MS = 1_000;

/*
 * Why this browser's device key could not be read at sign-in: another tab held the store open
 * (`blocked`), it did not answer in time (`timeout`), or it could not be opened at all
 * (`unavailable`: site data blocked, a corrupted or full store, an old private mode). None of
 * these says the browser holds no key, so the sign-in stops before it begins and the person
 * chooses: try again, or sign in as a new device (`login(..., { asNewDevice: true })`), which
 * shows the new-device notice. Only `blocked` is about other tabs.
 */
export type DeviceStorageReason = 'blocked' | 'timeout' | 'unavailable';
const STORAGE_WHY: Record<DeviceStorageReason, string> = {
    blocked: 'another HushOS tab is using this browser’s storage',
    timeout: 'this browser’s storage didn’t answer in time',
    unavailable: 'this browser’s storage for HushOS can’t be read',
};
const STORAGE_NEXT: Record<DeviceStorageReason, string> = {
    blocked: 'Close other HushOS tabs and try again, or sign in as a new device.',
    timeout: 'Try again, or sign in as a new device.',
    unavailable: 'Try again, or sign in as a new device.',
};
const sentence = (text: string) => text[0]!.toUpperCase() + text.slice(1);
export class DeviceStorageUnreadable extends Error {
    readonly reason: DeviceStorageReason;
    /* The cause as a clause, for a flow that words its own message around it. */
    readonly why: string;
    constructor(reason: DeviceStorageReason, options?: { cause?: unknown }) {
        super(`${sentence(STORAGE_WHY[reason])}. ${STORAGE_NEXT[reason]}`, options);
        this.name = 'DeviceStorageUnreadable';
        this.reason = reason;
        this.why = STORAGE_WHY[reason];
    }
}
export type LoginOptions = {
    /* Skip reading the device key and sign in as a new device: the person's choice when it can't be read. */
    asNewDevice?: boolean;
    /*
     * Whose sign-in this is: the form that started it, by any object of its own. A step it
     * stops at is that form's to answer, and `cancelStep(owner)` from another form (the same
     * unlock form mounted twice, one closing) leaves it alone.
     */
    owner?: object;
};

/*
 * Two-step sign-in (docs/two-step-design.md 4). The password was right and the account asks
 * for a second step: `login` stops here, with what the password gave still held in the worker,
 * and the page asks for the answer and hands it to `answerStep`.
 */
export class TwoStepRequired extends Error {
    readonly challenge: StepChallenge;
    constructor(challenge: StepChallenge) {
        super('This account asks for a second step.');
        this.name = 'TwoStepRequired';
        this.challenge = challenge;
    }
}
/* What a person answers a step with: a code as typed, or the recovery phrase's words. */
export type StepAnswer =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; phrase: string }
    /* A passkey or security key: its sheet opens when this is sent, never before. */
    | { kind: 'webauthn' }
    /* The request another device approved (`askAnotherDevice`). */
    | { kind: 'device'; requestId: string };
/*
 * Why a step's answer did not pass, for the page to act on rather than read:
 * - `wrong`: the answer was wrong, and the step can be answered again;
 * - `frozen`: the authenticator app is paused here; a backup code or the phrase still works;
 * - `limited`: too many wrong codes for now; the phrase still works;
 * - `unavailable`: the server cannot check this method right now; the phrase still works;
 * - `pending`: the other device has not approved yet; nothing was counted, and the same answer
 *   goes again once it has;
 * - `offline`: no answer came back at all; the same answer can be sent again;
 * - `busy`: too many requests from this address just now; the same answer can be sent again
 *   in a moment;
 * - `over`: the step has ended (five answers, five minutes, or it was used): start again;
 * - `lost`: a reply came that was not the server's answer. The step may have passed there
 *   or not, so it is over here too, and a code that was sent may be spent.
 * `again` says whether the same step can still be answered.
 */
export type StepFailureReason =
    | 'wrong'
    | 'frozen'
    | 'limited'
    | 'unavailable'
    | 'pending'
    | 'offline'
    | 'busy'
    | 'over'
    | 'lost';
export class StepFailure extends Error {
    readonly reason: StepFailureReason;
    readonly again: boolean;
    constructor(reason: StepFailureReason, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'StepFailure';
        this.reason = reason;
        this.again = reason !== 'over' && reason !== 'lost';
    }
}
/* How long a step is held here: the five minutes the server gives its token, and one more. */
const STEP_HELD_MS = 6 * 60_000;
/* How long one password exchange may take before the next is let through. */
export const PASSWORD_EXCHANGE_MS = 60_000;
const LOST_REPLY =
    'The server’s answer didn’t arrive, so HushOS can’t tell whether you were signed in. Enter your password again. If you used a code, wait for the next one.';
const STEP_OVER = 'This sign-in timed out. Enter your password again.';
/* The codes a step's refusal carries (docs/two-step-design.md 4), and what each leaves possible. */
const STEP_CODES: Record<string, StepFailureReason> = {
    'step-wrong': 'wrong',
    'step-frozen': 'frozen',
    'step-limited': 'limited',
    'step-unavailable': 'unavailable',
    'step-pending': 'pending',
    'step-expired': 'over',
};
/*
 * A failed answer as the page needs it. A refusal with a code is the server's own. No status
 * at all means no answer came back, and a 5xx without the server's code (a 500, a gateway's
 * 502, 503 or 504) says as little: the answer may or may not have reached the server, and the
 * step's token may still be good. So the step stays, the same answer can be sent again, and
 * the server says what became of it: a token that was used or ran out answers `step-expired`,
 * and only that ends the step. Any other refusal the server answered ends it too: it is not a
 * wrong answer to try again.
 */
export function stepFailure(error: unknown): StepFailure {
    if (error instanceof StepFailure) return error;
    const { code, status, kept } = (error ?? {}) as {
        code?: unknown;
        status?: unknown;
        kept?: unknown;
    };
    const message = error instanceof Error ? error.message : '';
    const reason = typeof code === 'string' ? STEP_CODES[code] : undefined;
    if (reason) return new StepFailure(reason, message, { cause: error });
    // The worker refused a mistyped phrase before anything was sent.
    if (kept === true) return new StepFailure('wrong', message, { cause: error });
    // The address's own limit, not the step's (that one has a code): nothing about the step
    // was looked at, and it is still there when the limit lets the next request through.
    if (status === 429) return new StepFailure('busy', message, { cause: error });
    if (typeof status !== 'number')
        return new StepFailure(
            'offline',
            'We couldn’t reach HushOS. Check your connection, then try again.',
            { cause: error },
        );
    if (status >= 500)
        return new StepFailure(
            'offline',
            'Something went wrong on our side. Send your answer again.',
            { cause: error },
        );
    return new StepFailure('over', message || STEP_OVER, { cause: error });
}
/* A change's refusals that are the step's: the server answered, and nothing was changed. */
const STEP_REFUSALS = new Set([
    'two-step',
    'step-wrong',
    'step-expired',
    'step-frozen',
    'step-limited',
    'step-unavailable',
    'step-pending',
]);
export function stepRefused(error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && STEP_REFUSALS.has(code);
}
/*
 * A refusal the server answered before doing anything: the step's own, by its code (a method
 * it cannot check right now among them), or the address's limit (429). Nothing was changed,
 * so nothing this browser keeps needs clearing and no other tab needs locking. A 503 without
 * the server's code is not one of these: a proxy sends it too, after a change that went
 * through as easily as before one, so it is treated as a reply that never came.
 */
export function nothingChanged(error: unknown) {
    const status = (error as { status?: unknown } | null)?.status;
    return stepRefused(error) || status === 429 || answeredRefusal(error);
}
/*
 * A refusal that is the server's own: a 4xx whose body was the server's (`answered`, set by
 * whoever read the reply). Only this says a change was not made. Anything else after the
 * request has left (no reply, a 5xx, a proxy's page) leaves it open: the server may have made
 * the change, or may yet.
 */
export function answeredRefusal(error: unknown) {
    const { status, answered } = (error ?? {}) as { status?: unknown; answered?: unknown };
    return typeof status === 'number' && status >= 400 && status < 500 && answered === true;
}
/* What a person is told when the server refused a change that would have replaced something. */
const NOT_DONE: Record<SecurityAction, string> = {
    password:
        'Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again.',
    'master-key':
        'Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again.',
    'recovery-key':
        'Your recovery phrase was not replaced. Nothing changed, and your recovery phrase is still the one you have. Please try again.',
};
/* The server's reason, when it gave one of its own, then what that means for the account. */
function notDone(error: unknown, action: SecurityAction) {
    const said = error instanceof Error ? error.message : '';
    const reason = said && said !== 'Please try again.' ? `${said} ` : '';
    return new Error(`${reason}${NOT_DONE[action]}`, { cause: error });
}
/* A 200 that was not the server's answer to a change: what was asked for may or may not be done. */
export class LostReply extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LostReply';
    }
}
const lostChange = (what: string) =>
    new LostReply(
        `The server’s answer didn’t arrive, so HushOS can’t tell whether ${what}. Check before you try again.`,
    );

export function createAuthClient(
    createTransport: () => CryptoTransport,
    deviceKeys: DeviceKeyStore,
    api: AuthApi,
    { identities, describeDevice, onRemoved, passkeys }: AuthClientOptions = {},
) {
    /*
     * What this device can answer a step with beyond a code and the phrase, as it tells the
     * server: a passkey where it can use one, and another device where it keeps a device key of
     * its own to ask with.
     */
    const namedMethods = () =>
        NAMED_STEP_METHODS.filter((method) =>
            method === 'webauthn' ? passkeys?.supported() : identities !== undefined,
        );
    /*
     * The device key a new device made to ask another device with, before it had a session
     * (docs/two-step-design.md 12): the one it registers with once it is signed in, so the key
     * that was approved is the key the device has. Dropped with the sign-in it was made for.
     */
    let askedWith: { privateKey: CryptoKey; publicKey: string } | undefined;
    let transport: CryptoTransport | undefined;
    let epoch = 0;
    const { store, canPersist } = createAuthStore();
    let restoring: Promise<void> | undefined;
    let busy = false;
    /*
     * A sign-in stopped at its second step: the worker holds what the password gave it until
     * the answer brings the envelope. Like a running sign-in, it owns the worker (`owned`).
     */
    let pendingStep:
        | {
              challenge: StepChallenge;
              epoch: number;
              until: number;
              owner: object | undefined;
              /* The key this sign-in proved, when it came back as a device the account knows. */
              deviceKey: string | null;
          }
        | undefined;
    /*
     * The sign-in a page is waiting on, by number; 0 when the page that asked has gone
     * (`cancelStep`). A reply that arrives after that finds nobody to ask for the step, so
     * its challenge is refused instead of being left to hold the worker with no form to
     * answer it.
     */
    let signIns = 0;
    let askedBy: { attempt: number; owner: object | undefined } | null = null;
    /*
     * Whether the worker holds what a sign-in or a change is in the middle of: from its start
     * until the account is open in the worker (or the flow ends). `busy` lasts longer, to the
     * end of the flow: saving device access comes after the account is open, and by then other
     * operations are as safe as they ever were and must not be refused.
     */
    let holding = false;
    let channel: BroadcastChannel | undefined;
    let listening = false;
    function lock() {
        epoch += 1;
        pendingStep = undefined;
        askedWith = undefined;
        const active = transport;
        transport = undefined;
        active?.lock();
        store.setState({ unlockedUserId: null });
    }
    /*
     * The step a sign-in is waiting at, while it can still be answered. Its life is counted
     * from when it arrived, on a clock that only runs forward (`performance.now()`), never
     * read off the device's own date: a phone or a computer whose clock runs minutes fast
     * would otherwise find every step already over, and could never sign in. The server
     * decides when a token has really ended; this only lets go of what the worker holds for
     * one it has long refused.
     */
    function waitingStep() {
        if (pendingStep && performance.now() > pendingStep.until) lock();
        return pendingStep;
    }
    /*
     * Whether a sign-in or a security change owns the worker. Between its two halves the worker
     * holds state that any other account operation would throw away: one that fails resets
     * the worker, and a restore or another sign-in replaces what it holds. So while this is
     * true only the owner's own operations reach the worker (`own`); every other account
     * operation is refused here, before it is sent. With a second step the gap between the
     * halves is as long as a person takes to find a code.
     */
    const owned = () => busy || waitingStep() !== undefined;
    /* Whether another account operation would throw away what the worker holds (see `rpc`). */
    const guarded = () => holding || waitingStep() !== undefined;
    function listen() {
        if (listening) return;
        listening = true;
        void store.persist.rehydrate();
        withStorageEvents(store, () => {
            lock();
            store.setState({ device: null, locks: store.getState().locks + 1 });
        });
        store.subscribe((state, previous) => {
            if (
                state.lockRevision !== previous.lockRevision ||
                (previous.device && state.device?.userId !== previous.device.userId)
            )
                lock();
        });
        window.addEventListener('pagehide', lock);
        try {
            if ('BroadcastChannel' in window) {
                channel = new BroadcastChannel('hushos-auth');
                channel.onmessage = (event) => {
                    if (event.data !== 'lock') return;
                    lock();
                    store.setState({ locks: store.getState().locks + 1 });
                };
            }
        } catch {
            /* Storage events still propagate locks when broadcasting is unavailable. */
        }
    }
    /*
     * What localStorage holds for the saved unlock, for a restore that found none: no entry
     * (never written, or not visible to this page), an entry whose device is empty (written
     * over), or one with a device the store refused. Never the bundle itself.
     */
    function storedUnlock() {
        try {
            const raw = localStorage.getItem(store.persist.getOptions().name ?? '');
            if (raw === null) return `nothing stored (${localStorage.length} other keys)`;
            const saved = (JSON.parse(raw) as { state?: Record<string, unknown> }).state;
            return `stored device ${saved?.device ? 'present but refused' : 'empty'}, lock revision ${String(saved?.lockRevision)}`;
        } catch {
            return 'storage unreadable';
        }
    }
    function broadcastLock() {
        store.setState({ locks: store.getState().locks + 1 });
        try {
            channel?.postMessage('lock');
        } catch {
            /* Cross-tab notification must not prevent local cleanup or revocation. */
        }
    }
    async function rpc<K extends keyof WorkerRequests>(
        operation: K,
        input: WorkerRequests[K],
        options?: RequestOptions,
        owner = false,
    ): Promise<WorkerResults[K]> {
        listen();
        // Drive's and a family's operations fail without touching what the worker holds
        // (ordinary-failure.ts), so they go through; an account operation that is not the
        // owner's would not.
        if (!owner && guarded() && !ordinaryFailure(String(operation)))
            throw Object.assign(new Error('Please wait for the current sign-in attempt.'), {
                kept: true,
            });
        if (!transport) {
            const created = createTransport();
            transport = created;
            // A transport that closes itself (worker error, unanswered call) must not
            // leave the UI believing the account is still unlocked.
            created.onLock(() => {
                if (transport === created) lock();
            });
        }
        const activeTransport = transport;
        try {
            return await activeTransport.request(operation, input, options);
        } catch (error) {
            // A failed account operation leaves nothing to trust and the worker has
            // already reset itself, so lock here too. A Drive or family operation that fails
            // is an ordinary error for its caller (ordinary-failure.ts); the transport reports its own death
            // through onLock, which is the only Drive failure that should lock. While a
            // sign-in or security change runs, it owns the worker and locks on its own
            // failures: a background read refused by the locked worker (settings, an
            // identity) must not throw away the change's state mid-way. A refusal the worker
            // kept its keys through is an ordinary error too.
            const kept = (error as { kept?: unknown } | null)?.kept === true;
            if (
                !kept &&
                !ordinaryFailure(String(operation)) &&
                !busy &&
                transport === activeTransport
            )
                lock();
            throw error;
        }
    }
    /* The worker, for the sign-in or the change that owns it. */
    const own = <K extends keyof WorkerRequests>(
        operation: K,
        input: WorkerRequests[K],
        options?: RequestOptions,
    ) => rpc(operation, input, options, true);
    /*
     * WebKit stores a CryptoKey in IndexedDB by wrapping it with a key from the system
     * keychain, and that step now and then fails at once with DataCloneError (seen in CI
     * on macOS). The key itself is fine, so it is tried a few times before giving up.
     */
    async function createDeviceKey() {
        for (let attempt = 1; ; attempt++) {
            try {
                return await deviceKeys.create();
            } catch (error) {
                const clone = (error as { name?: unknown } | null)?.name === 'DataCloneError';
                if (!clone || attempt >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
            }
        }
    }
    /* The same retry as the device key above: WebKit's keychain wrap fails now and then. */
    async function saveIdentity(identity: StoredDeviceIdentity) {
        for (let attempt = 1; ; attempt++) {
            try {
                return await identities!.save(identity);
            } catch (error) {
                const clone = (error as { name?: unknown } | null)?.name === 'DataCloneError';
                if (!clone || attempt >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
            }
        }
    }
    /*
     * This device's proof for the sign-in `attemptToken` names, when its stored key
     * was made for the account being signed in to. A key made for another email stays
     * quiet: a browser two people share never tells the server that one person's
     * device is now signing in as the other.
     */
    async function deviceProof(
        stored: StoredDeviceIdentity | null,
        email: string,
        attemptToken: string,
    ) {
        if (!stored || stored.emailHash !== (await emailDigest(email))) return undefined;
        try {
            const signature = await signDeviceSession(stored.privateKey, {
                userId: stored.userId,
                deviceId: stored.deviceId,
                attemptToken,
            });
            return { id: stored.deviceId, signature };
        } catch {
            // A key that was read but cannot sign will never sign: this browser starts over as a
            // new device rather than refuse every sign-in.
            return undefined;
        }
    }
    /*
     * The stored device key, or null only when the store answered that it holds none. Read before
     * the sign-in begins, so a refused try costs no password check and none of the sign-in
     * attempts the server allows. A store that was blocked or slow is read once more after a
     * pause; one that could not be opened is not, since that rarely passes in a second. Either
     * way, a store that did not answer stops the sign-in with DeviceStorageUnreadable: going on
     * would register this browser as a new device, with a notice and an email about a sign-in
     * that may have been this device all along.
     */
    async function storedIdentity(store: DeviceIdentityStore) {
        const unreadable = (error: unknown) =>
            new DeviceStorageUnreadable(
                error instanceof DeviceStorageBlocked
                    ? 'blocked'
                    : error instanceof DeviceStorageTimeout
                      ? 'timeout'
                      : 'unavailable',
                { cause: error },
            );
        try {
            return await store.load();
        } catch (error) {
            if (!(error instanceof DeviceStorageBlocked || error instanceof DeviceStorageTimeout))
                throw unreadable(error);
        }
        await new Promise((resolve) => setTimeout(resolve, DEVICE_STORAGE_RETRY_MS));
        try {
            return await store.load();
        } catch (error) {
            throw unreadable(error);
        }
    }
    /*
     * Storage the browser may evict under pressure would lose the device key, and the next sign-in
     * would be a new device with a notice. Asked only where the browser decides without asking the
     * person (Firefox would prompt, unexplained): when the permission is already settled.
     */
    async function keepStorage() {
        try {
            const status = await navigator.permissions?.query({
                name: 'persistent-storage' as PermissionName,
            });
            if (status && status.state !== 'prompt') await navigator.storage?.persist?.();
        } catch {
            /* No permission or storage manager here: nothing to do. */
        }
    }
    /* One device registration at a time across this browser's tabs, so two cannot register two keys. */
    function withDeviceLock<T>(action: () => Promise<T>): Promise<T> {
        const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
        return locks?.request ? (locks.request('hushos-device', action) as Promise<T>) : action();
    }
    let ensuring: Promise<void> | undefined;
    /*
     * Makes sure the session's device has described itself: a session from before
     * devices, or a sign-in that made a new device, registers its kind, its name and a
     * new device key. Never in the way of the person: failures are left for the next visit.
     */
    function ensureDevice(user: Pick<AuthUser, 'id' | 'email'>, known?: SessionDevice) {
        if (!identities || !describeDevice || known?.registered) return Promise.resolve();
        ensuring ??= withDeviceLock(async () => {
            // Read again under the lock: another tab may have registered meanwhile.
            const device = (await readSession()).device;
            if (!device || device.registered) return;
            // The key another device approved this one by, when it asked before it signed in.
            const key = askedWith ?? (await createDeviceSigningKey());
            askedWith = undefined;
            const { device: registered } = await api.registerDevice({
                ...describeDevice(),
                ...(key ? { signingPublicKey: key.publicKey } : {}),
            });
            if (key) {
                await saveIdentity({
                    userId: user.id,
                    emailHash: await emailDigest(user.email),
                    deviceId: registered.id,
                    privateKey: key.privateKey,
                    publicKey: key.publicKey,
                });
                void keepStorage();
            }
            // Without a key this device cannot come back to its row; a stale key would only mislead.
            else await identities.clear().catch(() => {});
        }).finally(() => {
            ensuring = undefined;
        });
        return ensuring;
    }
    /*
     * The server said this device was removed: the saved unlock, the device key that opened it
     * and the device's own key go, and the app clears the rest (Drive's mirror and stashes). One
     * wipe at a time, in this tab (a sign-in started meanwhile is refused until it ends) and across
     * tabs (the device lock). Before every step that deletes, the server must still say removed:
     * someone may have signed in again in another tab, and the cookie is shared. Only a finished
     * wipe is acknowledged, which lets go of the cookie; anything cut short is tried again at the
     * next check. Whatever the person kept here may already be copied elsewhere: housekeeping,
     * not a guarantee.
     */
    async function forgetRemovedDevice() {
        await exclusive(() =>
            withDeviceLock(async () => {
                const stillRemoved = async () => {
                    const now = await api.session();
                    if (now.user || !now.removed)
                        throw new Error('Signed in again since; nothing is cleared.');
                };
                lock();
                broadcastLock();
                try {
                    sessionStorage.setItem(REMOVED_NOTICE, '1');
                } catch {
                    /* The sign-in page just won't say why. */
                }
                await stillRemoved();
                // The store writes nothing until it has loaded (see store.ts); on a page that never
                // restored (the sign-in page a removed browser lands on) the cleared state would be lost.
                await store.persist.rehydrate();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                // The app's copies are cleared first, but a failure there never keeps this
                // device's own key and identity: they go regardless, and the failure is thrown
                // after, so the removal is not acknowledged and the next check tries again.
                let appFailed = false;
                let appFailure: unknown;
                try {
                    await onRemoved?.();
                } catch (error) {
                    // A flag, not the error's truthiness: whatever the app throws is a failure.
                    appFailed = true;
                    appFailure = error;
                }
                await stillRemoved();
                await deviceKeys.clear();
                await stillRemoved();
                await identities?.clear();
                if (appFailed)
                    throw appFailure instanceof Error
                        ? appFailure
                        : new Error('The app’s copies on this device were not cleared.');
                await stillRemoved();
                await api.forgetSession();
            }),
        );
    }
    async function readSession() {
        const result = await api.session();
        // Not while a sign-in or a security change owns the worker: the next check will do it.
        if (!result.user && result.removed && !owned()) await forgetRemovedDevice().catch(() => {});
        return result;
    }
    /*
     * `step`: what to do when the account asks for a second step. A page that can ask the
     * person (`ask`) gets TwoStepRequired and answers with `answerStep`. A sign-in made on
     * the person's behalf after something else (a new account, a reset, a security change)
     * has nobody to ask, so it stops (`refuse`) and the person signs in themselves. The one
     * that follows a reset (`AfterReset`) answers the step itself, with the recovery phrase the
     * reset just made: the reset was authorised by the old phrase, the phrase answers any
     * step, and nobody else holds the new one yet.
     */
    type AfterReset = {
        /* The phrase the change made. */
        phrase: string;
        /*
         * What this change made and no other could have: the salts of the account-key
         * envelope and of the recovery envelope it sent. The server serving one of them back
         * is the change itself showing. A version number is not: another device's change
         * moves it to the same number.
         */
        envelopeSalt: string;
        recoverySalt: string;
        /*
         * Called when the server's reply shows this change landed. Not being called proves
         * nothing: the server may still commit a moment later. The password signing in is no
         * evidence either: someone may reset to the password they already have, and a
         * rotation keeps it.
         */
        landed: () => void;
    };
    async function login(
        email: string,
        password: string,
        options: LoginOptions = {},
        step: 'ask' | 'refuse' | AfterReset = 'refuse',
    ) {
        const loginEpoch = epoch;
        const attempt = ++signIns;
        if (step === 'ask') askedBy = { attempt, owner: options.owner };
        const stored = identities && !options.asNewDevice ? await storedIdentity(identities) : null;
        const start = await own('loginStart', { password });
        const challenge = await api.loginStart({ email, ...start });
        // Whether this server reads `twoStepMethods`: said in every reply, for any address.
        const advertised = challenge.twoStepMethods === true;
        writeAdvert(advertised);
        const finish = await own('loginFinish', challenge);
        const device = await deviceProof(stored, email, challenge.attemptToken);
        // A lock here has already dropped the export key; do not create a session for it.
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        const finishWith = (methods: boolean) =>
            api.loginFinish({
                attemptToken: challenge.attemptToken,
                ...finish,
                ...(device ? { device } : {}),
                ...(methods ? { twoStepMethods: namedMethods() } : {}),
            });
        // A rolling update can answer `login/start` from a release that reads the field and
        // `login/finish` from one whose schema refuses it. Refused there, nothing was looked
        // at and the attempt is still good: the same request goes again without the field.
        const reply = readLoginReply(
            await finishWith(advertised).catch((error: unknown) => {
                if (!advertised || !unknownField(error)) throw error;
                return finishWith(false);
            }),
        );
        if (reply.kind === 'lost') throw new StepFailure('lost', LOST_REPLY);
        if (reply.kind === 'step') {
            if (step === 'refuse') throw new Error('This account asks for a second step.');
            if (epoch !== loginEpoch)
                throw new Error('Your account was locked. Please sign in again.');
            if (typeof step === 'object') {
                // The step names the recovery key the account has now. Only if that is the
                // reset's is the new phrase the account's phrase: anything else is left
                // unanswered, since the new words would only be a wrong answer, and counted.
                if (reply.challenge.phrase?.wrappingSalt !== step.recoverySalt)
                    throw new Error('This account asks for a second step.');
                step.landed();
                const answered = readLoginReply(
                    await api.loginTwoStep(
                        await proveStep(
                            reply.challenge,
                            { kind: 'phrase', phrase: step.phrase },
                            own,
                        ),
                    ),
                );
                if (answered.kind !== 'session') throw new StepFailure('lost', LOST_REPLY);
                return openSession(answered.session, loginEpoch);
            }
            // The page that asked left while the reply was on its way: nobody can answer.
            if (askedBy?.attempt !== attempt)
                throw new Error('This sign-in was left. Sign in again.');
            const held = {
                challenge: reply.challenge,
                epoch: loginEpoch,
                until: performance.now() + STEP_HELD_MS,
                owner: options.owner,
                deviceKey: device && stored ? stored.publicKey : null,
            };
            askedWith = undefined;
            pendingStep = held;
            // A step left unanswered lets go of what the worker holds when its time is up, even
            // with nothing else happening: the form can sit idle, and nothing else would look.
            // A step answered, given up or replaced by then is not touched.
            setTimeout(() => {
                if (pendingStep === held) waitingStep();
            }, STEP_HELD_MS + 1_000);
            throw new TwoStepRequired(reply.challenge);
        }
        // The envelope the server hands over is the one this change sealed, if it landed.
        if (typeof step === 'object' && reply.session.envelope.wrappingSalt === step.envelopeSalt)
            step.landed();
        return openSession(reply.session, loginEpoch);
    }
    /* The second half of a sign-in: the session is open, and the envelope opens the account here. */
    async function openSession(result: LoginSession, loginEpoch: number) {
        // A device the proof did not bring back registers itself; never in the way of signing in.
        void ensureDevice(result.user, result.device).catch(() => {});
        try {
            await own('unlock', { userId: result.user.id, envelope: result.envelope });
        } catch {
            throw new Error(
                'Signed in, but your account key could not be unlocked. Please sign in again.',
            );
        }
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        // The account is open in the worker: nothing is held that another operation could
        // throw away. Let go before saying so, because the app acts on "unlocked" at once
        // (Drive opens the identity), and saving device access below can take a while.
        holding = false;
        store.setState({ unlockedUserId: result.user.id, rememberError: '' });
        // Which step a failed save stopped at, and why: the banner says only that it failed.
        let saving = 'storage';
        const started = Date.now();
        try {
            if (!canPersist()) throw new Error('Device storage is unavailable.');
            saving = 'device key';
            const saved = await createDeviceKey();
            saving = 'lock check';
            if (epoch !== loginEpoch) throw new Error('Your account was locked.');
            saving = 'worker';
            const device = await own('remember', {
                deviceKey: saved.key,
                identity: {
                    userId: result.user.id,
                    deviceKeyId: saved.id,
                    keyVersion: result.envelope.keyVersion,
                    credentialVersion: result.envelope.credentialVersion,
                },
            });
            saving = 'lock check';
            if (epoch !== loginEpoch) throw new Error('Your account was locked.');
            saving = 'shared storage';
            store.setState({ device });
            if (!canPersist()) throw new Error('Device storage is unavailable.');
        } catch (error) {
            console.warn(
                `Saving device access failed at ${saving} after ${Date.now() - started}ms.`,
                error,
            );
            store.setState({
                rememberError:
                    'This browser could not save device access. You can continue, but a refresh will require your password.',
            });
        }
        return result.user;
    }
    /* A step's answer as the server takes it: the phrase signs in the worker and never leaves it. */
    async function proveStep(
        challenge: StepChallenge,
        answer: StepAnswer,
        worker: typeof own,
    ): Promise<StepInput> {
        if (answer.kind === 'webauthn') {
            if (!challenge.webauthn || !passkeys?.supported())
                throw new StepFailure(
                    'wrong',
                    'A passkey or security key can’t be used for this step here.',
                );
            // The sheet opens here, on the press that sent this answer.
            const response = await passkeys.get(challenge.webauthn).catch((cause: unknown) => {
                throw passkeyUnused(cause);
            });
            return { token: challenge.token, proof: { kind: 'webauthn', response } };
        }
        if (answer.kind === 'device')
            return {
                token: challenge.token,
                proof: { kind: 'device', requestId: answer.requestId },
            };
        if (answer.kind !== 'phrase')
            return {
                token: challenge.token,
                proof: { kind: answer.kind, code: answer.code.trim() },
            };
        if (!challenge.phrase)
            throw new StepFailure('wrong', 'Your recovery phrase can’t be used for this step.');
        const { signature } = await worker('twoStepPhrase', {
            phrase: answer.phrase,
            userId: challenge.phrase.userId,
            wrappingSalt: challenge.phrase.wrappingSalt,
            stepToken: challenge.token,
        });
        return { token: challenge.token, proof: { kind: 'phrase', signature } };
    }
    /*
     * Answers the step a sign-in stopped at. A wrong answer leaves the step, and what the
     * worker holds for it, in place: only a step that is over (or a reply that was lost)
     * drops them, and then the person enters their password again.
     */
    async function answerStep(answer: StepAnswer) {
        if (busy) throw new Error('Please wait for the current sign-in attempt.');
        const pending = waitingStep();
        if (!pending || pending.epoch !== epoch) throw new StepFailure('over', STEP_OVER);
        busy = true;
        holding = true;
        try {
            const proof = await proveStep(pending.challenge, answer, own);
            // A lock while the key's sheet was open let go of this sign-in: its answer is not
            // sent, so no session is opened for a page that has stopped waiting for one.
            if (epoch !== pending.epoch) throw new StepFailure('over', STEP_OVER);
            const reply = readLoginReply(await api.loginTwoStep(proof));
            if (reply.kind !== 'session') throw new StepFailure('lost', LOST_REPLY);
            if (epoch !== pending.epoch) throw new StepFailure('over', STEP_OVER);
            // The step is passed: from here this is an ordinary sign-in's second half.
            pendingStep = undefined;
            return await openSession(reply.session, pending.epoch);
        } catch (error) {
            // Passed, and then the account did not open here: a sign-in's failure, not the step's.
            if (pendingStep !== pending) {
                lock();
                throw error;
            }
            const failure = stepFailure(error);
            if (!failure.again) lock();
            throw failure;
        } finally {
            busy = false;
            holding = false;
        }
    }
    let initializing: Promise<boolean> | undefined;
    function initializeAccount(user: SessionUser): Promise<boolean> {
        if (store.getState().unlockedUserId !== user.id) return Promise.resolve(false);
        if (initializing) return initializing;
        const setupEpoch = epoch;
        initializing = (async () => {
            const { missing } = await api.setup();
            if (
                !missing ||
                !(missing.recovery || missing.identity || missing.workspace || missing.workspaceKey)
            )
                return false;
            if (epoch !== setupEpoch) throw new Error('Your account was locked.');
            const bundles = await rpc('initialize', {
                userId: user.id,
                recovery: missing.recovery,
                identity: missing.identity,
                workspace:
                    missing.workspace || missing.workspaceKey
                        ? { id: missing.workspaceId ?? crypto.randomUUID() }
                        : undefined,
            });
            if (epoch !== setupEpoch) throw new Error('Your account was locked.');
            await api.initialize(bundles);
            return missing.recovery;
        })().finally(() => {
            initializing = undefined;
        });
        return initializing;
    }
    async function exclusive<T>(action: () => Promise<T>) {
        if (busy) throw new Error('Please wait for the current sign-in attempt.');
        busy = true;
        holding = true;
        // Whatever starts now takes the worker over: a sign-in left waiting at its step is dropped.
        pendingStep = undefined;
        try {
            return await action();
        } catch (error) {
            // A sign-in that stopped at its step has not failed: the worker keeps what it holds.
            if (!(error instanceof TwoStepRequired)) lock();
            throw error;
        } finally {
            busy = false;
            holding = false;
        }
    }
    /*
     * Proves the password once more (an OPAQUE exchange bound to this session) and hands the
     * finished exchange to `action`. Its own worker operations: sign-in's would drop the open
     * account, and a wrong password here is a refusal that keeps this browser unlocked.
     */
    async function withPassword<T>(
        password: string,
        action: (proof: { attemptToken: string; finishLoginRequest: string }) => Promise<T>,
        // Which change the proof is for: the server binds the exchange to it.
        reauth: AuthApi['devicesReauth'] = (input) => api.devicesReauth(input),
    ) {
        // The session this was asked under: a lock or a sign-out since (and a sign-in by
        // someone else after it) means the proof, or what it authorises, is not this person's.
        const asked = epoch;
        const proof = await provePassword(password, reauth, asked);
        if (asked !== epoch) throw lockedSince();
        return action(proof);
    }
    const lockedSince = () =>
        new Error('This browser was locked or signed out meanwhile. Nothing was changed.');
    /*
     * One password exchange at a time. The worker holds a single exchange's state between its
     * start and its finish, so a second one begun meanwhile would overwrite the first's, and
     * its tidying-up would clear it: the first then fails with "Enter your password again"
     * without its request ever being sent. That can happen without anyone pressing twice: other
     * devices are removed in the background after two-step sign-in is turned on, while the
     * person goes on to something else that asks for the password. Each exchange waits for
     * the one before it to end. Only the exchange is queued: what is done with the proof (the
     * request it authorises) runs outside the queue, so a slow request holds nobody up.
     */
    let proving: Promise<unknown> = Promise.resolve();
    function provePassword(password: string, reauth: AuthApi['devicesReauth'], asked: number) {
        const exchange = proving.then(async () => {
            // Its turn came after a lock or a sign-out: never started, so it cannot prove a
            // password against an account that signed in since.
            if (asked !== epoch) throw lockedSince();
            // An exchange that never settles (a request that hangs, a worker that goes quiet)
            // is given up on after PASSWORD_EXCHANGE_MS, so it cannot hold every later one.
            // Once given up on it does nothing more: its late reply must not finish, or
            // clear, the exchange that took its place.
            let over = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const run = (async () => {
                const start = await rpc('reauthStart', { password });
                const challenge = await reauth(start);
                if (over) throw new Error('This took too long. Please try again.');
                const finish = await rpc('reauthFinish', challenge);
                return { attemptToken: challenge.attemptToken, ...finish };
            })();
            // Rejects only after it was given up on, when nobody is waiting for it any more.
            run.catch(() => {});
            try {
                return await Promise.race([
                    run,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => {
                            over = true;
                            reject(new Error('This took too long. Please try again.'));
                        }, PASSWORD_EXCHANGE_MS);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
                over = true;
                // A server that refused the start (429, a lost session) leaves the password in
                // the worker otherwise, until the next lock.
                await rpc('reauthCancel', {}).catch(() => {});
            }
        });
        // The next exchange waits for this one's end, whichever way it ends.
        proving = exchange.catch(() => {});
        return exchange;
    }
    return {
        store,
        isAuthenticating: owned,
        initializeAccount,
        /* Other domains (Drive) reach the crypto worker through the same transport and lock. */
        rpc: <K extends keyof WorkerRequests>(
            operation: K,
            input: WorkerRequests[K],
            options?: RequestOptions,
        ) => rpc(operation, input, options),
        // `validated`: the caller has just confirmed `user` against the live session
        // (a route guard did), so the bundle can be checked without another request.
        async restore(user: SessionUser, options: { validated?: boolean } = {}) {
            listen();
            if (store.getState().unlockedUserId === user.id) return;
            // A sign-in or a change owns the worker, a sign-in waiting at its step included:
            // a restore would replace what the worker holds for it.
            if (owned()) return;
            if (restoring) return restoring;
            restoring = (async () => {
                // A trail of steps with timings: what a slow or failed restore was doing.
                const trail: { step: RestoreStep; at: number }[] = [];
                const step = (next: RestoreStep) => {
                    trail.push({ step: next, at: Date.now() });
                    store.setState({ restoreStep: next });
                };
                const describeTrail = () =>
                    trail
                        .map((entry, index) => {
                            const end = trail[index + 1]?.at ?? Date.now();
                            return `${entry.step} ${end - entry.at}ms`;
                        })
                        .join(', ');
                // Every way out that leaves the account locked without an error says why, so a
                // lock screen that "should" have opened can be traced to its reason.
                const stop = (reason: string) =>
                    console.info(`Device restore stopped: ${reason} (${describeTrail()}).`);
                store.setState({ restoring: true, restoreStep: null });
                try {
                    const restoringEpoch = epoch;
                    step('rehydrate');
                    await store.persist.rehydrate();
                    const device = store.getState().device;
                    if (!device) return stop(`no saved device access, ${storedUnlock()}`);
                    if (device.userId !== user.id) return stop('saved for another account');
                    let sessionUser: SessionUser | null;
                    step('session');
                    try {
                        sessionUser = options.validated ? user : (await readSession()).user;
                    } catch {
                        // Offline or a flaky connection: the bundle may be fine. Keep it and
                        // let the next focus or session check try again.
                        return stop('the session could not be checked');
                    }
                    if (
                        !sessionUser ||
                        sessionUser.id !== device.userId ||
                        sessionUser.credentialVersion !== device.credentialVersion
                    ) {
                        lock();
                        store.setState({ device: null });
                        return stop('it no longer matches the session');
                    }
                    if (epoch !== restoringEpoch) return stop('locked while checking the session');
                    step('device-key');
                    const deviceKey = await deviceKeys.load(device.deviceKeyId);
                    if (epoch !== restoringEpoch)
                        return stop('locked while reading the device key');
                    // Gone from this browser (cleared by a lock or sign-out elsewhere): the
                    // bundle can never open again.
                    if (!deviceKey)
                        throw Object.assign(new Error('The saved device key is unavailable.'), {
                            invalid: true,
                        });
                    step('worker');
                    await rpc('restore', { bundle: device, deviceKey });
                    if (epoch !== restoringEpoch) return stop('locked while opening the key');
                    store.setState({ unlockedUserId: user.id, rememberError: '' });
                } catch (error) {
                    // Refused before it reached the worker, because a sign-in began meanwhile
                    // and owns it: that sign-in is left alone, and so is the saved access.
                    if ((error as { kept?: unknown } | null)?.kept === true && owned())
                        return stop('a sign-in began meanwhile');
                    lock();
                    // The trail is part of the message on purpose: a report from a phone
                    // then says which step stalled, and for how long. It goes to the
                    // console too, where a browser trace keeps it even when the page moved on.
                    console.warn(`Device restore failed after ${describeTrail()}.`, error);
                    // Only a verdict on the saved access erases it: its device key is gone, or
                    // the worker found that the two do not open (a wrong key, a changed bundle).
                    // A lock cut the restore short (the page was left, the worker died or went
                    // silent), or storage failed to answer: none says the device is gone, so the
                    // bundle is kept and the password unlocks this visit. A removed device or a
                    // revoked session is the server's to say, at the session step above.
                    if ((error as { invalid?: unknown } | null)?.invalid === true)
                        store.setState({
                            device: null,
                            rememberError: `Saved device access could not be restored (${describeTrail()}). Please sign in again.`,
                        });
                    else
                        store.setState({
                            rememberError:
                                error instanceof DeviceStorageTimeout
                                    ? `Saved device access did not respond (${describeTrail()}). Enter your password to continue.`
                                    : `Saved device access could not be opened this time (${describeTrail()}). Enter your password to continue.`,
                        });
                } finally {
                    store.setState({ restoring: false, restoreStep: null });
                }
            })().finally(() => {
                restoring = undefined;
            });
            return restoring;
        },
        // The live session is gone or belongs to a newer credential revision. Another tab
        // may have just written a fresh bundle for it, so only lock this tab; restore()
        // validates the bundle against the live session and removes it if it is really dead.
        resync() {
            lock();
        },
        async lock() {
            listen();
            lock();
            store.setState({
                device: null,
                lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
            });
            broadcastLock();
            await deviceKeys.clear();
        },
        requestEmail: (
            email: string,
            purpose: 'register' | 'recover' = 'register',
            intent?: SignupIntent,
        ) => api.requestEmail(purpose, email, intent),
        verifyEmail: (token: string) => api.verifyEmail(token),
        enrollment: (purpose: 'register' | 'recover' = 'register') => api.enrollment(purpose),
        deleteAccount: (password: string, twoStep?: StepInput) =>
            exclusive(async () => {
                const start = await own('loginStart', { password });
                const challenge = await api.deleteStart(start);
                const finish = await own('loginFinish', challenge);
                const reply = await api.deleteFinish({
                    attemptToken: challenge.attemptToken,
                    ...finish,
                    ...(twoStep ? { twoStep } : {}),
                });
                if (!readDone(reply)) throw lostChange('your account was deleted');
                lock();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                broadcastLock();
                await Promise.all([
                    deviceKeys.clear().catch(() => {}),
                    identities?.clear().catch(() => {}),
                ]);
            }),
        recoveryBackup: async (user: SessionUser) => {
            if (store.getState().unlockedUserId !== user.id)
                throw new Error('Unlock your account to view your recovery key.');
            await initializeAccount(user);
            const backup = await api.recoveryBackup();
            const { phrase } = await rpc('backup', backup);
            return { ...backup, phrase };
        },
        confirmRecoveryBackup: (recoveryVersion: number) =>
            api.confirmRecoveryBackup(recoveryVersion),
        storage: () => api.storage(),
        identity: () => api.identity(),
        identityHistory: () => api.identityHistory(),
        succeedIdentity: (input: Parameters<AuthApi['succeedIdentity']>[0]) =>
            api.succeedIdentity(input),
        contactSuccession: (userId: string, from: number) => api.contactSuccession(userId, from),
        backfillSuccessionConsent: (input: Parameters<AuthApi['backfillSuccessionConsent']>[0]) =>
            api.backfillSuccessionConsent(input),
        upgradeIdentity: (identity: IdentityEnvelope) => api.upgradeIdentity({ identity }),
        lookupContact: (email: string) => api.lookupContact(email),
        settings: () => api.settings(),
        saveSettings: (input: Parameters<AuthApi['saveSettings']>[0]) => api.saveSettings(input),
        saveSettingsKey: (input: Parameters<AuthApi['saveSettingsKey']>[0]) =>
            api.saveSettingsKey(input),
        /*
         * Resets the password with the recovery phrase. A reset replaces the phrase: the old
         * one stops working the moment the server accepts the reset, so the new one is taken
         * out of the worker first and comes back with the result whatever follows. `user` is
         * null when the sign-in after the reset did not happen here; `applied` is 'unknown'
         * when the server's answer to the reset was lost and signing in could not settle it.
         * Either way the page shows the new words: for someone whose only second step is the
         * phrase, they are the one way back in.
         */
        recover: (email: string, password: string, phrase: string) =>
            exclusive(async () => {
                const start = await own('registerStart', { password });
                const challenge = await api.recoverStart(start);
                const finish = await own('recoverFinish', { ...challenge, phrase });
                const { phrase: fresh } = await own('recoveredPhrase', {});
                // Whether the server said it applied the reset; false when its answer was lost.
                let confirmed = true;
                try {
                    const reply = await api.recoverFinish({
                        userId: challenge.userId,
                        attemptToken: challenge.attemptToken,
                        credentialVersion: challenge.credentialVersion,
                        ...finish,
                    });
                    if (!readReset(reply)) throw lostChange('your password was changed');
                } catch (error) {
                    // The server answered and refused: nothing changed, and the old phrase
                    // is still the phrase. Only this says so.
                    if (answeredRefusal(error)) throw notDone(error, 'password');
                    // No answer, or not the server's: it may have applied the reset before the
                    // reply was lost, or may apply it a moment from now.
                    confirmed = false;
                }
                lock();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                broadcastLock();
                await deviceKeys.clear().catch(() => {});
                /*
                 * Whether the reset landed: the server said so, or the sign-in below is
                 * served what this reset made (the account-key envelope it sealed, or a step
                 * naming the recovery key it sent). Without that the outcome is unknown,
                 * whatever the sign-in did: the new password signing in may be the password
                 * the account already had, and the account being as it was is no proof either,
                 * since the server can commit a moment later. So from here on the new words
                 * always come back: thrown away, they could turn out to be the only way in.
                 */
                let landed = confirmed;
                try {
                    // A second step is answered with the new phrase: nobody has seen it yet,
                    // and someone whose only step is the phrase could not answer it otherwise.
                    const user = await login(
                        email,
                        password,
                        {},
                        {
                            phrase: fresh,
                            envelopeSalt: finish.envelope.wrappingSalt,
                            recoverySalt: finish.recovery.wrappingSalt,
                            landed: () => {
                                landed = true;
                            },
                        },
                    );
                    if (landed)
                        return { user, phrase: fresh, applied: true as const, storage: null };
                    // Signed in, to an account that is not what this reset made: perhaps the
                    // password was the one it already had. The session was only the question.
                    lock();
                    await api.logout().catch(() => {});
                    return {
                        user: null,
                        phrase: fresh,
                        applied: 'unknown' as const,
                        storage: null,
                    };
                } catch (error) {
                    lock();
                    // `storage` says when this browser's device key was why it did not sign in.
                    return {
                        user: null,
                        phrase: fresh,
                        applied: landed ? (true as const) : ('unknown' as const),
                        storage: error instanceof DeviceStorageUnreadable ? error.why : null,
                    };
                }
            }),
        changeSecurity: (
            user: SessionUser,
            action: SecurityAction,
            password: string,
            newPassword?: string,
            /* The second step, for an account that has it on: asked for before this is called. */
            twoStep?: StepInput,
        ) =>
            /*
             * `phrase` in the result: the recovery phrase a rotation made (a new recovery key
             * or a new master key), whenever the change went through, or may have, and this
             * browser was not signed in again. The old phrase is dead once the server accepts
             * the change, and the page that shows the new one is behind the sign-in: someone
             * whose only second step is the phrase would be locked out without these words.
             */
            exclusive(async () => {
                lock();
                const start = await own('securityStart', { action, password, newPassword });
                const challenge = await api.securityStart({ action, ...start });
                if (challenge.userId !== user.id || challenge.action !== action)
                    throw new Error('Your account changed. Sign in again.');
                const changeEpoch = epoch;
                const finish = await own('securityFinish', challenge);
                // A rotation's new words, out of the worker before anything is sent.
                const fresh =
                    action === 'password' ? null : (await own('recoveredPhrase', {})).phrase;
                if (epoch !== changeEpoch)
                    throw new Error('Your account was locked. Please try again.');
                let committed = true;
                let failure: unknown;
                try {
                    const reply = await api.securityFinish({
                        action,
                        attemptToken: challenge.attemptToken,
                        ...finish,
                        ...(twoStep ? { twoStep } : {}),
                        // This device signs in again below. With the step on, the server
                        // then writes its session with the change, so that sign-in is not
                        // asked for a second code a moment after the first.
                        keepSession: 1,
                    });
                    // A 200 that is not the server's answer says nothing either way: it is
                    // handled below as a reply that never came.
                    if (!readDone(reply)) throw lostChange('your change was saved');
                } catch (error) {
                    // The server answered, and refused before changing anything: nothing this
                    // browser keeps needs clearing, and no other tab needs locking. The step's
                    // own refusal goes to the page as it is, to be answered again.
                    if (stepRefused(error)) throw error;
                    if (nothingChanged(error)) throw notDone(error, action);
                    // A lost response leaves the outcome unknown: the server may have
                    // replaced the credentials and revoked every session. Clean up as if it
                    // had, then let the live session say which it was.
                    committed = false;
                    failure = error;
                }
                lock();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                broadcastLock();
                await deviceKeys.clear().catch(() => {});
                /*
                 * Whether the change landed: the server said so, or the sign-in below is
                 * served what this change made (see `AfterReset`). Without that the outcome
                 * is unknown, and for a rotation the new words always come back: the account
                 * looking as it was proves nothing, since the server can commit a moment
                 * later, and words thrown away could be the only way in.
                 */
                let landed = committed;
                if (!committed && !fresh) {
                    // A password change replaces no phrase, and has nothing to learn by
                    // signing in: the live session says which it was, as before.
                    let live: SessionUser | null = null;
                    try {
                        live = (await readSession()).user;
                    } catch {
                        /* Unknown either way. */
                    }
                    if (live && live.credentialVersion === user.credentialVersion) throw failure;
                    return { signedIn: false, uncertain: true, storage: null, phrase: null };
                }
                // The server replaced the credentials and ended every session, or may have.
                // A sign-in that fails here leaves the person signed out, on the sign-in page,
                // with this browser's device key kept. After a rotation it answers a second
                // step with the new phrase, when the step names the recovery key it made.
                let signedIn = false;
                let storage: DeviceStorageReason | null = null;
                try {
                    await login(
                        user.email,
                        action === 'password' ? (newPassword ?? password) : password,
                        {},
                        fresh && finish.recovery
                            ? {
                                  phrase: fresh,
                                  envelopeSalt: finish.envelope.wrappingSalt,
                                  recoverySalt: finish.recovery.wrappingSalt,
                                  landed: () => {
                                      landed = true;
                                  },
                              }
                            : 'refuse',
                    );
                    signedIn = true;
                } catch (error) {
                    if (error instanceof DeviceStorageUnreadable) storage = error.reason;
                }
                // Signed in on what this change made (or the server said it was made): the app
                // shows the new phrase itself. In every other case a rotation's words go to
                // the page: with `uncertain`, beside the old ones until a sign-in settles it.
                if (signedIn && landed)
                    return { signedIn: true, uncertain: false, storage: null, phrase: null };
                return { signedIn, uncertain: !landed, storage, phrase: fresh };
            }),
        session: () => readSession(),
        /* Whether this tab cleared a removed device; said once, on the sign-in page. */
        takeRemovedNotice() {
            try {
                const removed = sessionStorage.getItem(REMOVED_NOTICE) === '1';
                sessionStorage.removeItem(REMOVED_NOTICE);
                return removed;
            } catch {
                return false;
            }
        },
        ensureDevice: (user: Pick<AuthUser, 'id' | 'email'>) => ensureDevice(user),
        devices: () => api.devices(),
        renameDevice: (id: string, name: string) => api.renameDevice(id, name),
        removeDevice: (id: string, password: string) =>
            withPassword(password, (proof) => api.removeDevice(id, proof)),
        /* `keep`: one other device left signed in, the one that approves for this one. */
        removeOtherDevices: (password: string, keep?: string) =>
            withPassword(password, (proof) =>
                api.removeOtherDevices({ ...proof, ...(keep ? { keep } : {}) }),
            ),
        updateProfile: (name: string) => api.updateProfile(name),
        /*
         * Signs in. For an account that asks for a second step it throws TwoStepRequired with
         * the step to answer, and `answerStep` finishes the sign-in.
         */
        login: (email: string, password: string, options?: LoginOptions) =>
            exclusive(() => login(email, password, options, 'ask')),
        answerStep,
        /*
         * Leaves a sign-in that is waiting at its step: what the worker held for it goes. With
         * `owner`, only that form's own sign-in is left: another form going away (the unlock
         * form is mounted in more than one place) must not take a step it never started.
         */
        cancelStep(owner?: object) {
            const mine = (other: object | undefined) => owner === undefined || other === owner;
            // A sign-in still on its way to the server is no longer anyone's to answer either.
            if (askedBy && mine(askedBy.owner)) askedBy = null;
            if (pendingStep && mine(pendingStep.owner)) lock();
        },
        /*
         * The step for a change this session is about to make, or null for an account that
         * has none: asked before the change, and answered with `proveStep`.
         */
        async stepChallenge(purpose: StepPurpose) {
            let reply: unknown;
            // The methods are named to a server that said it reads them, and to one that never
            // said either way (a session from before this client). One that refuses the field
            // has been rolled back, or never knew it: asked again without, and remembered.
            const advert = readAdvert();
            try {
                reply = await (
                    advert === false
                        ? api.twoStepChallenge(purpose)
                        : api.twoStepChallenge(purpose, namedMethods())
                ).catch((error: unknown) => {
                    if (advert === false || !unknownField(error)) throw error;
                    writeAdvert(false);
                    return api.twoStepChallenge(purpose);
                });
            } catch (error) {
                if ((error as { status?: unknown } | null)?.status === 409) return null;
                throw error;
            }
            const challenge = readStepChallenge(reply);
            if (!challenge) throw new Error('Please try again.');
            return challenge;
        },
        /*
         * The answer a change carries. A key's sheet (or the worker's signing) can outlast a
         * lock or a sign-out: an answer made under one session is not handed to whatever is
         * signed in after it.
         */
        async proveStep(challenge: StepChallenge, answer: StepAnswer) {
            const asked = epoch;
            const proved = await proveStep(challenge, answer, rpc);
            if (asked !== epoch) throw lockedSince();
            return proved;
        },
        twoStep: () => api.twoStep(),
        /* Starts adding an authenticator app: the password again and, once the step is on, the step. */
        startAuthenticator: (password: string, twoStep?: StepInput) =>
            withPassword(
                password,
                async (proof) => {
                    const app = readEnrolment(
                        await api.twoStepStartTotp({ ...proof, ...(twoStep ? { twoStep } : {}) }),
                    );
                    if (!app) throw lostChange('the setup was started');
                    return app;
                },
                (input) => api.twoStepReauth(input),
            ),
        /* Only the server's own answer says the app was confirmed: anything else is a lost reply. */
        async confirmAuthenticator(id: string, code: string) {
            const confirmed = readConfirmed(await api.twoStepConfirmTotp(id, code.trim()));
            if (!confirmed) throw lostChange('your authenticator app was added');
            return confirmed;
        },
        removeTwoStepMethod: (id: string, password: string, twoStep?: StepInput) =>
            withPassword(
                password,
                async (proof) => {
                    const removed = readRemoved(
                        await api.twoStepRemoveMethod(id, {
                            ...proof,
                            ...(twoStep ? { twoStep } : {}),
                        }),
                    );
                    if (!removed) throw lostChange('two-step sign-in was turned off');
                    return removed;
                },
                (input) => api.twoStepReauth(input),
            ),
        /* Whether this device can use a passkey or security key for this server at all. */
        canUsePasskeys: () => passkeys?.supported() === true,
        /*
         * Starts adding a passkey or security key: the password again and, once the step is
         * on, the step. Answers what `addPasskey` then asks the key.
         */
        startPasskey: (password: string, twoStep?: StepInput) =>
            withPassword(
                password,
                async (proof) => {
                    const started = readKeyOptions(
                        await api.twoStepKeyOptions({ ...proof, ...(twoStep ? { twoStep } : {}) }),
                    );
                    if (!started) throw lostChange('the setup was started');
                    return started;
                },
                (input) => api.twoStepReauth(input),
            ),
        /*
         * Asks the key (its sheet opens here, so this is called from the press that adds it)
         * and sends its answer. Only the server's own answer says the key was added.
         */
        async addPasskey(
            started: { registrationToken: string; options: KeyCreationOptions },
            name?: string,
        ) {
            if (!passkeys?.supported()) throw passkeyUnused(null, PASSKEY_NOT_ADDED);
            // The session the press was made under. The browser's sheet can stay open for
            // minutes, and a lock or a sign-out meanwhile leaves the server's session usable:
            // sent then, the key would be added (and the step turned on) for a page that has
            // already closed its dialog, and would throw away the backup codes that came back.
            const asked = epoch;
            const response = await passkeys.create(started.options).catch((cause: unknown) => {
                throw passkeyUnused(cause, PASSKEY_NOT_ADDED);
            });
            if (asked !== epoch) throw lockedSince();
            const added = readKeyAdded(
                await api.twoStepAddKey({
                    registrationToken: started.registrationToken,
                    ...(name?.trim() ? { name: name.trim() } : {}),
                    response,
                }),
            );
            if (!added) throw lostChange('your passkey or security key was added');
            return added;
        },
        renameTwoStepMethod: (id: string, name: string) => api.twoStepRenameMethod(id, name),
        setTwoStepDefault: (kind: TwoStepDefaultKind) => api.twoStepSetDefault(kind),
        /*
         * Approve on another device (docs/two-step-design.md 12).
         *
         * Asks another device to approve the step `challenge` is: at a sign-in (`login`), before
         * a change (its purpose), or to turn the method on (`device-approval`). A device the
         * account knows asks with its own key; a new one makes the key it will register with.
         */
        async askAnotherDevice(
            challenge: { token: string },
            purpose: string,
            /* Turning the method on: the device the person chose, the only one that may answer. */
            approverDeviceId?: string,
        ) {
            const signingIn = pendingStep?.challenge.token === challenge.token ? pendingStep : null;
            let deviceSigningKey = signingIn?.deviceKey ?? null;
            if (!deviceSigningKey && signingIn) {
                askedWith ??= (await createDeviceSigningKey()) ?? undefined;
                deviceSigningKey = askedWith?.publicKey ?? null;
            }
            // Signed in: the key this session's device registered with, and no other.
            if (!deviceSigningKey && !signingIn)
                deviceSigningKey = (await identities?.load().catch(() => null))?.publicKey ?? null;
            if (!deviceSigningKey)
                throw new DeviceStepError(
                    'unsupported',
                    'This browser can’t ask another device. Use another way.',
                );
            return askAnotherDevice(api, {
                stepToken: challenge.token,
                purpose,
                deviceSigningKey,
                describe: describeDevice,
                approverDeviceId,
            });
        },
        /* The requests this device may answer now: empty for one that holds no device key. */
        async approvals() {
            if (!identities) return [];
            return readApprovals(await api.approvals());
        },
        /* Opens a request: this device's own fresh value goes in, and the code can then be computed. */
        openApproval: (asked: ApprovalPrompt) => openApproval(api, asked),
        /*
         * Approves a request this device opened, with what the person typed from the other
         * screen. Only an exact match is signed, with this device's own key; anything else
         * ends the request.
         */
        async approveRequest(
            opened: OpenedApproval,
            reveal: { deviceSigningKey: string; nonce: string },
            typed: string,
        ) {
            const identity = await identities?.load().catch(() => null);
            if (!identity)
                throw new DeviceStepError(
                    'unsupported',
                    'This browser can’t approve for another device.',
                );
            await approve(api, {
                opened,
                reveal,
                userId: identity.userId,
                privateKey: identity.privateKey,
                typed,
            });
        },
        /* Deny, or This wasn't me: the request ends and is counted as a failed step. */
        denyApproval: async (id: string, reason: 'denied' | 'not-me') => {
            await api.approvalDeny(id, reason);
        },
        /*
         * Starts turning the method on: the password again and, once the step is on, the step.
         * Answers the pending method and the step token another device then approves.
         */
        startDeviceMethod: (password: string, twoStep?: StepInput) =>
            withPassword(
                password,
                async (proof) => {
                    const started = readDeviceEnrolment(
                        await api.twoStepStartDevice({ ...proof, ...(twoStep ? { twoStep } : {}) }),
                    );
                    if (!started) throw new Error('Please try again.');
                    return started;
                },
                (input) => api.twoStepReauth(input),
            ),
        /* Confirms it with the approval another device gave. Only the server's own answer says it is on. */
        async confirmDeviceMethod(started: { id: string; token: string }, requestId: string) {
            const confirmed = readDeviceConfirmed(
                await api.twoStepConfirmDevice(started.id, { token: started.token, requestId }),
            );
            if (!confirmed) throw lostChange('approving on another device was turned on');
            return confirmed;
        },
        newBackupCodes: (password: string, twoStep: StepInput) =>
            withPassword(
                password,
                async (proof) => {
                    const made = readBackupCodes(
                        await api.twoStepBackupCodes({ ...proof, twoStep }),
                    );
                    if (!made) throw lostChange('new backup codes were made');
                    return made;
                },
                (input) => api.twoStepReauth(input),
            ),
        securityEvents: () => api.securityEvents(),
        register: (email: string, name: string, password: string) =>
            exclusive(async () => {
                const start = await own('registerStart', { password });
                const challenge = await api.registerStart(start);
                const finish = await own('registerFinish', challenge);
                await api.registerFinish({ name, ...finish });
                try {
                    // A new account has no device here to prove: no need to read the store.
                    return await login(email, password, { asNewDevice: true });
                } catch {
                    throw new Error('Your account was created. Please sign in to unlock it.');
                }
            }),
        // Signing out removes this device on the server; its key goes here too, so the next
        // sign-in in this browser is a new device. The device databases are deleted, not emptied.
        logout: () =>
            exclusive(async () => {
                listen();
                lock();
                broadcastLock();
                store.setState({ device: null });
                await Promise.all([
                    deviceKeys.clear().catch(() => {}),
                    identities?.clear().catch(() => {}),
                    api.logout(),
                ]);
                store.setState({
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                // Signed out, nothing of the saved unlock stays: its entry goes (other tabs lock on
                // that), and the store writes none back until a sign-in saves a device (store.ts).
                store.persist.clearStorage();
            }),
    };
}
