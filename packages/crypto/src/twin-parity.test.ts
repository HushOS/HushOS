import { describe, expect, it } from 'vitest';
import { deviceSessionStatement } from './device-identity';
import { CryptoError } from './errors';
import { publicIdentity, type IdentityEnvelope } from './identity';
import { decode } from './keys';
import { shareStatement } from './signatures';
import core from './__fixtures__/core.json';

/*
 * Inputs the two twins once judged apart, found by feeding both the same
 * bytes (differential fuzzing, 2026-10-17). Each case pins this twin to what
 * crates/hushos-core does, and refuses with a CryptoError: callers take only
 * a CryptoError as a refusal and treat anything else as a broken session.
 */

describe('what both twins refuse', () => {
    it('reads the public keys of a version 2 envelope only when it has every half', () => {
        const envelope = core.identity.envelope as IdentityEnvelope;
        for (const missing of ['kem', 'mlDsa', 'keysSignature'] as const)
            for (const as of [null, undefined])
                expect(() =>
                    publicIdentity({ ...envelope, [missing]: as } as IdentityEnvelope),
                ).toThrow(CryptoError);
        expect(publicIdentity(envelope).keysSignature).toBe(envelope.keysSignature);
    });

    it('refuses base64url of a length 1 mod 4 with a CryptoError, not the DOMException atob throws', () => {
        for (const text of ['A', 'AAAAA', 'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8Il'])
            expect(() => decode(text)).toThrow(CryptoError);
        expect(decode('Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8', 32)).toHaveLength(32);
    });

    it('stops share epochs at 2^53 - 1, where the Rust core now stops them too', async () => {
        const at = (keyEpoch: number) =>
            shareStatement({ ...core.share.ctx, keyEpoch }, new Uint8Array(8));
        await expect(at(2 ** 53 - 1)).resolves.toBeInstanceOf(Uint8Array);
        await expect(at(2 ** 53)).rejects.toThrow(CryptoError);
        await expect(at(0)).rejects.toThrow(CryptoError);
    });

    it('refuses a device session over an empty account, device or attempt, as the Rust core does', async () => {
        const session = {
            userId: core.deviceSession.userId,
            deviceId: core.deviceSession.deviceId,
            attemptToken: core.deviceSession.attemptToken,
        };
        await expect(deviceSessionStatement(session)).resolves.toBeInstanceOf(Uint8Array);
        for (const field of ['userId', 'deviceId', 'attemptToken'] as const)
            await expect(deviceSessionStatement({ ...session, [field]: '' })).rejects.toThrow(
                CryptoError,
            );
    });
});
