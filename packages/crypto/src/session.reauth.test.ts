import { client, ready, server } from '@serenity-kit/opaque';
import { describe, expect, test } from 'vitest';
import { createDeviceKey, rememberAccountKey } from './device';
import { RefusedError } from './errors';
import { KEY_STRETCHING, OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from './protocol';
import { createCryptoSession } from './session';
import { createWorkspaceGrant } from './workspace';

/*
 * Proving the password again while unlocked (removing a device,
 * docs/devices-design.md): the worker's own OPAQUE exchange must leave the open
 * account open, give the server a finish it accepts for the right password, and
 * refuse a wrong one in a way that keeps the session (a refusal, never the
 * failure that resets the worker and locks the browser).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'correct horse battery staple';

async function setup() {
    await ready;
    const serverSetup = server.createSetup();
    const registration = client.startRegistration({ password: PASSWORD });
    const { registrationResponse } = server.createRegistrationResponse({
        serverSetup,
        userIdentifier: USER,
        registrationRequest: registration.registrationRequest,
    });
    const { registrationRecord } = client.finishRegistration({
        password: PASSWORD,
        clientRegistrationState: registration.clientRegistrationState,
        registrationResponse,
        identifiers: OPAQUE_IDENTIFIERS,
        keyStretching: KEY_STRETCHING,
    });
    const root = crypto.getRandomValues(new Uint8Array(32));
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId: USER,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: 'device',
    });
    const session = createCryptoSession();
    let id = 0;
    const call = (operation: string, input: unknown) =>
        session.handle({ id: ++id, operation, input } as Parameters<typeof session.handle>[0]);
    await call('restore', { deviceKey, bundle });
    const grant = await createWorkspaceGrant(root, USER, WS, 1);
    /* Whether the account is still open: only an unlocked root opens a workspace grant. */
    const stillOpen = () =>
        call('driveOpenWorkspace', { userId: USER, grant }).then(
            () => true,
            () => false,
        );
    /* One exchange against the server; the finish the server accepts, or the refusal. */
    async function reauth(password: string) {
        const start = (await call('reauthStart', { password })) as { startLoginRequest: string };
        const { loginResponse, serverLoginState } = server.startLogin({
            serverSetup,
            userIdentifier: USER,
            registrationRecord,
            startLoginRequest: start.startLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        const finish = (await call('reauthFinish', {
            loginResponse,
            profileVersion: OPAQUE_PROFILE_VERSION,
        })) as { finishLoginRequest: string };
        server.finishLogin({
            serverLoginState,
            finishLoginRequest: finish.finishLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        return finish;
    }
    return { reauth, stillOpen, call };
}

describe('proving the password again while unlocked', () => {
    test('the right password gives a finish the server accepts, and the account stays open', async () => {
        const { reauth, stillOpen } = await setup();
        expect(await stillOpen()).toBe(true);
        await expect(reauth(PASSWORD)).resolves.toHaveProperty('finishLoginRequest');
        expect(await stillOpen()).toBe(true);
    });

    test('a wrong password is a refusal that keeps the account open, and the next try works', async () => {
        const { reauth, stillOpen } = await setup();
        const wrong = await reauth('not the password at all').catch((error: unknown) => error);
        // The worker resets on any failure but a refusal; a reset would lock the browser.
        expect(wrong).toBeInstanceOf(RefusedError);
        expect(await stillOpen()).toBe(true);
        await expect(reauth(PASSWORD)).resolves.toHaveProperty('finishLoginRequest');
    });

    test('a finish without a start is refused, not answered with stale state', async () => {
        const { call } = await setup();
        await expect(
            call('reauthFinish', { loginResponse: 'x', profileVersion: OPAQUE_PROFILE_VERSION }),
        ).rejects.toBeInstanceOf(RefusedError);
    });

    test('a cancelled exchange keeps nothing: its finish is refused', async () => {
        const { call } = await setup();
        await call('reauthStart', { password: PASSWORD });
        await call('reauthCancel', {});
        await expect(
            call('reauthFinish', { loginResponse: 'x', profileVersion: OPAQUE_PROFILE_VERSION }),
        ).rejects.toBeInstanceOf(RefusedError);
    });
});
