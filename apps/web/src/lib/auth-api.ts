import type { AuthApi } from '@hushos/auth/api';
import { NAMED_STEP_METHODS } from '@hushos/auth/client';
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
    // `twoStep: 1`: this client can answer a second step, so the server may send one. The
    // reply is read by the auth client, which never takes a 200 on trust (login-reply.ts).
    loginFinish: (input) => unwrap(api().login.finish.post({ ...input, twoStep: 1 })),
    loginTwoStep: (input) => unwrap(api().login['two-step'].post(input)),
    // Every kind of method this page can list, whether or not this browser can use one.
    twoStep: () =>
        unwrap(api()['two-step'].get({ query: { methods: NAMED_STEP_METHODS.join(',') } })),
    twoStepReauth: (input) => unwrap(api()['two-step'].reauth.post(input)),
    twoStepChallenge: (purpose, twoStepMethods) =>
        unwrap(
            api()['two-step'].challenge.post({
                purpose,
                ...(twoStepMethods ? { twoStepMethods } : {}),
            }),
        ),
    twoStepKeyOptions: (input) => unwrap(api()['two-step'].keys.options.post(input)),
    twoStepAddKey: (input) => unwrap(api()['two-step'].keys.post(input)),
    twoStepRenameMethod: (id, name) => unwrap(api()['two-step'].methods({ id }).put({ name })),
    twoStepSetDefault: (kind) => unwrap(api()['two-step'].default.put({ kind })),
    twoStepStartTotp: (input) => unwrap(api()['two-step'].totp.post(input)),
    twoStepConfirmTotp: (id, code) => unwrap(api()['two-step'].totp({ id }).confirm.post({ code })),
    twoStepRemoveMethod: (id, input) => unwrap(api()['two-step'].methods({ id }).delete(input)),
    twoStepBackupCodes: (input) => unwrap(api()['two-step']['backup-codes'].post(input)),
    securityEvents: () => unwrap(api()['security-events'].get()),
    session: () => unwrap(api().session.get()),
    forgetSession: () => unwrap(api().session.forget.post({})),
    devices: () => unwrap(api().devices.get()),
    registerDevice: (input) => unwrap(api().devices.post(input)),
    renameDevice: (id, name) => unwrap(api().devices({ id }).put({ name })),
    devicesReauth: (input) => unwrap(api().devices.reauth.post(input)),
    removeDevice: (id, proof) => unwrap(api().devices({ id }).delete(proof)),
    removeOtherDevices: (proof) => unwrap(api().devices.others.delete(proof)),
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
    identity: () => unwrap(api().identity.get()),
    identityHistory: () => unwrap(api().identity.history.get()),
    succeedIdentity: (input) => unwrap(api().identity.succession.post(input)),
    backfillSuccessionConsent: (input) => unwrap(api().identity.succession.consent.post(input)),
    contactSuccession: (userId, from) =>
        unwrap(api().contacts({ userId }).succession.get({ query: { from } })),
    saveSettingsKey: (input) => unwrap(api()['settings-key'].put(input)),
    upgradeIdentity: (input) => unwrap(api().identity.upgrade.post(input)),
    lookupContact: (email) => unwrap(api().contacts.lookup.post({ email })),
    settings: () => unwrap(api().settings.get()),
    saveSettings: (input) => unwrap(api().settings.put(input)),
};
