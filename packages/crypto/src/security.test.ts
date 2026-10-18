import { describe, expect, test } from 'vitest';
import { createSettingsKey, openSettingsKey } from './contacts';
import {
    createIdentity,
    createSuccessor,
    openIdentityEncryptionKey,
    openIdentityKemKey,
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    type IdentityEnvelope,
} from './identity';
import { rewrapAccountKeys } from './security';
import {
    createWorkspaceGrant,
    grantAreaKey,
    openAreaSelfGrant,
    openWorkspaceKey,
} from './workspace';

/*
 * A master-key rotation must carry everything sealed under the old root to the
 * new one: the identity, every earlier identity (shares sealed to them open
 * with nothing else), the settings key and the grants. Anything left behind
 * is lost with the old root, so each is checked to open under the new root,
 * with the same keys inside, and no longer under the old one.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const FAMILY = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';

/* Both private halves of an identity's signature, opened under its root. */
async function hybridKeysOf(root: Uint8Array<ArrayBuffer>, identity: IdentityEnvelope) {
    return {
        signingKey: await openIdentitySigningKey(root, USER, identity),
        mlDsaSecretKey: (await openIdentityMlDsaKey(root, USER, identity))!.secretKey,
    };
}

describe('master-key rotation', () => {
    test('rewraps the identity, its history and the settings key, keeping versions and keys', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const next = crypto.getRandomValues(new Uint8Array(32));
        const first = await createIdentity(root, USER);
        const second = await createSuccessor(root, USER, first, await hybridKeysOf(root, first));
        const third = await createSuccessor(
            root,
            USER,
            second.identity,
            await hybridKeysOf(root, second.identity),
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
            expect(identity.mlDsa?.publicKey).toBe(was.mlDsa?.publicKey);
            expect(identity.keysSignature).toBe(was.keysSignature);
            expect((await openIdentityMlDsaKey(next, USER, identity))!.publicKey).toBe(
                was.mlDsa!.publicKey,
            );
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

    test('rewraps a family folder’s self-grant as its family’s, beside the personal grant', async () => {
        // The bug this guards: every row went through the personal context, which cannot open
        // a self-grant, so no family member could rotate at all.
        const root = crypto.getRandomValues(new Uint8Array(32));
        const next = crypto.getRandomValues(new Uint8Array(32));
        const identity = await createIdentity(root, USER);
        const folderKey = crypto.getRandomValues(new Uint8Array(32));
        const personal = await createWorkspaceGrant(root, USER, WS, 1);
        const self = await grantAreaKey(folderKey, root, USER, FAMILY, FOLDER, 1, 3);
        const rewrapped = await rewrapAccountKeys(root, next, USER, 2, {
            identity,
            settingsKey: null,
            workspaces: [
                { ...personal, groupId: null },
                { ...self, groupId: FAMILY },
            ],
        });
        const [mine, family] = rewrapped.workspaces;
        expect(await openWorkspaceKey(next, USER, mine!)).toEqual(
            await openWorkspaceKey(root, USER, personal),
        );
        // The same folder key at the same folder version, under the new root, still the family's.
        expect([family!.workspaceId, family!.keyVersion, family!.workspaceKeyVersion]).toEqual([
            FOLDER,
            2,
            3,
        ]);
        expect(await openAreaSelfGrant(next, USER, FAMILY, family!)).toEqual(folderKey);
        await expect(openWorkspaceKey(next, USER, family!)).rejects.toThrow();
        await expect(openAreaSelfGrant(root, USER, FAMILY, family!)).rejects.toThrow();
        // What goes back to the server is the envelope alone.
        expect(family).not.toHaveProperty('groupId');
    });

    test('refuses a self-grant served without its family, or with another, never rewrapping it wrongly', async () => {
        const root = crypto.getRandomValues(new Uint8Array(32));
        const identity = await createIdentity(root, USER);
        const self = await grantAreaKey(
            crypto.getRandomValues(new Uint8Array(32)),
            root,
            USER,
            FAMILY,
            FOLDER,
            1,
            1,
        );
        const personal = await createWorkspaceGrant(root, USER, WS, 1);
        for (const workspaces of [
            [self],
            [{ ...self, groupId: null }],
            [{ ...self, groupId: WS }],
            // A personal grant served as a family's is refused just the same.
            [{ ...personal, groupId: FAMILY }],
        ])
            await expect(
                rewrapAccountKeys(root, crypto.getRandomValues(new Uint8Array(32)), USER, 2, {
                    identity,
                    settingsKey: null,
                    workspaces,
                }),
            ).rejects.toThrow();
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

describe('the account root an identity is wrapped under (Codex round 3)', () => {
    test('is 32 bytes: any other length is refused, not wrapped where only the web could open it', async () => {
        for (const length of [0, 16, 31, 33, 64])
            await expect(createIdentity(new Uint8Array(length), USER), `${length}`).rejects.toThrow(
                'Invalid account key.',
            );
        const root = crypto.getRandomValues(new Uint8Array(32));
        const identity = await createIdentity(root, USER);
        const longer = new Uint8Array(33);
        longer.set(root);
        await expect(openIdentitySigningKey(longer, USER, identity)).rejects.toThrow(
            'Invalid account key.',
        );
        expect(await openIdentitySigningKey(root, USER, identity)).toHaveLength(64);
    });
});
