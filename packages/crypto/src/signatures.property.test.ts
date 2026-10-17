import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deviceSessionStatement } from './device-identity';
import { CryptoError } from './errors';
import {
    verifyIdentityKeys,
    verifySuccessionChain,
    verifySuccessionConsent,
    verifySuccessionLink,
    type SuccessionLink,
} from './identity';
import { decode } from './keys';
import {
    digest,
    shareStatement,
    successionConsentStatement,
    successionStatement,
} from './signatures';
import core from './__fixtures__/core.json';

/*
 * The statements every identity, succession, share and device signature
 * covers, built from fields the server serves, and the verifiers over them:
 * a statement refuses with a CryptoError and nothing else, a verifier never
 * throws, and a verifier that says yes only ever does so over a statement
 * that builds. The edits start from the core's real, signed records
 * (core.json), so the verifiers' yes path is reached too.
 */

async function refusedOrValue<T>(run: () => T | Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof CryptoError) return null;
        throw error;
    }
}

/* Values an edit puts in a field of its own type: the protocol's shapes, their edges, letters that case-fold oddly, and noise. */
const text = fc.oneof(
    fc.constantFrom('', 'A', 'AAAAA', 'İ', 'ẞ', 'Σ', '2FBCF4D7-A8FA-490C-BEEB-2B8D041F7311'),
    fc.string({ maxLength: 6 }),
);
const number = fc.constantFrom(0, 1, 2, 3, 2 ** 53 - 1, 2 ** 53, 1.5, -1);

/* `record` with one field replaced (by a value of the same type), upper-cased, cut short or extended. */
function edit<T extends object>(record: T) {
    const keys = Object.keys(record) as (keyof T)[];
    return fc
        .tuple(fc.nat(keys.length - 1), fc.nat(3), text, number)
        .map(([at, how, word, count]) => {
            const copy = { ...record } as Record<keyof T, unknown>;
            const key = keys[at]!;
            const current = copy[key];
            if (typeof current === 'number') copy[key] = count;
            else if (typeof current !== 'string') return copy as T;
            else if (how === 0) copy[key] = current.toUpperCase();
            else if (how === 1) copy[key] = current.slice(0, -1);
            else if (how === 2) copy[key] = `${current}A`;
            else copy[key] = word;
            return copy as T;
        });
}

const { link, userId } = core.succession;
const signer = {
    signingPublicKey: link.oldSigningPublicKey,
    mlDsaPublicKey: link.oldMlDsaPublicKey,
};

/* Whether an edit changed the record at all (a number may be replaced by itself). */
const changed = (a: object, b: object) => JSON.stringify(a) !== JSON.stringify(b);

