import { describe, expect, test } from 'vitest';
import {
    generateLinkSalt,
    generateLinkSecret,
    openLinkKey,
    openLinkSecret,
    sealLinkKey,
    sealLinkSecret,
} from './links';

/*
 * A link opens for whoever holds the fragment secret (and the password when
 * one was set), under the context it was sealed with, and for nothing else.
 * The password stretch is the account layer's argon2id profile, so a guessed
 * password costs the same as a guessed account password.
 */

const ctx = {
    workspaceId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    keyEpoch: 5,
    linkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

describe('link envelopes', () => {
    test('open with the secret alone when no password was set, and refuse everything else', async () => {
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const secret = generateLinkSecret();
        const salt = generateLinkSalt();
        const envelope = await sealLinkKey(nodeKey, secret, null, salt, ctx);
        expect(envelope).toHaveLength(72);
        const opened = await openLinkKey(envelope, secret, null, salt, ctx);
        expect(Buffer.from(opened).equals(Buffer.from(nodeKey))).toBe(true);
        // A different secret, a password that was never set, or a shifted context.
        await expect(
            openLinkKey(envelope, generateLinkSecret(), null, salt, ctx),
        ).rejects.toThrow();
        await expect(openLinkKey(envelope, secret, 'hunter22', salt, ctx)).rejects.toThrow();
        for (const change of [{ keyEpoch: 6 }, { nodeId: ctx.linkId }, { linkId: ctx.nodeId }])
            await expect(
                openLinkKey(envelope, secret, null, salt, { ...ctx, ...change }),
            ).rejects.toThrow();
        // A flipped byte is refused, never a wrong key returned.
        const tampered = envelope.slice();
        tampered[40] = tampered[40]! ^ 1;
        await expect(openLinkKey(tampered, secret, null, salt, ctx)).rejects.toThrow();
    });

    test('with a password, both the secret and the password are needed, and the salt matters', async () => {
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const secret = generateLinkSecret();
        const salt = generateLinkSalt();
        const envelope = await sealLinkKey(nodeKey, secret, 'correct horse', salt, ctx);
        const opened = await openLinkKey(envelope, secret, 'correct horse', salt, ctx);
        expect(Buffer.from(opened).equals(Buffer.from(nodeKey))).toBe(true);
        await expect(openLinkKey(envelope, secret, null, salt, ctx)).rejects.toThrow();
        await expect(openLinkKey(envelope, secret, 'correct horsf', salt, ctx)).rejects.toThrow();
        await expect(
            openLinkKey(envelope, secret, 'correct horse', generateLinkSalt(), ctx),
        ).rejects.toThrow();
        await expect(
            openLinkKey(envelope, secret, 'correct horse', new Uint8Array(8), ctx),
        ).rejects.toThrow(/salt/);
    }, 60_000);
});

describe("the owner's copy of the secret", () => {
    test('round-trips under the node key, lets the link be re-sealed with a new password, and is bound to its link', async () => {
        const nodeKey = crypto.getRandomValues(new Uint8Array(32));
        const secret = generateLinkSecret();
        const token = crypto.getRandomValues(new Uint8Array(32));
        const fromPassword = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await sealLinkSecret(secret, token, fromPassword, nodeKey, ctx);
        expect(envelope).toHaveLength(136);
        const opened = await openLinkSecret(envelope, nodeKey, ctx);
        expect(Buffer.from(opened.secret).equals(Buffer.from(secret))).toBe(true);
        expect(Buffer.from(opened.token).equals(Buffer.from(token))).toBe(true);
        expect(Buffer.from(opened.fromPassword!).equals(Buffer.from(fromPassword))).toBe(true);
        // Another node key, or another link's context: refused.
        await expect(
            openLinkSecret(envelope, crypto.getRandomValues(new Uint8Array(32)), ctx),
        ).rejects.toThrow();
        await expect(
            openLinkSecret(envelope, nodeKey, { ...ctx, linkId: ctx.nodeId }),
        ).rejects.toThrow();
        // Re-sealing the link with a password keeps the same secret: the old URL opens with the password.
        const salt = generateLinkSalt();
        const resealed = await sealLinkKey(nodeKey, opened.secret, 'later', salt, ctx);
        expect(
            Buffer.from(await openLinkKey(resealed, secret, 'later', salt, ctx)).equals(
                Buffer.from(nodeKey),
            ),
        ).toBe(true);
        await expect(openLinkKey(resealed, secret, null, salt, ctx)).rejects.toThrow();
    }, 60_000);
});
