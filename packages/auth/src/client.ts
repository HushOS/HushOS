import type { SecurityAction, SecurityUpdate } from '@hushos/crypto';
/* Shown on the contacts page; re-exported so the app needs no direct crypto dependency. */
export {
    fingerprint,
    fingerprintOfKeys,
    fingerprintWords,
    keyDigest,
    publicKeyBytes,
} from '@hushos/crypto/fingerprint';
export { pinVerified, settingsRolledBack } from '@hushos/crypto/pins';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import type { RecoveryEnvelope } from '@hushos/crypto/recovery';
import { normalizeBackupCode, normalizeTotpCode } from '@hushos/crypto/two-step/codes';
import type {
    AuthApi,
    DeviceRemovalProof,
    LoginChallenge,
    SecurityChanged,
    SignedIn,
    StepChallenge,
    StepMethod,
    StepPurpose,
    SteppedIn,
    StepSubmission,
} from './api';
import type { CryptoTransport, RequestOptions } from './crypto-transport';
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
export type AuthClientOptions = {
    identities?: DeviceIdentityStore;
    describeDevice?: () => { kind: DeviceKind; name: string };
    onRemoved?: () => Promise<void> | void;
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
    /* Asks the person for their second step, when the account has one (docs/two-step-design.md 4). */
    step?: AskStep;
};

/*
 * The second step, as a flow asks the person for it (docs/two-step-design.md 4). The flow owns
 * the protocol: which methods can still answer, when a password proof must be made again, when
 * a token is renewed. The screen only shows what it is handed and returns what was typed.
 */
export type StepAnswerKind = Exclude<StepMethod, 'webauthn'>;
/* What the person typed: a code, or the recovery phrase, which goes no further than the worker. */
export type StepAnswer =
    | { kind: 'totp' | 'backup'; code: string }
    | { kind: 'phrase'; phrase: string };
export type StepRequest = {
    /* What can answer now, in the order to offer it: a method the server paused or refused is gone. */
    methods: StepAnswerKind[];
    /*
     * Milliseconds the step token still has, counted from when it was received on this
     * device's own clock (the server's `expiresIn`), so a clock that runs fast or slow changes
     * nothing. At sign-in that is the sign-in's time; a change gets a new token.
     */
    endsIn: number;
    /* What was wrong with the last answer, in the server's words: for the field it was typed in. */
    error?: string;
    /* What changed about the step itself (a method paused, a new token): said above the field. */
    notice?: string;
};
/* Resolves with the answer, or null when the person backs out. */
export type AskStep = (request: StepRequest) => Promise<StepAnswer | null>;
/* A flow that asks for the second step, where the caller may not have one to give. */
export type StepOptions = { step?: AskStep };

/*
 * A recovery phrase this device made for a change whose reply never arrived
 * (docs/two-step-design.md 4, "When the reply is lost"): the words, and the envelope they
 * open, for the kit. Shown once and kept nowhere: whether the server took the change is not
 * known, so this may be the account's phrase now, or one that was never used.
 */
export type UnconfirmedPhrase = { phrase: string; recovery: RecoveryEnvelope };

/*
 * How a security change ended. `signedIn`: made, and this device carries on in the session
 * the server opened with it. `uncertain`: the reply never arrived, this device is locked, and
 * the person signs in again; `kit` is then the new phrase a new-phrase change or a rotation
 * made, for the person to save before they do.
 */
export type SecurityChangeResult =
    | { signedIn: true; uncertain: false }
    | { signedIn: false; uncertain: true; kit?: UnconfirmedPhrase };

/*
 * Whether the server answered a security change with a refusal of its own: one of its codes,
 * or a 4xx (the API adapter attaches both). Then nothing was done. Anything else says nothing
 * about what the server did with it: no answer at all, a timeout, a 5xx without a code (the
 * app's own or a gateway's), and a 401 without one. That 401 is "no session", which is also
 * what a request sent twice is told (a browser or a proxy resending it over a dropped
 * connection): the first copy made the change and ended the session the second arrives on.
 * None of the server's codes on this route comes with a 401, so every coded reply is a refusal.
 */
function answeredNo(error: unknown) {
    const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
    if (typeof code === 'string') return true;
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 401;
}

