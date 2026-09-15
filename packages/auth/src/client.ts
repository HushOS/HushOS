import type { SecurityAction } from '@hushos/crypto';
/* Shown on the contacts page; re-exported so the app needs no direct crypto dependency. */
export { fingerprint, keyDigest, publicKeyBytes } from '@hushos/crypto';
import type { IdentityKem } from '@hushos/crypto/identity';
import type { AuthApi } from './api';
import type { CryptoTransport, RequestOptions } from './crypto-transport';
import { createAuthStore } from './store';
import { withStorageEvents } from './with-storage-events';
import { DeviceStorageTimeout, type DeviceKeyStore } from './device-storage';
import type { RestoreStep } from './store';
import type { SessionUser, SignupIntent } from './protocol';
import type { WorkerRequests, WorkerResults } from './worker';

export function createAuthClient(
    createTransport: () => CryptoTransport,
    deviceKeys: DeviceKeyStore,
    api: AuthApi,
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
            // already reset itself, so lock here too. A Drive operation that fails is an
            // ordinary error for its caller; the transport reports its own death
            // through onLock, which is the only Drive failure that should lock.
            if (!String(operation).startsWith('drive') && transport === activeTransport) lock();
            throw error;
        }
    }
    async function login(email: string, password: string) {
        const loginEpoch = epoch;
        const start = await rpc('loginStart', { password });
        const challenge = await api.loginStart({ email, ...start });
        const finish = await rpc('loginFinish', challenge);
        // A lock here has already dropped the export key; do not create a session for it.
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        const result = await api.loginFinish({ attemptToken: challenge.attemptToken, ...finish });
        try {
            await rpc('unlock', { userId: result.user.id, envelope: result.envelope });
        } catch {
            throw new Error(
                'Signed in, but your account key could not be unlocked. Please sign in again.',
            );
        }
        if (epoch !== loginEpoch) throw new Error('Your account was locked. Please sign in again.');
        store.setState({ unlockedUserId: result.user.id, rememberError: '' });
        try {
            if (!canPersist()) throw new Error('Device storage is unavailable.');
            const saved = await deviceKeys.create();
            if (epoch !== loginEpoch) throw new Error('Your account was locked.');
            const device = await rpc('remember', {
                deviceKey: saved.key,
                identity: {
                    userId: result.user.id,
                    deviceKeyId: saved.id,
                    keyVersion: result.envelope.keyVersion,
                    credentialVersion: result.envelope.credentialVersion,
                },
            });
            if (epoch !== loginEpoch) throw new Error('Your account was locked.');
            store.setState({ device });
            if (!canPersist()) throw new Error('Device storage is unavailable.');
        } catch {
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
                store.setState({ restoring: true, restoreStep: null });
                try {
                    const restoringEpoch = epoch;
                    step('rehydrate');
                    await store.persist.rehydrate();
                    const device = store.getState().device;
                    if (!device || device.userId !== user.id) return;
                    let sessionUser: SessionUser | null;
                    step('session');
                    try {
                        sessionUser = options.validated ? user : (await api.session()).user;
                    } catch {
                        // Offline or a flaky connection: the bundle may be fine. Keep it and
                        // let the next focus or session check try again.
                        return;
                    }
                    if (
                        !sessionUser ||
                        sessionUser.id !== device.userId ||
                        sessionUser.credentialVersion !== device.credentialVersion
                    ) {
                        lock();
                        store.setState({ device: null });
                        return;
                    }
                    if (epoch !== restoringEpoch) return;
                    step('device-key');
                    const deviceKey = await deviceKeys.load(device.deviceKeyId);
                    if (epoch !== restoringEpoch) return;
                    if (!deviceKey) throw new Error('The saved device key is unavailable.');
                    step('worker');
                    await rpc('restore', { bundle: device, deviceKey });
                    if (epoch !== restoringEpoch) return;
                    store.setState({ unlockedUserId: user.id, rememberError: '' });
                } catch (error) {
                    lock();
                    // Storage that merely failed to answer keeps the bundle for next time;
                    // the password unlocks this visit.
                    // The trail is part of the message on purpose: a report from a phone
                    // then says which step stalled, and for how long. It goes to the
                    // console too, where a browser trace keeps it even when the page moved on.
                    console.warn(`Device restore failed after ${describeTrail()}.`, error);
                    if (error instanceof DeviceStorageTimeout)
                        store.setState({
                            rememberError: `Saved device access did not respond (${describeTrail()}). Enter your password to continue.`,
                        });
                    else
                        store.setState({
                            device: null,
                            rememberError: `Saved device access could not be restored (${describeTrail()}). Please sign in again.`,
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
                await deviceKeys.clear().catch(() => {});
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
        addIdentityKem: (kem: IdentityKem) => api.addIdentityKem(kem),
        lookupContact: (email: string) => api.lookupContact(email),
        settings: () => api.settings(),
        saveSettings: (input: { expectedVersion: number; nonce: string; ciphertext: string }) =>
            api.saveSettings(input),
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
                        live = (await api.session()).user;
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
        session: () => api.session(),
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
        logout: () =>
            exclusive(async () => {
                listen();
                lock();
                broadcastLock();
                store.setState({ device: null });
                await Promise.all([deviceKeys.clear().catch(() => {}), api.logout()]);
                store.setState({
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
            }),
    };
}
