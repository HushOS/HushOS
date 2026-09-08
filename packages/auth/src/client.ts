import type { SecurityAction, SecurityChallenge } from '@hushos/crypto';
import type { CryptoTransport } from './crypto-transport';
import type { RecoveryEnvelope } from '@hushos/crypto/recovery';
import { createAuthStore } from './store';
import { withStorageEvents } from './with-storage-events';
import type { DeviceKeyStore } from './device-storage';
import type { AccountKeyEnvelope, AuthUser, SessionUser } from './protocol';
import type { WorkerRequests, WorkerResults } from './worker';

export function createAuthClient(
    createTransport: () => CryptoTransport,
    deviceKeys: DeviceKeyStore,
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
        transport?.lock();
        transport = undefined;
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
    ): Promise<WorkerResults[K]> {
        listen();
        transport ??= createTransport();
        const activeTransport = transport;
        try {
            return await activeTransport.request(operation, input);
        } catch (error) {
            if (transport === activeTransport) lock();
            throw error;
        }
    }
    async function request<T>(path: string, input?: object): Promise<T> {
        const response = await fetch(`/api/auth/${path}`, {
            method: input ? 'POST' : 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: input ? { 'Content-Type': 'application/json' } : undefined,
            body: input ? JSON.stringify(input) : undefined,
            signal: AbortSignal.timeout(30_000),
        });
        const data = await response.json();
        if (!response.ok)
            throw new Error(typeof data.message === 'string' ? data.message : 'Please try again.');
        return data as T;
    }
    async function login(email: string, password: string) {
        const start = await rpc('loginStart', { password });
        const challenge = await request<{
            attemptToken: string;
            loginResponse: string;
            profileVersion: number;
        }>('login/start', { email, ...start });
        const finish = await rpc('loginFinish', challenge);
        const result = await request<{ user: AuthUser; envelope: AccountKeyEnvelope }>(
            'login/finish',
            { attemptToken: challenge.attemptToken, ...finish },
        );
        const loginEpoch = epoch;
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
            const { missing } = await request<{
                missing: { recovery: boolean; identity: boolean; workspace: boolean } | null;
            }>('setup');
            if (!missing || !Object.values(missing).some(Boolean)) return false;
            if (epoch !== setupEpoch) throw new Error('Your account was locked.');
            const bundles = await rpc('initialize', { userId: user.id, ...missing });
            if (epoch !== setupEpoch) throw new Error('Your account was locked.');
            await request('setup', bundles);
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
        async restore(user: SessionUser) {
            listen();
            if (store.getState().unlockedUserId === user.id) return;
            if (restoring) return restoring;
            restoring = (async () => {
                store.setState({ restoring: true });
                try {
                    const restoringEpoch = epoch;
                    await store.persist.rehydrate();
                    const device = store.getState().device;
                    if (!device || device.userId !== user.id) return;
                    const { user: sessionUser } = await request<{ user: SessionUser | null }>(
                        'session',
                    );
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
                    const deviceKey = await deviceKeys.load(device.deviceKeyId);
                    if (epoch !== restoringEpoch) return;
                    if (!deviceKey) throw new Error('The saved device key is unavailable.');
                    await rpc('restore', { bundle: device, deviceKey });
                    if (epoch !== restoringEpoch) return;
                    store.setState({ unlockedUserId: user.id, rememberError: '' });
                } catch {
                    lock();
                    store.setState({
                        device: null,
                        rememberError:
                            'Saved device access could not be restored. Please sign in again.',
                    });
                } finally {
                    store.setState({ restoring: false });
                }
            })().finally(() => {
                restoring = undefined;
            });
            return restoring;
        },
        async expireSession() {
            lock();
            store.setState({ device: null });
            await deviceKeys.clear().catch(() => {});
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
        requestEmail: (email: string, purpose: 'register' | 'recover' = 'register') =>
            request<{ message: string }>(`${purpose}/email`, { email }),
        verifyEmail: (token: string) =>
            request<{ enrollment: { id: string; email: string; purpose: 'register' | 'recover' } }>(
                'register/verify',
                { token },
            ),
        enrollment: (purpose: 'register' | 'recover' = 'register') =>
            request<{ enrollment: { id: string; email: string } | null }>(purpose),
        deleteAccount: (password: string) =>
            exclusive(async () => {
                const start = await rpc('loginStart', { password });
                const challenge = await request<{
                    attemptToken: string;
                    loginResponse: string;
                    profileVersion: number;
                }>('delete/start', start);
                const finish = await rpc('loginFinish', challenge);
                await request('delete/finish', { attemptToken: challenge.attemptToken, ...finish });
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
            const backup = await request<{
                userId: string;
                recovery: RecoveryEnvelope;
                confirmed: boolean;
            }>('recovery-key');
            const { phrase } = await rpc('backup', backup);
            return { ...backup, phrase };
        },
        confirmRecoveryBackup: (recoveryVersion: number) =>
            request('recovery-key/confirm', { recoveryVersion }),
        storage: () =>
            request<{
                storage: {
                    workspaceId: string;
                    quotaBytes: string;
                    usedBytes: string;
                    reservedBytes: string;
                    availableBytes: string;
                } | null;
            }>('storage'),
        recover: (email: string, password: string, phrase: string) =>
            exclusive(async () => {
                const start = await rpc('registerStart', { password });
                const challenge = await request<{
                    registrationResponse: string;
                    userId: string;
                    profileVersion: number;
                    credentialVersion: number;
                    attemptToken: string;
                    recovery: RecoveryEnvelope;
                }>('recover/start', start);
                const finish = await rpc('recoverFinish', { ...challenge, phrase });
                await request('recover/finish', {
                    userId: challenge.userId,
                    attemptToken: challenge.attemptToken,
                    credentialVersion: challenge.credentialVersion,
                    ...finish,
                });
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
                const challenge = await request<SecurityChallenge>('security/start', {
                    action,
                    ...start,
                });
                if (challenge.userId !== user.id || challenge.action !== action)
                    throw new Error('Your account changed. Sign in again.');
                const changeEpoch = epoch;
                const finish = await rpc('securityFinish', challenge);
                if (epoch !== changeEpoch)
                    throw new Error('Your account was locked. Please try again.');
                await request('security/finish', {
                    action,
                    attemptToken: challenge.attemptToken,
                    ...finish,
                });
                lock();
                store.setState({
                    device: null,
                    lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
                });
                broadcastLock();
                await deviceKeys.clear().catch(() => {});
                try {
                    await login(
                        user.email,
                        action === 'password' ? (newPassword ?? password) : password,
                    );
                    return { signedIn: true };
                } catch {
                    return { signedIn: false };
                }
            }),
        session: () => request<{ user: SessionUser | null }>('session'),
        login: (email: string, password: string) => exclusive(() => login(email, password)),
        register: (email: string, name: string, password: string) =>
            exclusive(async () => {
                const start = await rpc('registerStart', { password });
                const challenge = await request<{
                    registrationResponse: string;
                    userId: string;
                    profileVersion: number;
                }>('register/start', start);
                const finish = await rpc('registerFinish', challenge);
                await request<{ user: AuthUser }>('register/finish', { name, ...finish });
                try {
                    return await login(email, password);
                } catch {
                    throw new Error('Your account was created. Please sign in to unlock it.');
                }
            }),
        async logout() {
            listen();
            lock();
            broadcastLock();
            store.setState({
                device: null,
                lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
            });
            await Promise.all([deviceKeys.clear().catch(() => {}), request('logout', {})]);
            store.setState({
                lockRevision: Math.max(Date.now(), store.getState().lockRevision + 1),
            });
        },
    };
}
