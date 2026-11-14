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
    bytes32Schema,
    clientMethodsSchema,
    describeFailure,
    deviceRemovalSchema,
    emailSchema,
    envelopeSchema,
    hybridSignatureSchema,
    identitySchema,
    keyRegistrationSchema,
    notifyDevices,
    opaqueMessage,
    recoverySchema,
    requestAddress,
    requestContext,
    securityActionSchema,
    settingsKeySchema,
    signatureSchema,
    stepAnswerSchema,
    tokenSchema,
    twoStepChangeSchema,
    uuidSchema,
    workspaceKeySchema,
    workspaceSetupSchema,
} from '@/lib/api/shared.server';
import {
    approvalApprovedResponse,
    approvalEndedResponse,
    approvalOpenedResponse,
    approvalRevealedResponse,
    approvalStartedResponse,
    approvalStatusResponse,
    approvalsResponse,
    deviceConfirmedResponse,
    deviceEnrolmentResponse,
    accountSetupResponse,
    authUserResponse,
    backupCodesResponse,
    consentStoredResponse,
    contactResponse,
    contactSuccessionResponse,
    defaultKindResponse,
    deviceResponse,
    devicesRemovedResponse,
    devicesResponse,
    emailSentResponse,
    enrollmentResponse,
    forgottenResponse,
    identityHistoryResponse,
    identityResponse,
    keyAddedResponse,
    keyOptionsResponse,
    loginChallengeResponse,
    loginFinishResponse,
    loginResponse,
    loginStartResponse,
    methodRemovedResponse,
    methodResponse,
    profileResponse,
    recoveryBackupResponse,
    recoveryChallengeResponse,
    registrationChallengeResponse,
    securityChallengeResponse,
    securityEventsResponse,
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
    totpEnrolmentResponse,
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
            response: { 200: loginStartResponse },
        },
        async ({ body, request }) => ({
            ...(await auth.startLogin(
                body.email,
                body.startLoginRequest,
                undefined,
                requestAddress(request),
            )),
            // This server reads `twoStepMethods`. Said to everyone, for any address, known or not.
            twoStepMethods: true as const,
        }),
    )
    .post(
        '/auth/login/finish',
        {
            body: t.Object({
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                // A device key's proof for this attempt (docs/devices-design.md, step 1).
                device: t.Optional(t.Object({ id: uuidSchema, signature: signatureSchema })),
                // Sent by a client that can answer a second step (docs/two-step-design.md 4).
                twoStep: t.Optional(t.Literal(1)),
                // What else it can answer with: a passkey, another device (12).
                twoStepMethods: t.Optional(clientMethodsSchema),
            }),
            response: { 200: loginFinishResponse },
        },
        async ({ sessionToken, body, set, log }) => {
            const result = await auth.finishLogin(
                body.attemptToken,
                body.finishLoginRequest,
                sessionToken,
                body.device,
                { twoStep: body.twoStep === 1, twoStepMethods: body.twoStepMethods ?? null },
            );
            // The account asks for a second step: no session yet, so no cookie and no envelope.
            if (result.twoStep) return { twoStep: result.twoStep };
            const { user, envelope, device, newDevice, sessionToken: token } = result;
            set.headers['set-cookie'] = authCookie('session', token);
            // A device that came in with the password alone: the account's email hears of it.
            if (newDevice) notifyDevices(log, user.id, 'new-device');
            return { user, envelope, device };
        },
    )
    // The second step of a sign-in: on a right answer, exactly what /auth/login/finish answers.
    .post(
        '/auth/login/two-step',
        { body: stepAnswerSchema, response: { 200: loginResponse } },
        async ({ body, set, log }) => {
            const {
                user,
                envelope,
                device,
                newDevice,
                signedInWith,
                sessionToken: token,
            } = await auth.finishLoginStep(body);
            set.headers['set-cookie'] = authCookie('session', token);
            if (newDevice) notifyDevices(log, user.id, 'new-device', undefined, signedInWith);
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
                // The second step, for an account that has it on (docs/two-step-design.md 4).
                twoStep: t.Optional(stepAnswerSchema),
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
                // The second step, for an account that has it on (docs/two-step-design.md 4).
                twoStep: t.Optional(stepAnswerSchema),
                // Sent by a client that will take a session for this device with the change,
                // when the change passes the step. Without it nothing is minted.
                keepSession: t.Optional(t.Literal(1)),
            }),
            response: { 200: successResponse },
        },
        async ({ sessionToken, body, set }) => {
            const { keepSession, ...change } = body;
            const { sessionToken: kept, ...result } = await auth.finishSecurityChange(
                sessionToken,
                { ...change, keepSession: keepSession === 1 },
            );
            set.headers['set-cookie'] = [
                authCookie('session', kept),
                authCookie('enrollment', null),
            ];
            return result;
        },
    )
    // Two-step sign-in (docs/two-step-design.md). Setting it up and managing it answer 501 while
    // TWO_STEP_ENABLED is off; an account that already has the step is asked for it regardless.
    .get(
        '/auth/two-step',
        {
            // The kinds of method this client knows, comma-separated (12). Without it the
            // reply is the one a client from before passkeys expects.
            query: t.Object({
                methods: t.Optional(t.String({ maxLength: 200, pattern: '^[a-z0-9,-]*$' })),
            }),
            response: { 200: twoStepResponse },
        },
        ({ sessionToken, set, query }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.getTwoStep(
                sessionToken,
                query.methods === undefined ? null : query.methods.split(',').filter(Boolean),
            );
        },
    )
    // Changing the step asks for the password again: the first half of that OPAQUE exchange.
    .post(
        '/auth/two-step/reauth',
        {
            body: t.Object({ startLoginRequest: opaqueMessage }),
            response: { 200: loginChallengeResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startTwoStepReauth(sessionToken, body.startLoginRequest);
        },
    )
    // A step token for this session and one purpose; the action's own request carries the answer.
    .post(
        '/auth/two-step/challenge',
        {
            body: t.Object({
                purpose: t.Union([
                    t.Literal('password'),
                    t.Literal('master-key'),
                    t.Literal('recovery-key'),
                    t.Literal('delete'),
                    t.Literal('two-step'),
                ]),
                twoStepMethods: t.Optional(clientMethodsSchema),
            }),
            response: { 200: stepChallengeResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startStepChallenge(sessionToken, body.purpose, body.twoStepMethods ?? null);
        },
    )
    .post(
        '/auth/two-step/totp',
        { body: twoStepChangeSchema, response: { 200: totpEnrolmentResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startTotpEnrolment(sessionToken, body);
        },
    )
    .post(
        '/auth/two-step/totp/:id/confirm',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ code: t.String({ minLength: 6, maxLength: 16 }) }),
            response: { 200: totpConfirmedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.confirmTotpEnrolment(sessionToken, params.id, body.code);
        },
    )
    // A passkey or security key: the password again (and the step, once it is on), then the
    // key's own answer to the options that come back.
    .post(
        '/auth/two-step/keys/options',
        { body: twoStepChangeSchema, response: { 200: keyOptionsResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startKeyEnrolment(sessionToken, body);
        },
    )
    .post(
        '/auth/two-step/keys',
        {
            body: t.Object({
                registrationToken: tokenSchema,
                name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
                response: keyRegistrationSchema,
            }),
            response: { 200: keyAddedResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.finishKeyEnrolment(sessionToken, body);
        },
    )
    // Which kind of method is offered first. Only an order, so no password; the session must
    // have passed the step itself.
    .put(
        '/auth/two-step/default',
        {
            body: t.Object({
                kind: t.Union([t.Literal('webauthn'), t.Literal('totp'), t.Literal('device')]),
            }),
            response: { 200: defaultKindResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.setTwoStepDefault(sessionToken, body.kind);
        },
    )
    .put(
        '/auth/two-step/methods/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }),
            response: { 200: methodResponse },
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
            response: { 200: methodRemovedResponse },
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
            return auth.makeBackupCodes(sessionToken, body);
        },
    )
    // Approve on another device (docs/two-step-design.md 12). Turning it on: the password
    // again (and the step, once it is on), then one real approval from another device.
    .post(
        '/auth/two-step/device',
        { body: twoStepChangeSchema, response: { 200: deviceEnrolmentResponse } },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startDeviceEnrolment(sessionToken, body);
        },
    )
    .post(
        '/auth/two-step/device/:id/confirm',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ token: tokenSchema, requestId: uuidSchema }),
            response: { 200: deviceConfirmedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.confirmDeviceEnrolment(sessionToken, params.id, body);
        },
    )
    // The request itself. The device asking holds a step token and no session (a sign-in) or
    // both (a change): the token is its bearer, in the body, or in a header where it only reads.
    .post(
        '/auth/approvals',
        {
            body: t.Object({
                stepToken: tokenSchema,
                commitment: bytes32Schema,
                // What the device calls itself, for one the server does not know yet.
                kind: t.Optional(
                    t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
                ),
                name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            }),
            response: { 200: approvalStartedResponse },
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            // The request's own headers: a rough place, where the operator's proxy names one.
            return auth.startDeviceApproval(sessionToken, body, request.headers);
        },
    )
    .get('/auth/approvals', { response: { 200: approvalsResponse } }, ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.listDeviceApprovals(sessionToken);
    })
    .get(
        '/auth/approvals/:id',
        { params: t.Object({ id: uuidSchema }), response: { 200: approvalStatusResponse } },
        ({ request, sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.getDeviceApproval(
                sessionToken,
                request.headers.get('x-step-token'),
                params.id,
            );
        },
    )
    .post(
        '/auth/approvals/:id/reveal',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                stepToken: tokenSchema,
                deviceSigningKey: bytes32Schema,
                nonce: bytes32Schema,
            }),
            response: { 200: approvalRevealedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.revealDeviceApproval(sessionToken, params.id, body);
        },
    )
    // The approving device, from its own session.
    .post(
        '/auth/approvals/:id/open',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ ephemeralKey: bytes32Schema }),
            response: { 200: approvalOpenedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.openDeviceApproval(sessionToken, params.id, body);
        },
    )
    .post(
        '/auth/approvals/:id/approve',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ signature: signatureSchema }),
            response: { 200: approvalApprovedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.approveDeviceApproval(sessionToken, params.id, body);
        },
    )
    .post(
        '/auth/approvals/:id/deny',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                reason: t.Union([
                    t.Literal('denied'),
                    t.Literal('wrong-code'),
                    t.Literal('not-me'),
                    t.Literal('mismatch'),
                ]),
            }),
            response: { 200: approvalEndedResponse },
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.denyDeviceApproval(sessionToken, params.id, body);
        },
    )
    .get(
        '/auth/security-events',
        { response: { 200: securityEventsResponse } },
        ({ sessionToken, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.listSecurityEvents(sessionToken);
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