/* The person backed out of the second step: nothing was changed, and nothing needs saying. */
export class StepCancelled extends Error {
    constructor() {
        super('The second step was cancelled.');
        this.name = 'StepCancelled';
    }
}

/*
 * A refusal's code, as the app's API adapter attaches it to what it throws. Only the code
 * says what a refusal is: a gateway's 503 or the per-address 429 carries none, and is never
 * taken for the step's own.
 */
function refusal(error: unknown) {
    const value = error as { code?: unknown } | null;
    return {
        code: typeof value?.code === 'string' ? value.code : undefined,
        message: error instanceof Error ? error.message : 'Please try again.',
    };
}

/* What a sign-in resolves with: the account, and what its second step left to say, if it had one. */
export type SignedInHere = {
    user: AuthUser;
    step?: { answered: StepAnswerKind; offered: boolean; backupCodesLeft?: number };
};

/* The server's words for an answer that is not a code at all (readTotpCode, readBackupCode). */
const NOT_A_CODE = {
    totp: 'Enter the six digits your authenticator app shows.',
    backup: 'Enter a backup code as it was shown: ten letters and numbers.',
} as const;
/* The server's words for a client that cannot answer the step an account asks for. */
const UPDATE_REQUIRED = 'Update HushOS to sign in. This account asks for a second step.';
/* A password proof and a step token both last five minutes; neither is sent this close to its end. */
const STALE_MS = 20_000;
const PROOF_MS = 5 * 60_000;
/* When a step token ends, on this device's clock: counted from now, as it is received. */
const endOf = (challenge: StepChallenge) => Date.now() + (challenge.expiresIn ?? 300) * 1000;

