import type { AuthApi } from '@hushos/auth/api';
import { treaty } from '@elysia/eden';
import type { Api } from '@/lib/api.server';

let client: ReturnType<typeof treaty<Api>> | undefined;
function api() {
    client ??= treaty<Api>(window.location.origin, {
        fetch: { credentials: 'same-origin', cache: 'no-store' },
        onRequest: () => ({ signal: AbortSignal.timeout(30_000) }),
    });
    return client.api.auth;
}

async function unwrap<R extends { data: unknown; error: unknown }>(pending: Promise<R>) {
    const { data, error } = await pending;
    if (error) {
        const value = (error as { value?: unknown }).value;
        const message =
            value &&
            typeof value === 'object' &&
            typeof (value as { message?: unknown }).message === 'string'
                ? (value as { message: string }).message
                : 'Please try again.';
        throw new Error(message);
    }
    return data as NonNullable<R['data']>;
}

export const authApi: AuthApi = {
    requestEmail: (purpose, email) => unwrap(api()[purpose].email.post({ email })),
    verifyEmail: (token) => unwrap(api().register.verify.post({ token })),
    enrollment: (purpose) => unwrap(api()[purpose].get()),
    registerStart: (input) => unwrap(api().register.start.post(input)),
    registerFinish: (input) => unwrap(api().register.finish.post(input)),
    loginStart: (input) => unwrap(api().login.start.post(input)),
    loginFinish: (input) => unwrap(api().login.finish.post(input)),
    session: () => unwrap(api().session.get()),
    logout: () => unwrap(api().logout.post({})),
    setup: () => unwrap(api().setup.get()),
    initialize: (input) => unwrap(api().setup.post(input)),
    recoverStart: (input) => unwrap(api().recover.start.post(input)),
    recoverFinish: (input) => unwrap(api().recover.finish.post(input)),
    recoveryBackup: () => unwrap(api()['recovery-key'].get()),
    confirmRecoveryBackup: (recoveryVersion) =>
        unwrap(api()['recovery-key'].confirm.post({ recoveryVersion })),
    storage: () => unwrap(api().storage.get()),
    securityStart: (input) => unwrap(api().security.start.post(input)),
    securityFinish: (input) => unwrap(api().security.finish.post(input)),
    deleteStart: (input) => unwrap(api().delete.start.post(input)),
    deleteFinish: (input) => unwrap(api().delete.finish.post(input)),
    updateProfile: (name) => unwrap(api().profile.post({ name })),
};
