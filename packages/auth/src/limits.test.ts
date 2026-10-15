import { createIdentity } from '@hushos/crypto/identity';
import { describe, expect, test } from 'vitest';
import { SECURITY_CHANGE_IDENTITY_BYTES } from './limits';

/*
 * The body a master-key rotation may send is sized from the account's identity
 * count. An identity that outgrew its allowance, say through a new field,
 * would make the rotation fail with "Request is too large" for every account.
 */
describe('the security change allowance', () => {
    test('holds a version 2 identity as it is sent', async () => {
        const identity = await createIdentity(
            crypto.getRandomValues(new Uint8Array(32)),
            '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
        );
        const sent = new TextEncoder().encode(JSON.stringify(identity)).byteLength;
        expect(sent).toBeLessThanOrEqual(SECURITY_CHANGE_IDENTITY_BYTES);
    });
});