export function createAuthClient(
    createTransport: () => CryptoTransport,
    deviceKeys: DeviceKeyStore,
    api: AuthApi,
    { identities, describeDevice, onRemoved }: AuthClientOptions = {},
) {
    let transport: CryptoTransport | undefined;
    let epoch = 0;
    const { store, canPersist } = createAuthStore();
    let restoring: Promise<void> | undefined;
    let busy = false;
    /*
     * From the first half of a sign-in's or a security change's exchange with the worker until
     * the account opens or the attempt ends. The worker then holds what the exchange needs (the
     * password, its OPAQUE state, the export key) and no account key, and it starts over when
     * an account operation fails (worker.ts). Anything else's account operation fails there
     * for want of the key: a settings or identity read already on its way as a password change
     * locked the worker would take the exchange with it, and the change would end as "expired"
     * on a first try. So only the exchange's own operations reach the worker meanwhile.
     */
    let exchanging = false;
    let channel: BroadcastChannel | undefined;
    let listening = false;
    function lock() {
        epoch += 1;
        const active = transport;
        transport = undefined;
        active?.lock();
        store.setState({ unlockedUserId: null });
    }
    function listen() {
        if (listening) return;
        listening = true;
        void store.persist.rehydrate();
        withStorageEvents(store, () => {
            lock();
            store.setState({ device: null });
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
                    if (event.data === 'lock') lock();
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
    ): Promise<WorkerResults[K]> {
        listen();
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
            // identity) must not throw away the change's state mid-way. Not locking here is
            // half of that: the worker starts over on such a failure whatever is done here,
            // so `ask` keeps those reads from reaching it while an exchange is held. A
            // refusal the worker kept its keys through is an ordinary error too.
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
    /*
     * The worker, for everything that is not a sign-in's or a security change's own exchange:
     * Drive, settings, identities, setup, a password check. While an exchange is held there, an
     * account operation is refused here, in the words the worker has for it, and never sent.
     * Drive's and a family's go through: their failures leave the worker as it was.
     */
    async function ask<K extends keyof WorkerRequests>(
        operation: K,
        input: WorkerRequests[K],
        options?: RequestOptions,
    ): Promise<WorkerResults[K]> {
        if (exchanging && !ordinaryFailure(String(operation)))
            throw new Error('Unlock your account first.');
        return rpc(operation, input, options);
    }
    /* The first half of an exchange: from here the worker is the exchange's (see `exchanging`). */
    function begin<K extends 'loginStart' | 'registerStart' | 'securityStart'>(
        operation: K,
        input: WorkerRequests[K],
    ) {
        exchanging = true;
        return rpc(operation, input);
    }
    /*
     * Before the second half of an exchange: a lock since the first has ended the worker that
     * began it, and a new one has nothing to finish. Said as the lock it was, not as an exchange
     * that "expired".
     */
    function stillHeld(began: number, locked = 'Your account was locked. Please try again.') {
        if (epoch !== began) throw new Error(locked);
    }
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
            const key = await createDeviceSigningKey();
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
        if (!result.user && result.removed && !busy) await forgetRemovedDevice().catch(() => {});
        return result;
    }
    async function login(email: string, password: string, options: LoginOptions = {}) {
        const loginEpoch = epoch;
        const stored = identities && !options.asNewDevice ? await storedIdentity(identities) : null;
        const start = await begin('loginStart', { password });
        const challenge = await api.loginStart({ email, ...start });
        stillHeld(loginEpoch, 'Your account was locked. Please sign in again.');
        const finish = await rpc('loginFinish', challenge);
        const device = await deviceProof(stored, email, challenge.attemptToken);
        // A lock here has already dropped the export key; do not create a session for it.
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        const answer = await api.loginFinish({
            attemptToken: challenge.attemptToken,
            ...finish,
            ...(device ? { device } : {}),
            twoStep: 1,
        });
        // An account with a second step gets a step token and nothing else until it is answered.
        const stepped =
            'twoStep' in answer
                ? await loginStep(answer.twoStep, options.step, loginEpoch)
                : undefined;
        const result = stepped?.reply ?? (answer as SignedIn);
        // A device the proof did not bring back registers itself; never in the way of signing in.
        void ensureDevice(result.user, result.device).catch(() => {});
        await open(result, loginEpoch);
        const signedIn: SignedInHere = {
            user: result.user,
            ...(stepped ? { step: { answered: stepped.answered, ...stepped.reply.twoStep } } : {}),
        };
        return signedIn;
    }
    /*
     * Opens the account from a session the server just answered with (a sign-in, or the one
     * that replaces this device's after a security change): the worker holds the password's
     * export key, the envelope opens under it, and the unlock is saved for this device.
     */
    async function open(
        result: { user: Pick<AuthUser, 'id'>; envelope: SignedIn['envelope'] },
        loginEpoch: number,
    ) {
        try {
            await rpc('unlock', { userId: result.user.id, envelope: result.envelope });
        } catch {
            throw new Error(
                'Signed in, but your account key could not be unlocked. Please sign in again.',
            );
        }
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        // The exchange is over: the worker holds the account key, and answers anything again.
        exchanging = false;
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
            const device = await rpc('remember', {
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
            const bundles = await ask('initialize', {
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
        try {
            return await action();
        } catch (error) {
            lock();
            throw error;
        } finally {
            busy = false;
            exchanging = false;
        }
    }
    /*
     * Proves the password once more (an OPAQUE exchange bound to this session) and hands the
     * finished exchange to `action`. Its own worker operations: sign-in's would drop the open
     * account, and a wrong password here is a refusal that keeps this browser unlocked.
     */
    async function passwordProof(
        password: string,
        start: (input: { startLoginRequest: string }) => Promise<LoginChallenge>,
    ): Promise<DeviceRemovalProof> {
        try {
            const begun = await ask('reauthStart', { password });
            const challenge = await start(begun);
            const finish = await ask('reauthFinish', challenge);
            return { attemptToken: challenge.attemptToken, ...finish };
        } finally {
            // A server that refused the start (429, a lost session) leaves the password in the
            // worker otherwise, until the next lock.
            await ask('reauthCancel', {}).catch(() => {});
        }
    }
    async function withPassword<T>(
        password: string,
        action: (proof: DeviceRemovalProof) => Promise<T>,
    ) {
        return action(await passwordProof(password, (input) => api.devicesReauth(input)));
    }
    /*
     * One second step, asked until it is answered (docs/two-step-design.md 4 and 10, "Codes a
     * client acts on"). `next` asks the person and builds what is sent: a code is read here
     * first, so one that is not a code costs no request, and the phrase is signed in the worker
     * and goes no further. `refused` reads a refusal by its code: what the person is told,
     * which methods can still answer, and whether the flow goes on.
     */
    function stepTalk(ask: AskStep, first: StepChallenge, renew?: () => Promise<StepChallenge>) {
        let challenge = first;
        let endsAt = endOf(first);
        let error: string | undefined;
        let notice: string | undefined;
        let asked: StepAnswerKind | undefined;
        const gone = new Set<StepAnswerKind>();
        const offered = () =>
            challenge.methods.filter(
                (method): method is StepAnswerKind =>
                    method !== 'webauthn' &&
                    (method !== 'phrase' || challenge.phrase !== undefined) &&
                    !gone.has(method),
            );
        const take = (next: StepChallenge) => {
            challenge = next;
            endsAt = endOf(next);
        };
        async function proofOf(answer: StepAnswer): Promise<StepSubmission['proof']> {
            if (answer.kind === 'phrase') {
                if (!challenge.phrase) throw new Error(UPDATE_REQUIRED);
                const { signature } = await rpc('twoStepPhrase', {
                    phrase: answer.phrase,
                    userId: challenge.phrase.userId,
                    stepToken: challenge.token,
                    wrappingSalt: challenge.phrase.wrappingSalt,
                });
                return { kind: 'phrase', signature };
            }
            const code =
                answer.kind === 'totp'
                    ? normalizeTotpCode(answer.code)
                    : normalizeBackupCode(answer.code);
            if (!code) throw Object.assign(new Error(NOT_A_CODE[answer.kind]), { kept: true });
            return { kind: answer.kind, code };
        }
        return {
            /* What answered last: for what a sign-in says once the step is passed. */
            answered: () => asked,
            async next(): Promise<StepSubmission> {
                for (;;) {
                    const methods = offered();
                    // Nothing this client can answer with: a method from a later release.
                    if (methods.length === 0)
                        throw Object.assign(new Error(notice ?? error ?? UPDATE_REQUIRED), {
                            code: 'update-required',
                        });
                    const answer = await ask({
                        methods,
                        endsIn: Math.max(0, endsAt - Date.now()),
                        ...(error ? { error } : {}),
                        ...(notice ? { notice } : {}),
                    });
                    if (!answer) throw new StepCancelled();
                    asked = answer.kind;
                    try {
                        // A token about to end is replaced before the answer is tied to it.
                        if (renew && endsAt - Date.now() < STALE_MS) take(await renew());
                        return { token: challenge.token, proof: await proofOf(answer) };
                    } catch (cause) {
                        // Not a code, or not a phrase (the worker's refusal): asked again, nothing sent.
                        if ((cause as { kept?: unknown } | null)?.kept !== true) throw cause;
                        error = refusal(cause).message;
                        notice = undefined;
                    }
                }
            },
            /*
             * `kept`: the answer was never checked and the request spent nothing, so a password
             * proof sent with it still holds. `again`: it was refused, and whatever went with it
             * is spent. `ended`: the token is gone. Undefined: not about the step at all.
             */
            async refused(cause: unknown): Promise<'kept' | 'again' | 'ended' | undefined> {
                const { code, message } = refusal(cause);
                error = undefined;
                notice = undefined;
                switch (code) {
                    case 'two-step-expired':
                        if (!renew) return 'ended';
                        take(await renew());
                        notice = message;
                        return 'again';
                    case 'not-a-code':
                        error = message;
                        return 'kept';
                    case 'two-step':
                        error = message;
                        return 'again';
                    case 'totp-frozen':
                        gone.add('totp');
                        break;
                    case 'code-budget':
                        // The budget for codes is spent: only the phrase is never refused for it.
                        gone.add('totp');
                        gone.add('backup');
                        break;
                    case 'two-step-unavailable':
                        // The server cannot check this kind of code just now; the phrase still answers.
                        if (asked && asked !== 'phrase') gone.add(asked);
                        break;
                    default:
                        return undefined;
                }
                // About the step, not the answer: said above the field. With nothing left to
                // answer with, the refusal is the flow's.
                notice = message;
                return offered().length > 0 ? 'again' : undefined;
            },
        };
    }
    /*
     * A change the second step guards (docs/two-step-design.md 4): the password first, then
     * the step, then the change, in one request. `prove` makes the password proof and `finish`
     * sends it with the answer. An account without the step (`on: false`) runs the change on
     * the password alone.
     *
     * `proveFirst` is for the changes whose proof locks this browser anyway (a password change,
     * a rotation, deletion): the password is proved before the person is asked, so a wrong one
     * is said at once. The others (turning the step on, removing a method, new codes) prove it
     * once the answer is in hand, so backing out of the step leaves no unfinished password
     * proof behind for the server to count. A proof is one use: after an answer the server
     * refused it is made again, with the next answer; after one the server did not read as a
     * code (`not-a-code`) it is kept. A proof or a token the person took too long over is
     * replaced quietly; a proof's age is counted from before it is made.
     */
    async function behindStep<P, T>(
        purpose: StepPurpose,
        ask: AskStep | undefined,
        prove: () => Promise<P>,
        finish: (proof: P, twoStep?: StepSubmission) => Promise<T>,
        { proveFirst = false }: { proveFirst?: boolean } = {},
    ): Promise<T> {
        const offer = await api.twoStepChallenge(purpose);
        if (!offer.on) return finish(await prove());
        if (!ask)
            throw Object.assign(new Error('Confirm it’s you with your second step.'), {
                code: 'two-step',
            });
        const talk = stepTalk(ask, offer, async () => {
            const next = await api.twoStepChallenge(purpose);
            // Turned off from another device while this one was asking.
            if (!next.on) throw new Error('Two-step sign-in was turned off. Try again.');
            return next;
        });
        let proof: { value: P; at: number } | undefined;
        const make = async () => {
            const at = Date.now();
            proof = { value: await prove(), at };
            return proof;
        };
        if (proveFirst) await make();
        for (;;) {
            const twoStep = await talk.next();
            const fresh =
                proof && Date.now() - proof.at <= PROOF_MS - STALE_MS ? proof : await make();
            try {
                return await finish(fresh.value, twoStep);
            } catch (error) {
                const outcome = await talk.refused(error);
                if (outcome !== 'kept' && outcome !== 'again') throw error;
                if (outcome === 'again') proof = undefined;
            }
        }
    }
    /*
     * The second step of a sign-in: the worker keeps the password's export key while the
     * person answers, and the envelope it opens comes only with a right answer. A wrong
     * answer is asked again on the same token; once the token is gone the sign-in is over and
     * starts again from the password.
     */
    async function loginStep(
        challenge: StepChallenge,
        ask: AskStep | undefined,
        loginEpoch: number,
    ): Promise<{ reply: SteppedIn; answered: StepAnswerKind }> {
        if (!ask) throw new Error('This account asks for a second step. Sign in again.');
        const talk = stepTalk(ask, challenge);
        for (;;) {
            const submission = await talk.next();
            // A lock here has already dropped the export key; do not open a session for it.
            if (epoch !== loginEpoch)
                throw new Error('Your account was locked. Please sign in again.');
            try {
                return {
                    reply: await api.loginTwoStep(submission),
                    answered: talk.answered() ?? 'totp',
                };
            } catch (error) {
                const outcome = await talk.refused(error);
                if (outcome !== 'kept' && outcome !== 'again') throw error;
            }
        }
    }
    return {
        store,
        isAuthenticating: () => busy,
        initializeAccount,
        /* Other domains (Drive) reach the crypto worker through the same transport and lock. */
        rpc: ask,
        // `validated`: the caller has just confirmed `user` against the live session
        // (a route guard did), so the bundle can be checked without another request.
        async restore(user: SessionUser, options: { validated?: boolean } = {}) {
            listen();
            if (store.getState().unlockedUserId === user.id) return;
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
                const OWNED = 'a sign-in or a security change began';
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
                    // Not while a sign-in or a security change owns the worker: opening the
                    // saved key there starts the worker's state over, and would drop the half
                    // of an exchange it holds. This stops for it, here and below, as for a
                    // lock: it opens the account itself, or leaves it for the next restore.
                    if (busy) return stop(OWNED);
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
                    if (busy) return stop(OWNED);
                    if (epoch !== restoringEpoch) return stop('locked while opening the key');
                    store.setState({ unlockedUserId: user.id, rememberError: '' });
                } catch (error) {
                    // Cut short by a sign-in or a change that began meanwhile (its lock ended
                    // the worker this restore was asking): the worker open now is theirs, and
                    // so is what this device is told. Locking here would end their exchange.
                    if (busy) return stop(OWNED);
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
        deleteAccount: (password: string, options: StepOptions = {}) =>
            exclusive(async () => {
                await behindStep(
                    'delete',
                    options.step,
                    async () => {
                        const began = epoch;
                        const start = await begin('loginStart', { password });
                        const challenge = await api.deleteStart(start);
                        stillHeld(began);
                        const finish = await rpc('loginFinish', challenge);
                        return { attemptToken: challenge.attemptToken, ...finish };
                    },
                    (proof, twoStep) =>
                        api.deleteFinish({ ...proof, ...(twoStep ? { twoStep } : {}) }),
                    { proveFirst: true },
                );
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
            const { phrase } = await ask('backup', backup);
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
        recover: (email: string, password: string, phrase: string) =>
            exclusive(async () => {
                const began = epoch;
                const start = await begin('registerStart', { password });
                const challenge = await api.recoverStart(start);
                stillHeld(began);
                const finish = await rpc('recoverFinish', { ...challenge, phrase });
                try {
                    await api.recoverFinish({
                        userId: challenge.userId,
                        attemptToken: challenge.attemptToken,
                        credentialVersion: challenge.credentialVersion,
                        ...finish,
                    });
                } catch (error) {
                    // The server may have committed before the response was lost. Retrying
                    // with the old phrase would then fail for the wrong reason.
                    throw new Error(
                        `${error instanceof Error ? error.message : 'Please try again.'} If it keeps failing, try signing in with your new password first: the reset may already have been applied.`,
                    );
                }
                lock();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                broadcastLock();
                await deviceKeys.clear().catch(() => {});
                try {
                    return await login(email, password);
                } catch (error) {
                    // The new password is in place either way; say why it did not sign in here.
                    if (error instanceof DeviceStorageUnreadable)
                        throw new Error(
                            `Your password was changed, but ${error.why}, so you weren’t signed in here. Sign in with your new password.`,
                            { cause: error },
                        );
                    throw new Error('Your password was changed. Sign in with your new password.');
                }
            }),
        changeSecurity: (
            user: SessionUser,
            action: SecurityAction,
            password: string,
            newPassword?: string,
            options: StepOptions = {},
        ): Promise<SecurityChangeResult> =>
            exclusive(async () => {
                // What the server answered the change itself, as against the password or the
                // step, and the update that was sent to it.
                let sent: { error: unknown; update: SecurityUpdate } | undefined;
                // The lock the last password proof began with: the worker holds the new
                // password's key from there, until the change is made or something locks.
                let changeEpoch = epoch;
                let changed: SecurityChanged;
                try {
                    changed = await behindStep(
                        action,
                        options.step,
                        async () => {
                            lock();
                            // From this lock on, not from the server's answer: a lock during
                            // that round trip ends the worker that holds the first half.
                            changeEpoch = epoch;
                            const start = await begin('securityStart', {
                                action,
                                password,
                                newPassword,
                            });
                            const challenge = await api.securityStart({ action, ...start });
                            if (challenge.userId !== user.id || challenge.action !== action)
                                throw new Error('Your account changed. Sign in again.');
                            stillHeld(changeEpoch);
                            const finish = await rpc('securityFinish', challenge);
                            stillHeld(changeEpoch);
                            return { attemptToken: challenge.attemptToken, ...finish };
                        },
                        async (proof, twoStep) => {
                            try {
                                return await api.securityFinish({
                                    action,
                                    ...proof,
                                    ...(twoStep ? { twoStep } : {}),
                                });
                            } catch (error) {
                                sent = { error, update: proof };
                                throw error;
                            }
                        },
                        { proveFirst: true },
                    );
                } catch (error) {
                    // Before the change was sent (a wrong password, the step backed out of):
                    // nothing happened, and the failure is the caller's as it is.
                    if (!sent || sent.error !== error) throw error;
                    /*
                     * A new phrase or a rotation the server may have made without this device
                     * hearing of it: the phrase it made is the only copy there is, and the
                     * second step may ask for it at the next sign-in. So before the lock drops
                     * the new password's key, the worker opens the account from the envelope
                     * that was sent and reads the phrase out of the recovery envelope sent
                     * with it, for the person to save (docs/two-step-design.md 4). Not after a
                     * refusal: the server said no, and the old phrase stands. A worker that
                     * locked meanwhile reads nothing, and the change ends as it did before.
                     */
                    let kit: UnconfirmedPhrase | undefined;
                    const recovery = action === 'password' ? undefined : sent.update.recovery;
                    if (recovery && !answeredNo(error) && epoch === changeEpoch)
                        try {
                            await rpc('unlock', {
                                userId: user.id,
                                envelope: sent.update.envelope,
                            });
                            const { phrase } = await rpc('backup', { userId: user.id, recovery });
                            // A lock while the worker read drops the words with the key.
                            if (epoch === changeEpoch) kit = { phrase, recovery };
                        } catch {
                            /* Locked, or a worker that died: no phrase to show. */
                        }
                    // A lost response leaves the outcome unknown: the server may have
                    // replaced the credentials and ended every session, and the one it
                    // opened for this device never arrived. Clean up as if it had, then let
                    // the live session say which it was.
                    lock();
                    store.setState({
                        device: null,
                        lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                    });
                    broadcastLock();
                    await deviceKeys.clear().catch(() => {});
                    // With a phrase in hand the session is not asked: whatever it says, the
                    // phrase is shown (old credentials only mean "not yet", when the server
                    // was still at work as the wait ran out), and the person is not kept
                    // waiting on a second request while a reload would lose the words.
                    if (kit) return { signedIn: false, uncertain: true, kit };
                    let live: SessionUser | null = null;
                    try {
                        live = (await readSession()).user;
                    } catch {
                        /* Unknown either way. */
                    }
                    // Still the old credentials: not made.
                    if (live && live.credentialVersion === user.credentialVersion) throw error;
                    return { signedIn: false, uncertain: true };
                }
                /*
                 * The change is made. The server ended every session of the account and, in
                 * the same step, opened the one this device carries on in (its reply set the
                 * cookie), so nobody signs in again here: a sign-in could ask for a second step
                 * the person can no longer answer (docs/two-step-design.md 4). The worker still
                 * holds the new password's key, and opens the account from the envelope the
                 * server answered with; the unlock saved for the old credentials is replaced.
                 * Other tabs hold the old keys: they lock, and open again from the new one.
                 */
                broadcastLock();
                await deviceKeys.clear().catch(() => {});
                try {
                    if (epoch !== changeEpoch) throw new Error('Your account was locked.');
                    await open(changed, changeEpoch);
                } catch {
                    // Signed in, but not open here (a lock meanwhile, a worker that died): the
                    // password opens it, as after any lock.
                    lock();
                    store.setState({
                        device: null,
                        lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                    });
                }
                return { signedIn: true, uncertain: false };
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
        removeOtherDevices: (password: string) =>
            withPassword(password, (proof) => api.removeOtherDevices(proof)),
        /*
         * Two-step sign-in (docs/two-step-design.md). Every change to it proves the password
         * again, in an exchange of its own that keeps this browser unlocked, and, once the
         * step is on, answers the step (`options.step`).
         */
        twoStep: () => api.twoStep(),
        startTotp: (password: string, options: StepOptions = {}) =>
            behindStep(
                'two-step',
                options.step,
                () => passwordProof(password, (input) => api.twoStepReauth(input)),
                (proof, twoStep) => api.startTotp({ ...proof, ...(twoStep ? { twoStep } : {}) }),
            ),
        confirmTotp: (id: string, code: string, signOutOthers: boolean) =>
            api.confirmTotp(id, { code, signOutOthers }),
        removeTwoStepMethod: (id: string, password: string, options: StepOptions = {}) =>
            behindStep(
                'two-step',
                options.step,
                () => passwordProof(password, (input) => api.twoStepReauth(input)),
                (proof, twoStep) =>
                    api.removeTwoStepMethod(id, { ...proof, ...(twoStep ? { twoStep } : {}) }),
            ),
        newBackupCodes: (password: string, options: StepOptions = {}) =>
            behindStep(
                'two-step',
                options.step,
                () => passwordProof(password, (input) => api.twoStepReauth(input)),
                (proof, twoStep) =>
                    api.replaceBackupCodes({ ...proof, ...(twoStep ? { twoStep } : {}) }),
            ),
        updateProfile: (name: string) => api.updateProfile(name),
        login: (email: string, password: string, options?: LoginOptions) =>
            exclusive(() => login(email, password, options)),
        register: (email: string, name: string, password: string) =>
            exclusive(async () => {
                const began = epoch;
                const start = await begin('registerStart', { password });
                const challenge = await api.registerStart(start);
                stillHeld(began);
                const finish = await rpc('registerFinish', challenge);
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
