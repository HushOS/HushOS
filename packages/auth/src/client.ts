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
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import type { AuthApi } from './api';
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
/*
 * The sign-in's words when this browser's device key could not be read. Fixed, so the sign-in
 * page shows them as they are: a busy or slow store is never read as "no key here".
 */
export const DEVICE_STORAGE_BUSY =
    'This browser’s storage for HushOS is busy. Close other HushOS tabs, then sign in again.';
/* How long a sign-in waits before reading a store that did not answer once more. */
export const DEVICE_STORAGE_RETRY_MS = 1_000;

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
    async function deviceProof(email: string, attemptToken: string) {
        if (!identities) return undefined;
        const stored = await storedIdentity(identities);
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
     * The stored device key, or null only when the store answered that it holds none. A store
     * that is busy (another tab holding it), slow (the open gave up) or failing is read once more
     * after a pause, and then the sign-in stops: going on would register this browser as a new
     * device, with a notice and an email about a sign-in that was this device all along.
     */
    async function storedIdentity(store: DeviceIdentityStore) {
        try {
            return await store.load();
        } catch {
            await new Promise((resolve) => setTimeout(resolve, DEVICE_STORAGE_RETRY_MS));
            try {
                return await store.load();
            } catch (error) {
                throw new Error(DEVICE_STORAGE_BUSY, { cause: error });
            }
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
    async function login(email: string, password: string) {
        const loginEpoch = epoch;
        const start = await rpc('loginStart', { password });
        const challenge = await api.loginStart({ email, ...start });
        const finish = await rpc('loginFinish', challenge);
        const device = await deviceProof(email, challenge.attemptToken);
        // A lock here has already dropped the export key; do not create a session for it.
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        const result = await api.loginFinish({
            attemptToken: challenge.attemptToken,
            ...finish,
            ...(device ? { device } : {}),
        });
        // A device the proof did not bring back registers itself; never in the way of signing in.
        void ensureDevice(result.user, result.device).catch(() => {});
        try {
            await rpc('unlock', { userId: result.user.id, envelope: result.envelope });
        } catch {
            throw new Error(
                'Signed in, but your account key could not be unlocked. Please sign in again.',
            );
        }
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
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
        return result.user;
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
        try {
            return await action();
        } catch (error) {
            lock();
            throw error;
        } finally {
            busy = false;
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
    ) {
        try {
            const start = await rpc('reauthStart', { password });
            const challenge = await api.devicesReauth(start);
            const finish = await rpc('reauthFinish', challenge);
            return await action({ attemptToken: challenge.attemptToken, ...finish });
        } finally {
            // A server that refused the start (429, a lost session) leaves the password in the
            // worker otherwise, until the next lock.
            await rpc('reauthCancel', {}).catch(() => {});
        }
    }
    return {
        store,
        isAuthenticating: () => busy,
        initializeAccount,
        /* Other domains (Drive) reach the crypto worker through the same transport and lock. */
        rpc,
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
        deleteAccount: (password: string) =>
            exclusive(async () => {
                const start = await rpc('loginStart', { password });
                const challenge = await api.deleteStart(start);
                const finish = await rpc('loginFinish', challenge);
                await api.deleteFinish({ attemptToken: challenge.attemptToken, ...finish });
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
        recover: (email: string, password: string, phrase: string) =>
            exclusive(async () => {
                const start = await rpc('registerStart', { password });
                const challenge = await api.recoverStart(start);
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
                } catch {
                    throw new Error('Your password was changed. Sign in with your new password.');
                }
            }),
        changeSecurity: (
            user: SessionUser,
            action: SecurityAction,
            password: string,
            newPassword?: string,
        ) =>
            exclusive(async () => {
                lock();
                const start = await rpc('securityStart', { action, password, newPassword });
                const challenge = await api.securityStart({ action, ...start });
                if (challenge.userId !== user.id || challenge.action !== action)
                    throw new Error('Your account changed. Sign in again.');
                const changeEpoch = epoch;
                const finish = await rpc('securityFinish', challenge);
                if (epoch !== changeEpoch)
                    throw new Error('Your account was locked. Please try again.');
                let committed = true;
                let failure: unknown;
                try {
                    await api.securityFinish({
                        action,
                        attemptToken: challenge.attemptToken,
                        ...finish,
                    });
                } catch (error) {
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
                if (!committed) {
                    let live: SessionUser | null = null;
                    try {
                        live = (await readSession()).user;
                    } catch {
                        /* Unknown either way. */
                    }
                    if (live && live.credentialVersion === user.credentialVersion) throw failure;
                    return { signedIn: false, uncertain: true };
                }
                try {
                    await login(
                        user.email,
                        action === 'password' ? (newPassword ?? password) : password,
                    );
                    return { signedIn: true, uncertain: false };
                } catch {
                    return { signedIn: false, uncertain: false };
                }
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
        updateProfile: (name: string) => api.updateProfile(name),
        login: (email: string, password: string) => exclusive(() => login(email, password)),
        register: (email: string, name: string, password: string) =>
            exclusive(async () => {
                const start = await rpc('registerStart', { password });
                const challenge = await api.registerStart(start);
                const finish = await rpc('registerFinish', challenge);
                await api.registerFinish({ name, ...finish });
                try {
                    return await login(email, password);
                } catch {
                    throw new Error('Your account was created. Please sign in to unlock it.');
                }
            }),
        // Signing out removes this device on the server; its key goes here too, so the next
        // sign-in in this browser is a new device.
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
            }),
    };
}
