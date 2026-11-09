import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as auth from '@hushos/auth/server';
import { authCookie, guardAuthMutation } from '@hushos/auth/http';
import * as billing from '@hushos/billing/server';
import * as growth from '@hushos/billing/growth';
import { authRepository, growthRepository } from '@hushos/db';
import { intentSchema } from '@/lib/signup-intent';
import { useLogger } from '@/lib/logging.server';
import {
    describeFailure,
    deviceRemovalSchema,
    emailSchema,
    envelopeSchema,
    hybridSignatureSchema,
    identitySchema,
    notifyDevices,
    opaqueMessage,
    recoverySchema,
    requestAddress,
    requestContext,
    securityActionSchema,
    settingsKeySchema,
    signatureSchema,
    stepSchema,
    tokenSchema,
    twoStepChangeSchema,
    uuidSchema,
    workspaceKeySchema,
    workspaceSetupSchema,
} from '@/lib/api/shared.server';
import {
    accountSetupResponse,
    authUserResponse,
    backupCodesResponse,
    consentStoredResponse,
    contactResponse,
    contactSuccessionResponse,
    deviceResponse,
    devicesRemovedResponse,
    devicesResponse,
    emailSentResponse,
    enrollmentResponse,
    forgottenResponse,
    identityHistoryResponse,
    identityResponse,
    loginChallengeResponse,
    loginOrStepResponse,
    loginResponse,
    profileResponse,
    recoveryBackupResponse,
    recoveryChallengeResponse,
    registrationChallengeResponse,
    securityChallengeResponse,
    sessionResponse,
    settingsKeyStoredResponse,
    settingsResponse,
    settingsSavedResponse,
    setupResponse,
    stepChallengeResponse,
    storageResponse,
    successionResponse,
    successResponse,
    totpConfirmedResponse,
    totpSetupResponse,
    twoStepMethodRemovedResponse,
    twoStepMethodResponse,
    twoStepResponse,
    verifiedEnrollmentResponse,
} from '@/lib/api/auth-responses.server';

