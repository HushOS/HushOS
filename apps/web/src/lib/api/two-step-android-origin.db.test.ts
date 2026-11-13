import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { softKey } from '../../../../../packages/auth/test/soft-key';
import { loadEdge, type Edge } from '@/test/auth-edge.server';

/*
 * The Android app's origin, with no setting of its own (docs/two-step-design.md 8): a server
 * that names an app's certificate in ANDROID_APP_CERT_SHA256, and so vouches for it in
 * `assetlinks.json`, takes that app's passkey answers without WEBAUTHN_ANDROID_ORIGINS being
 * set. The defect this guards against is the one a person would meet: Android hands the app
 * the site's passkey, the app answers, and the server refuses its own app's origin.
 *
 * The fingerprint is SHA-256 of the empty string as keytool prints one, and the origin the
 * same 32 bytes in Base64url: a pair known apart from the code that derives it.
 */
const FINGERPRINT =
    'E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55';
const APP = 'android:apk-key-hash:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
const OTHER_APP = 'android:apk-key-hash:_-7d3Nva2djX1tXU09LR0M_OzczLysrJyMfGxcTDwsE';

let edge: Edge;
beforeAll(async () => {
    edge = await loadEdge({
        TWO_STEP_ENABLED: 'true',
        WEBAUTHN_ANDROID_ORIGINS: '',
        ANDROID_APP_CERT_SHA256: FINGERPRINT,
    });
});
beforeEach(async () => {
    await edge.resetDatabase();
    edge.outbox.length = 0;
});
afterAll(() => edge.closeDatabase());

describe('an Android app whose certificate the server vouches for', () => {
    test('adds a key and answers the step from its own origin, and another app does neither', async () => {
        const who = await edge.account();
        const cookie = (await edge.signIn(who)).session!;
        const options = async () => {
            const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
            return (await edge.call('POST', '/two-step/keys/options', proof, { cookie })).body;
        };
        const add = (
            started: { registrationToken: string; options: { challenge: string } },
            origin: string,
        ) =>
            edge.call(
                'POST',
                '/two-step/keys',
                {
                    registrationToken: started.registrationToken,
                    response: key.register(started.options, { origin }),
                },
                { cookie },
            );
        const key = softKey();
        // An app this server does not name adds nothing, whatever its answer says.
        expect((await add(await options(), OTHER_APP)).status).toBe(400);
        // The app it names registers from its own origin, as Credential Manager reports it.
        expect((await add(await options(), APP)).status).toBe(200);

        const step = async () =>
            (await edge.signIn(who, { twoStep: true, methods: ['webauthn'] })).body.twoStep;
        const answer = async (origin: string) => {
            const asked = await step();
            return edge.call('POST', '/login/two-step', {
                token: asked.token,
                proof: { kind: 'webauthn', response: key.assert(asked.webauthn, { origin }) },
            });
        };
        const refused = await answer(OTHER_APP);
        expect(refused.status).toBe(401);
        expect(refused.session).toBeUndefined();
        const signedIn = await answer(APP);
        expect(signedIn.status).toBe(200);
        expect(signedIn.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
});
