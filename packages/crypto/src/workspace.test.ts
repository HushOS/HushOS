import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import { checkPassword } from './password';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './protocol';
import { createWorkspaceGrant, openWorkspaceKey, rewrapWorkspaceGrant } from './workspace';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function randomKey() {
    return crypto.getRandomValues(new Uint8Array(32));
}

describe('workspace grants', () => {
    test('a grant opens to a 32-byte key, the same one every time', async () => {
        const root = randomKey();
        const grant = await createWorkspaceGrant(root, USER, WORKSPACE, 1);
        expect(grant.workspaceKeyVersion).toBe(1);
        const first = await openWorkspaceKey(root, USER, grant);
        const second = await openWorkspaceKey(root, USER, grant);
        expect(first).toHaveLength(32);
        expect(second).toEqual(first);
    });

    test('a grant does not open under another root, user, workspace, or epoch', async () => {
        const root = randomKey();
        const grant = await createWorkspaceGrant(root, USER, WORKSPACE, 1);
        await expect(openWorkspaceKey(randomKey(), USER, grant)).rejects.toBeInstanceOf(
            CryptoError,
        );
        await expect(openWorkspaceKey(root, OTHER_USER, grant)).rejects.toBeInstanceOf(CryptoError);
        await expect(
            openWorkspaceKey(root, USER, {
                ...grant,
                workspaceId: '44444444-4444-4444-8444-444444444444',
            }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            openWorkspaceKey(root, USER, { ...grant, workspaceKeyVersion: 2 }),
        ).rejects.toBeInstanceOf(CryptoError);
        await expect(
            openWorkspaceKey(root, USER, { ...grant, keyVersion: 2 }),
        ).rejects.toBeInstanceOf(CryptoError);
    });

    test('rewrapping under a new root keeps the key and the workspace epoch', async () => {
        const oldRoot = randomKey();
        const newRoot = randomKey();
        const grant = await createWorkspaceGrant(oldRoot, USER, WORKSPACE, 1);
        const key = await openWorkspaceKey(oldRoot, USER, grant);
        const rewrapped = await rewrapWorkspaceGrant(oldRoot, newRoot, USER, grant, 2);
        expect(rewrapped.keyVersion).toBe(2);
        expect(rewrapped.workspaceKeyVersion).toBe(1);
        expect(rewrapped.encryptedKey).not.toBe(grant.encryptedKey);
        expect(await openWorkspaceKey(newRoot, USER, rewrapped)).toEqual(key);
        await expect(openWorkspaceKey(oldRoot, USER, rewrapped)).rejects.toBeInstanceOf(
            CryptoError,
        );
    });

    test('a tampered ciphertext is refused', async () => {
        const root = randomKey();
        const grant = await createWorkspaceGrant(root, USER, WORKSPACE, 1);
        const bytes = Buffer.from(grant.encryptedKey, 'base64url');
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        await expect(
            openWorkspaceKey(root, USER, { ...grant, encryptedKey: bytes.toString('base64url') }),
        ).rejects.toBeInstanceOf(CryptoError);
    });
});

describe('checkPassword', () => {
    test('accepts the bounds and rejects outside them', () => {
        expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toHaveLength(PASSWORD_MIN_LENGTH);
        expect(checkPassword('a'.repeat(PASSWORD_MAX_LENGTH))).toHaveLength(PASSWORD_MAX_LENGTH);
        expect(() => checkPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow(CryptoError);
        expect(() => checkPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toThrow(CryptoError);
        expect(() => checkPassword(undefined)).toThrow(CryptoError);
    });
});
