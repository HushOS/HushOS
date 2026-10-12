import { describe, expect, test } from 'vitest';
import { createSettingsKey, openSettingsKey } from './contacts';
import {
    createIdentity,
    createSuccessor,
    openIdentityEncryptionKey,
    openIdentityKemKey,
    openIdentitySigningKey,
} from './identity';
import { rewrapAccountKeys } from './security';
import { createWorkspaceGrant, openWorkspaceKey } from './workspace';

/*
 * A master-key rotation must carry everything sealed under the old root to the
 * new one: the identity, every earlier identity (shares sealed to them open
 * with nothing else), the settings key and the grants. Anything left behind
 * is lost with the old root, so each is checked to open under the new root,
 * with the same keys inside, and no longer under the old one.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';

describe('master-key rotation', () => {
    test('rewraps the identity, its history and the settings key, keeping versions and keys', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const next = crypto.getRandomValues(new Uint8Array(32));
        const first = await createIdentity(root, USER);
        const second = await createSuccessor(
            root,
            USER,
            first,
            await openIdentitySigningKey(root, USER, first),
        );
        const third = await createSuccessor(
            root,
            USER,
            second.identity,
            await openIdentitySigningKey(root, USER, second.identity),
        );
        const settings = await createSettingsKey(root, USER);
        const grant = await createWorkspaceGrant(root, USER, WS, 1);
        const history = [first, second.identity];
        const rewrapped = await rewrapAccountKeys(root, next, USER, 2, {
            identity: third.identity,
            identityHistory: history,
            settingsKey: settings.envelope,
            workspaces: [grant],
        });

        // Every identity, current and earlier, in order, at its own version with its own keys.
        const all = [rewrapped.identity, ...rewrapped.identityHistory];
        const before = [third.identity, ...history];
        expect(all.map((identity) => identity.keyVersion)).toEqual([3, 1, 2]);
        for (const [index, identity] of all.entries()) {
            const was = before[index]!;
            expect(identity.encryptionPublicKey).toBe(was.encryptionPublicKey);
            expect(identity.signingPublicKey).toBe(was.signingPublicKey);
            expect(identity.kem?.publicKey).toBe(was.kem?.publicKey);
            expect(await openIdentityEncryptionKey(next, USER, identity)).toEqual(
                await openIdentityEncryptionKey(root, USER, was),
            );
            expect((await openIdentityKemKey(next, USER, identity))?.publicKey).toBe(
                was.kem!.publicKey,
            );
            await expect(openIdentityEncryptionKey(root, USER, identity)).rejects.toThrow();
        }
        // The settings key is the same key, now under the new root only.
        expect(await openSettingsKey(next, USER, rewrapped.settingsKey!)).toEqual(settings.key);
        await expect(openSettingsKey(root, USER, rewrapped.settingsKey!)).rejects.toThrow();
        // Grants take the new root revision; the workspace key inside is unchanged.
        expect(rewrapped.workspaces[0]!.keyVersion).toBe(2);
        expect(await openWorkspaceKey(next, USER, rewrapped.workspaces[0]!)).toEqual(
            await openWorkspaceKey(root, USER, grant),
        );
    });

    test('an account without a settings key or history rotates without them', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const next = crypto.getRandomValues(new Uint8Array(32));
        const identity = await createIdentity(root, USER);
        const rewrapped = await rewrapAccountKeys(root, next, USER, 2, {
            identity,
            settingsKey: null,
            workspaces: [],
        });
        expect(rewrapped.settingsKey).toBeUndefined();
        expect(rewrapped.identityHistory).toEqual([]);
        expect(rewrapped.identity.keyVersion).toBe(identity.keyVersion);
    });

    test('refuses a history envelope that is not this root’s, rather than leaving it behind', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const other = crypto.getRandomValues(new Uint8Array(32));
        const identity = await createIdentity(root, USER);
        const stranger = await createIdentity(other, USER);
        await expect(
            rewrapAccountKeys(root, crypto.getRandomValues(new Uint8Array(32)), USER, 2, {
                identity,
                identityHistory: [stranger],
                settingsKey: null,
                workspaces: [],
            }),
        ).rejects.toThrow();
    });
});