/* Accounts: registration, sign-in, recovery, devices, identity, contacts and settings (/api/auth). */
export const authApi = new Elysia()
    .use(requestContext)
    .get('/auth/setup', { response: { 200: accountSetupResponse } }, ({ sessionToken }) =>
        auth.getAccountSetup(sessionToken),
    )
    .post(
        '/auth/setup',
        {
            body: t.Object({
                recovery: t.Optional(recoverySchema),
                identity: t.Optional(identitySchema),
                workspace: t.Optional(workspaceSetupSchema),
            }),
            response: { 200: setupResponse },
        },
        ({ sessionToken, body }) => auth.initializeAccount(sessionToken, body),
    )
    .post(
        '/auth/register/email',
        {
            body: t.Object({
                email: emailSchema,
                intent: t.Optional(intentSchema),
                // The phone apps' own sign-up: its link carries ?app=1, which only the apps open.
                app: t.Optional(t.Boolean()),
            }),
            response: { 200: emailSentResponse },
        },
        ({ body, request }) =>
            auth.requestRegistrationEmail(
                body.email,
                'register',
                requestAddress(request),
                body.intent,
                { app: body.app },
            ),
    )
    .post(
        '/auth/register/verify',
        { body: t.Object({ token: tokenSchema }), response: { 200: verifiedEnrollmentResponse } },
        async ({ body, set }) => {
            const { enrollment, enrollmentToken } = await auth.verifyEmail(body.token);
            set.headers['set-cookie'] = authCookie('enrollment', enrollmentToken);
            return { enrollment };
        },
    )
    .get(
        '/auth/register',
        { response: { 200: enrollmentResponse } },
        async ({ enrollmentToken }) => ({
            enrollment: await auth.getEnrollment(enrollmentToken),
        }),
    )
    .post(
        '/auth/register/start',
        {
            body: t.Object({ registrationRequest: opaqueMessage }),
            response: { 200: registrationChallengeResponse },
        },
        ({ enrollmentToken, body }) =>
            auth.startRegistration(enrollmentToken, body.registrationRequest),
    )
    .post(
        '/auth/register/finish',
        {
            body: t.Object({
                name: t.String({ minLength: 1, maxLength: 200 }),
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: recoverySchema,
                identity: identitySchema,
                workspace: workspaceSetupSchema,
            }),
            response: { 200: authUserResponse },
        },
        async ({ enrollmentToken, body, set }) => {
            const { user } = await auth.finishRegistration(enrollmentToken, body);
            set.headers['set-cookie'] = authCookie('enrollment', null);
            // The code the person signed up with, if any: attribution and its storage, never a failed sign-up.
            try {
                await growth.attributeNewAccount(
                    user.id,
                    (await growthRepository.pendingReferralCode(user.id)) ?? undefined,
                );
            } catch (error) {
                useLogger().set({ growth: { failure: describeFailure(error) } });
                useLogger().error(new Error('Referral attribution failed.'));
            }
            return { user };
        },
    )
    .post(
        '/auth/login/start',
        {
            body: t.Object({ email: emailSchema, startLoginRequest: opaqueMessage }),
            response: { 200: loginChallengeResponse },
        },
        ({ body, request }) =>
            auth.startLogin(body.email, body.startLoginRequest, undefined, requestAddress(request)),
    )
    .post(
        '/auth/login/finish',
        {
            body: t.Object({
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                // A device key's proof for this attempt (docs/devices-design.md, step 1).
                device: t.Optional(t.Object({ id: uuidSchema, signature: signatureSchema })),
                // Sent by every client that can answer a second step (docs/two-step-design.md 4).
                twoStep: t.Optional(t.Literal(1)),
            }),
            response: { 200: loginOrStepResponse },
        },
        async ({ sessionToken, body, set, log }) => {
            const result = await auth.finishLogin(
                body.attemptToken,
                body.finishLoginRequest,
                sessionToken,
                body.device,
                { twoStep: body.twoStep === 1 },
            );
            // The account asks for a second step: no session, no cookie, no envelope.
            if ('twoStep' in result) return { twoStep: result.twoStep };
            const { user, envelope, device, newDevice, sessionToken: token } = result;
            set.headers['set-cookie'] = authCookie('session', token);
            // A device that came in with the password alone: the account's email hears of it.
            if (newDevice) notifyDevices(log, user.id, 'new-device');
            return { user, envelope, device };
        },
    )
    // The second step of a sign-in: the token /auth/login/finish gave, and an answer to it.
    .post(
        '/auth/login/two-step',
        { body: stepSchema, response: { 200: loginResponse } },
        async ({ body, set, log }) => {
            const {
                user,
                envelope,
                device,
                newDevice,
                method,
                sessionToken: token,
            } = await auth.finishTwoStepLogin(body);
            set.headers['set-cookie'] = authCookie('session', token);
            // A new device: the notice names the password and what answered the step.
            if (newDevice) notifyDevices(log, user.id, 'new-device', undefined, method);
            return { user, envelope, device };
        },
    )
    .post(
        '/auth/recover/email',
        { body: t.Object({ email: emailSchema }), response: { 200: emailSentResponse } },
        ({ body, request }) =>
            auth.requestRegistrationEmail(body.email, 'recover', requestAddress(request)),
    )
    .get(
        '/auth/recover',
        { response: { 200: enrollmentResponse } },
        async ({ enrollmentToken }) => ({
            enrollment: await auth.getEnrollment(enrollmentToken, 'recover'),
        }),
    )
    .post(
        '/auth/recover/start',
        {
            body: t.Object({ registrationRequest: opaqueMessage }),
            response: { 200: recoveryChallengeResponse },
        },
        ({ enrollmentToken, body }) =>
            auth.startRecovery(enrollmentToken, body.registrationRequest),
    )
    .post(
        '/auth/recover/finish',
        {
            body: t.Object({
                userId: t.String({ format: 'uuid' }),
                attemptToken: tokenSchema,
                credentialVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: recoverySchema,
                signature: t.String({ minLength: 86, maxLength: 86 }),
            }),
            response: { 200: authUserResponse },
        },
        async ({ enrollmentToken, body, set }) => {
            const { user } = await auth.finishRecovery(enrollmentToken, body);
            set.headers['set-cookie'] = [
                authCookie('enrollment', null),
                authCookie('session', null),
            ];
            return { user };
        },
    )
    .post(
        '/auth/delete/start',
        {
            body: t.Object({ startLoginRequest: opaqueMessage }),
            response: { 200: loginChallengeResponse },
        },
        ({ sessionToken, body }) => auth.startAccountDeletion(sessionToken, body.startLoginRequest),
    )
    .post(
        '/auth/delete/finish',
        {
            body: t.Object({
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                // The second step, for an account that has one (403 `two-step` without it).
                twoStep: t.Optional(stepSchema),
            }),
            response: { 200: successResponse },
        },
        async ({ sessionToken, body, set }) => {
            const result = await auth.finishAccountDeletion(sessionToken, body, async (userId) => {
                try {
                    await billing.revokeForDeletion(userId);
                } catch (error) {
                    // A family's payer is refused with a sentence that says what to do; the
                    // auth routes answer only AuthError with its message.
                    if (error instanceof billing.BillingError && error.status === 409)
                        throw new auth.AuthError(error.message, 409, { cause: error });
                    throw error;
                }
            });
            set.headers['set-cookie'] = [
                authCookie('session', null),
                authCookie('enrollment', null),
            ];
            return result;
        },
    )
    .post(
        '/auth/security/start',
        {
            body: t.Object({
                action: securityActionSchema,
                startLoginRequest: opaqueMessage,
                registrationRequest: opaqueMessage,
            }),
            response: { 200: securityChallengeResponse },
        },
        ({ sessionToken, body }) => auth.startSecurityChange(sessionToken, body),
    )
    .post(
        '/auth/security/finish',
        {
            body: t.Object({
                action: securityActionSchema,
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: t.Optional(recoverySchema),
                identity: t.Optional(identitySchema),
                // Every earlier identity, re-wrapped under the new root by a master-key rotation.
                identityHistory: t.Optional(
                    t.Array(identitySchema, { maxItems: authRepository.IDENTITY_HISTORY_LIMIT }),
                ),
                settingsKey: t.Optional(settingsKeySchema),
                workspaces: t.Optional(t.Array(workspaceKeySchema, { maxItems: 200 })),
                // The second step, for an account that has one (403 `two-step` without it).
                twoStep: t.Optional(stepSchema),
            }),
            response: { 200: successResponse },
        },
        async ({ sessionToken, body, set }) => {
            const result = await auth.finishSecurityChange(sessionToken, body);
            set.headers['set-cookie'] = [
                authCookie('session', null),
                authCookie('enrollment', null),
            ];
            return result;
        },
    )
    .get('/auth/storage', { response: { 200: storageResponse } }, ({ sessionToken }) =>
        auth.getStorageAllowance(sessionToken),
    )
    .get('/auth/recovery-key', { response: { 200: recoveryBackupResponse } }, ({ sessionToken }) =>
        auth.getRecoveryBackup(sessionToken),
    )
    .post(
        '/auth/recovery-key/confirm',
        {
            body: t.Object({ recoveryVersion: t.Integer({ minimum: 1, maximum: 2147483646 }) }),
            response: { 200: successResponse },
        },
        ({ sessionToken, body }) => auth.confirmRecoveryBackup(sessionToken, body.recoveryVersion),
    )
    .get('/auth/identity', { response: { 200: identityResponse } }, ({ sessionToken }) =>
        auth.getIdentityEnvelope(sessionToken),
    )
    // The upgrade to a version 2 identity: the same keys, plus ML-DSA and the keys statement.
    .post(
        '/auth/identity/upgrade',
        { body: t.Object({ identity: identitySchema }), response: { 200: identityResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.upgradeIdentity(sessionToken, body);
        },
    )
    // Identity succession: new keys at the next version, signed by the current identity's hybrid signature.
    .post(
        '/auth/identity/succession',
        {
            body: t.Object({
                identity: identitySchema,
                signature: hybridSignatureSchema,
                // The successor's consent: two hybrid signatures, 6746 bytes.
                consent: t.Optional(
                    t.String({ minLength: 8995, maxLength: 8995, pattern: '^[A-Za-z0-9_-]+$' }),
                ),
            }),
            response: { 200: successionResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.succeedIdentity(sessionToken, body);
        },
    )
    // Consent for an earlier succession that was made without it: stored only where none is.
    .post(
        '/auth/identity/succession/consent',
        {
            body: t.Object({
                oldKeyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
                consent: t.String({
                    minLength: 8995,
                    maxLength: 8995,
                    pattern: '^[A-Za-z0-9_-]+$',
                }),
            }),
            response: { 200: consentStoredResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.backfillSuccessionConsent(sessionToken, body);
        },
    )
    .get(
        '/auth/identity/history',
        { response: { 200: identityHistoryResponse } },
        ({ sessionToken, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.getIdentityHistory(sessionToken);
        },
    )
    .get(
        '/auth/contacts/:userId/succession',
        {
            params: t.Object({ userId: uuidSchema }),
            query: t.Object({ from: t.Numeric({ minimum: 1, maximum: 2147483646 }) }),
            response: { 200: contactSuccessionResponse },
        },
        ({ request, sessionToken, params, query }) =>
            auth.contactSuccession(
                sessionToken,
                params.userId,
                query.from,
                requestAddress(request),
            ),
    )
    // A POST so the address is in the body: a query string sits in proxy and access logs.
    .post(
        '/auth/contacts/lookup',
        { body: t.Object({ email: emailSchema }), response: { 200: contactResponse } },
        ({ request, sessionToken, body }) =>
            auth.lookupContact(sessionToken, body.email, requestAddress(request)),
    )
    .get('/auth/settings', { response: { 200: settingsResponse } }, ({ sessionToken }) =>
        auth.getSettings(sessionToken),
    )
    .put(
        '/auth/settings-key',
        { body: settingsKeySchema, response: { 200: settingsKeyStoredResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.putSettingsKey(sessionToken, body);
        },
    )
    .put(
        '/auth/settings',
        {
            body: t.Object({
                expectedVersion: t.Integer({ minimum: 0, maximum: 2147483646 }),
                // 2 is sealed under the settings key and the only version taken; anything
                // else (1, from a client that predates it) is refused with 409, not a bare 400.
                version: t.Optional(t.Integer({ minimum: 1, maximum: 255 })),
                nonce: t.String({ minLength: 32, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
                ciphertext: t.String({
                    minLength: 22,
                    maxLength: 87_408,
                    pattern: '^[A-Za-z0-9_-]+$',
                }),
            }),
            response: { 200: settingsSavedResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.putSettings(sessionToken, body);
        },
    )
    // A removed device keeps hearing `removed` until it has cleared what it kept and acknowledges
    // it (POST /auth/session/forget): a wipe cut short is tried again on the next check.
    .get('/auth/session', { response: { 200: sessionResponse } }, ({ sessionToken }) =>
        auth.sessionState(sessionToken),
    )
    // The acknowledgement after that wipe: the cookie goes only if it is still the removed one.
    .post(
        '/auth/session/forget',
        { body: t.Object({}), response: { 200: forgottenResponse } },
        async ({ request, sessionToken, set }) => {
            guardAuthMutation(request);
            const forgotten = await auth.mayForgetSession(sessionToken);
            if (forgotten) set.headers['set-cookie'] = authCookie('session', null);
            return { forgotten };
        },
    )
    .get('/auth/devices', { response: { 200: devicesResponse } }, ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.listDevices(sessionToken);
    })
    .post(
        '/auth/devices',
        {
            body: t.Object({
                kind: t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
                name: t.String({ minLength: 1, maxLength: 200 }),
                signingPublicKey: t.Optional(
                    t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
                ),
            }),
            response: { 200: deviceResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.registerDevice(sessionToken, body);
        },
    )
    // Removing devices asks for the password again: the first half of that OPAQUE exchange.
    .post(
        '/auth/devices/reauth',
        {
            body: t.Object({ startLoginRequest: opaqueMessage }),
            response: { 200: loginChallengeResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startDeviceRemoval(sessionToken, body.startLoginRequest);
        },
    )
    // Static beside the parameter: Elysia prefers it, and the id's pattern refuses "others" anyway.
    .delete(
        '/auth/devices/others',
        { body: deviceRemovalSchema, response: { 200: devicesRemovedResponse } },
        async ({ request, sessionToken, body, log }) => {
            guardAuthMutation(request);
            const { userId, removed } = await auth.removeOtherDevices(sessionToken, body);
            if (removed > 0) notifyDevices(log, userId, 'devices-removed', removed);
            return { removed };
        },
    )
    .put(
        '/auth/devices/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }),
            response: { 200: deviceResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.renameDevice(sessionToken, params.id, body);
        },
    )
    .delete(
        '/auth/devices/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: deviceRemovalSchema,
            response: { 200: devicesRemovedResponse },
        },
        async ({ request, sessionToken, params, body, log }) => {
            guardAuthMutation(request);
            const { userId, removed } = await auth.removeDevice(sessionToken, params.id, body);
            notifyDevices(log, userId, 'device-removed');
            return { removed };
        },
    )
    /*
     * Two-step sign-in (docs/two-step-design.md 10). The routes that set it up or change it
     * answer 501 while TWO_STEP_ENABLED is off; the challenge does not, since an account that has
     * a second step is held to it at every change it guards.
     */
    .get('/auth/two-step', { response: { 200: twoStepResponse } }, ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.getTwoStep(sessionToken);
    })
    // Changing the second step asks for the password again: the first half of that exchange.
    .post(
        '/auth/two-step/reauth',
        {
            body: t.Object({ startLoginRequest: opaqueMessage }),
            response: { 200: loginChallengeResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startTwoStepChange(sessionToken, body.startLoginRequest);
        },
    )
    // A step token for one change, bound to this session and that purpose.
    .post(
        '/auth/two-step/challenge',
        {
            body: t.Object({ purpose: t.UnionEnum(auth.STEP_CHALLENGE_PURPOSES) }),
            response: { 200: stepChallengeResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.challengeTwoStep(sessionToken, body.purpose);
        },
    )
    .post(
        '/auth/two-step/totp',
        { body: twoStepChangeSchema, response: { 200: totpSetupResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startTotp(sessionToken, body);
        },
    )
    .post(
        '/auth/two-step/totp/:id/confirm',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                code: t.String({ minLength: 1, maxLength: 32 }),
                // Honoured only when this confirmation turns the step on: the account's other
                // devices, whose sessions never passed the step, are removed with it.
                signOutOthers: t.Optional(t.Boolean()),
            }),
            response: { 200: totpConfirmedResponse },
        },
        async ({ request, sessionToken, params, body, log }) => {
            guardAuthMutation(request);
            const { userId, removed, backupCodes } = await auth.confirmTotp(
                sessionToken,
                params.id,
                body,
            );
            // As removing every other device says it, whichever screen asked.
            if (removed > 0) notifyDevices(log, userId, 'devices-removed', removed);
            return backupCodes ? { backupCodes } : {};
        },
    )
    .put(
        '/auth/two-step/methods/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }),
            response: { 200: twoStepMethodResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.renameTwoStepMethod(sessionToken, params.id, body);
        },
    )
    .delete(
        '/auth/two-step/methods/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: twoStepChangeSchema,
            response: { 200: twoStepMethodRemovedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.removeTwoStepMethod(sessionToken, params.id, body);
        },
    )
    .post(
        '/auth/two-step/backup-codes',
        { body: twoStepChangeSchema, response: { 200: backupCodesResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.replaceBackupCodes(sessionToken, body);
        },
    )
    .post(
        '/auth/profile',
        {
            body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }),
            response: { 200: profileResponse },
        },
        ({ sessionToken, body }) => auth.updateProfile(sessionToken, body),
    )
    .post(
        '/auth/logout',
        { body: t.Object({}), response: { 200: successResponse } },
        async ({ sessionToken, set }) => {
            await auth.logout(sessionToken);
            set.headers['set-cookie'] = authCookie('session', null);
            return { success: true };
        },
    );
