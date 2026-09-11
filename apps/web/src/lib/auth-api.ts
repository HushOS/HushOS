import type { AuthApi } from '@hushos/auth/api';
import { apiClient, unwrap } from '@/lib/api-client';

const api = () => apiClient().auth;

export const authApi: AuthApi = {
    requestEmail: (purpose, email, intent) =>
        unwrap(api()[purpose].email.post(intent ? { email, intent } : { email })),
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