describe('identity and succession statements, over edits of real records', () => {
    it("build a succession statement over exactly the link's fields, its consent over the same with the role, or refuse with a CryptoError", async () => {
        await fc.assert(
            fc.asyncProperty(
                edit({ ...link, userId }),
                fc.constantFrom('old', 'new'),
                async (fields, role) => {
                    const statement = await refusedOrValue(() => successionStatement(fields));
                    const consent = await refusedOrValue(() =>
                        successionConsentStatement(fields, role as 'old' | 'new'),
                    );
                    // The consent statement builds exactly when the version 2 one does: same fields.
                    expect(consent === null).toBe(statement === null);
                    if (!statement || !consent) return;
                    const parts = JSON.parse(new TextDecoder().decode(statement)) as unknown[];
                    expect(parts).toEqual([
                        'hushos/identity/succession',
                        2,
                        fields.userId.toLowerCase(),
                        fields.oldKeyVersion,
                        fields.newKeyVersion,
                        fields.oldEncryptionPublicKey,
                        fields.oldSigningPublicKey,
                        fields.oldMlDsaPublicKey,
                        fields.newEncryptionPublicKey,
                        fields.newSigningPublicKey,
                        fields.newMlDsaPublicKey,
                        await digest(decode(fields.newKemPublicKey, 1184)),
                    ]);
                    expect(JSON.parse(new TextDecoder().decode(consent))).toEqual([
                        'hushos/identity/succession-consent',
                        1,
                        role,
                        ...parts.slice(2),
                    ]);
                },
            ),
            { numRuns: 300 },
        );
    });

    it('verify the real link (whatever the case of the account id) and no edit of it', async () => {
        for (const user of [userId, userId.toLowerCase()])
            expect(await verifySuccessionLink(user, link as SuccessionLink, signer)).toBe(true);
        await fc.assert(
            fc.asyncProperty(edit(link as SuccessionLink), async (edited) => {
                const verified = await verifySuccessionLink(userId, edited, signer);
                const consent = await verifySuccessionConsent(userId, edited);
                if (verified || consent)
                    expect(
                        await refusedOrValue(() => successionStatement({ ...edited, userId })),
                    ).not.toBeNull();
                // Every field but the signature itself is signed: any change to one, or to the signature, breaks it.
                if (changed(edited, link)) expect(verified).toBe(false);
            }),
            { numRuns: 80 },
        );
    });

    it('carry a pinned contact along the real chain, and along no chain with any link edited', async () => {
        const { chain } = core.succession;
        const links = chain.links as SuccessionLink[];
        expect(await verifySuccessionChain(userId, chain.pinned, chain.served, links)).toBe(true);
        const one = fc.oneof(...links.map((l, i) => edit(l).map((edited) => ({ i, edited }))));
        await fc.assert(
            fc.asyncProperty(one, async ({ i, edited }) => {
                const served = links.map((l, at) => (at === i ? edited : l));
                const holds = await verifySuccessionChain(
                    userId,
                    chain.pinned,
                    chain.served,
                    served,
                );
                if (changed(edited, links[i]!)) expect(holds).toBe(false);
                else expect(holds).toBe(true);
            }),
            { numRuns: 60 },
        );
    });

    it('hold the real keys statement (whatever the case of the account id) and no edit of it', async () => {
        const { identity, userId: owner } = core.keys;
        for (const user of [owner, owner.toUpperCase()])
            expect(await verifyIdentityKeys(user, identity)).toBe(true);
        await fc.assert(
            fc.asyncProperty(edit(identity), async (edited) => {
                const holds = await verifyIdentityKeys(owner, edited);
                // The four keys, the version and the signature are all in the statement or are its signature.
                if (changed(edited, identity)) expect(holds).toBe(false);
                else expect(holds).toBe(true);
            }),
            { numRuns: 80 },
        );
    });
});

describe('share and device statements, over generated fields', () => {
    it('build a share statement or refuse with a CryptoError, the ids lowercased and the epoch a safe integer', async () => {
        await fc.assert(
            fc.asyncProperty(
                edit(core.share.ctx),
                fc.uint8Array({ maxLength: 8 }),
                async (ctx, sealed) => {
                    const statement = await refusedOrValue(() => shareStatement(ctx, sealed));
                    if (!statement) return;
                    const parts = JSON.parse(new TextDecoder().decode(statement)) as unknown[];
                    expect(parts[2]).toBe(ctx.workspaceId.toLowerCase());
                    expect(Number.isSafeInteger(parts[4]) && (parts[4] as number) >= 1).toBe(true);
                },
            ),
            { numRuns: 300 },
        );
    });

    it('build a device session statement or refuse with a CryptoError, never over an empty field', async () => {
        const session = {
            userId: core.deviceSession.userId,
            deviceId: core.deviceSession.deviceId,
            attemptToken: core.deviceSession.attemptToken,
        };
        await fc.assert(
            fc.asyncProperty(edit(session), async (fields) => {
                const statement = await refusedOrValue(() => deviceSessionStatement(fields));
                const empty = !fields.userId || !fields.deviceId || !fields.attemptToken;
                if (empty) expect(statement).toBeNull();
            }),
            { numRuns: 300 },
        );
    });
});
