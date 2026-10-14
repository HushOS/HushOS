import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import { encode } from './keys';
import { mlDsaKeypair, mlDsaSign } from './pq';
import {
    copyForm,
    integrityOf,
    metadataResealedStatement,
    metadataSavedStatement,
    metadataStatement,
    metadataStatementAs,
    metadataStatements,
    keysStatement,
    resealForm,
    signHybrid,
    signStatement,
    successionStatement,
    verifyHybrid,
    verifyStatement,
    versionResealedStatement,
    versionSavedStatement,
    versionStatement,
    versionStatementAs,
    versionStatements,
    type Integrity,
    type SignatureForm,
} from './signatures';

/*
 * A writer's signature holds for the exact record it was made over and for
 * nothing near it: another envelope, version, node, kind or statement kind
 * fails, and a reader with nobody to check it against says so instead of
 * calling it good.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const OBJECT = '44444444-4444-4444-8444-444444444444';

async function keyPair() {
    await sodium.ready;
    const pair = sodium.crypto_sign_keypair();
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}
const sha = (bytes: Uint8Array) =>
    encode(new Uint8Array(createHash('sha256').update(bytes).digest()));

describe('statements', () => {
    test('are the canonical JSON arrays the design fixes, ids lowercased', async () => {
        const envelope = crypto.getRandomValues(new Uint8Array(296));
        const metadata = await metadataStatement(
            { workspaceId: WS.toUpperCase(), nodeId: NODE, kind: 'file', metadataVersion: 4 },
            envelope,
        );
        expect(new TextDecoder().decode(metadata)).toBe(
            `["hushos/drive/sig/metadata",1,"${WS}","${NODE}","file",4,"${sha(envelope)}"]`,
        );
        const version = await versionStatement(
            {
                workspaceId: WS,
                nodeId: NODE,
                versionId: VERSION,
                objectId: OBJECT,
                contentSuite: 3,
            },
            envelope,
        );
        expect(new TextDecoder().decode(version)).toBe(
            `["hushos/drive/sig/version",1,"${WS}","${NODE}","${VERSION}","${OBJECT}",3,"${sha(envelope)}"]`,
        );
    });

    test('refuse what no writer signs', async () => {
        const envelope = new Uint8Array(10);
        await expect(
            metadataStatement(
                { workspaceId: WS, nodeId: NODE, kind: 'link' as 'file', metadataVersion: 1 },
                envelope,
            ),
        ).rejects.toThrow('Invalid node kind');
        await expect(
            metadataStatement(
                { workspaceId: WS, nodeId: NODE, kind: 'file', metadataVersion: 0 },
                envelope,
            ),
        ).rejects.toThrow('Invalid metadata version');
        await expect(
            versionStatement(
                {
                    workspaceId: '',
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 3,
                },
                envelope,
            ),
        ).rejects.toThrow('Invalid workspace id');
        const keys = await keyPair();
        const key = encode(keys.publicKey);
        const link = {
            userId: NODE,
            oldKeyVersion: 2,
            newKeyVersion: 2,
            oldEncryptionPublicKey: key,
            oldSigningPublicKey: key,
            oldMlDsaPublicKey: encode(new Uint8Array(1952)),
            newEncryptionPublicKey: key,
            newSigningPublicKey: key,
            newMlDsaPublicKey: encode(new Uint8Array(1952)),
            newKemPublicKey: encode(new Uint8Array(1184)),
        };
        await expect(successionStatement(link)).rejects.toThrow('Invalid key version');
        await expect(
            successionStatement({ ...link, newKeyVersion: 3, newKemPublicKey: key }),
        ).rejects.toThrow();
        // An ML-DSA key of the wrong length is no key: the statement is not built.
        await expect(
            successionStatement({ ...link, newKeyVersion: 3, oldMlDsaPublicKey: key }),
        ).rejects.toThrow();
        // Version 2, and the ML-DSA keys in it: what makes a classical signature over it fail.
        const built = JSON.parse(
            new TextDecoder().decode(await successionStatement({ ...link, newKeyVersion: 3 })),
        );
        expect(built.slice(0, 2)).toEqual(['hushos/identity/succession', 2]);
        expect(built).toHaveLength(12);
    });
});

describe('hybrid signatures', () => {
    async function hybridPair() {
        const ed = await keyPair();
        const lattice = mlDsaKeypair(crypto.getRandomValues(new Uint8Array(32)));
        return {
            signing: { signingKey: ed.privateKey, mlDsaSecretKey: lattice.secretKey },
            public: { signingPublicKey: ed.publicKey, mlDsaPublicKey: lattice.publicKey },
        };
    }
    const keys = async () => {
        const pair = await hybridPair();
        return keysStatement({
            userId: NODE,
            keyVersion: 1,
            encryptionPublicKey: encode(new Uint8Array(32)),
            signingPublicKey: encode(pair.public.signingPublicKey),
            mlDsaPublicKey: encode(pair.public.mlDsaPublicKey),
            kemPublicKey: encode(new Uint8Array(1184)),
        });
    };

    test('hold only when both halves verify, under the identity context', async () => {
        const signer = await hybridPair();
        const other = await hybridPair();
        const message = await keys();
        const signature = await signHybrid(message, signer.signing);
        expect(signature).toHaveLength(3373);
        expect(await verifyHybrid(message, signature, signer.public)).toBe(true);
        // Either key swapped for another's, the other kept.
        expect(
            await verifyHybrid(message, signature, {
                ...signer.public,
                mlDsaPublicKey: other.public.mlDsaPublicKey,
            }),
        ).toBe(false);
        expect(
            await verifyHybrid(message, signature, {
                ...signer.public,
                signingPublicKey: other.public.signingPublicKey,
            }),
        ).toBe(false);
        // A flip in either half, the other half left valid.
        for (const at of [7, 64 + 7, 3372]) {
            const broken = signature.slice();
            broken[at]! ^= 1;
            expect(await verifyHybrid(message, broken, signer.public)).toBe(false);
        }
        // The Ed25519 half alone, or a signature of any other length, is no fallback.
        expect(await verifyHybrid(message, signature.subarray(0, 64), signer.public)).toBe(false);
        expect(await verifyHybrid(message, signature.subarray(64), signer.public)).toBe(false);
        expect(await verifyHybrid(message, new Uint8Array(3374), signer.public)).toBe(false);
        // Another message.
        const near = message.slice();
        near[near.length - 3]! ^= 1;
        expect(await verifyHybrid(near, signature, signer.public)).toBe(false);
    });

    test('an ML-DSA half made under the group context does not pass as an identity signature', async () => {
        const signer = await hybridPair();
        const message = await keys();
        const genuine = await signHybrid(message, signer.signing);
        // The same Ed25519 half with an ML-DSA half the group key would make (hushos/group/v1).
        const groupHalf = mlDsaSign(message, signer.signing.mlDsaSecretKey, 'hushos/group/v1');
        const mixed = new Uint8Array(3373);
        mixed.set(genuine.subarray(0, 64));
        mixed.set(groupHalf, 64);
        expect(await verifyHybrid(message, mixed, signer.public)).toBe(false);
        // And no context at all, as a plain ML-DSA signature would carry.
        mixed.set(mlDsaSign(message, signer.signing.mlDsaSecretKey, ''), 64);
        expect(await verifyHybrid(message, mixed, signer.public)).toBe(false);
    });
});

describe('signatures', () => {
    const ctx = { workspaceId: WS, nodeId: NODE, kind: 'folder' as const, metadataVersion: 2 };

    test('verify for the signer over the record they signed, and fail for anything near it', async () => {
        const writer = await keyPair();
        const stranger = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(296));
        const statement = await metadataStatement(ctx, envelope);
        const signature = await signStatement(statement, writer.privateKey);
        expect(signature).toHaveLength(64);
        expect(await verifyStatement(statement, signature, writer.publicKey)).toBe(true);
        // Another signer's key.
        expect(await verifyStatement(statement, signature, stranger.publicKey)).toBe(false);
        // The envelope swapped for one the server or a key holder sealed.
        const swapped = envelope.slice();
        swapped[30]! ^= 1;
        const near = [
            await metadataStatement(ctx, swapped),
            // Replayed at the next metadata version, or onto another node.
            await metadataStatement({ ...ctx, metadataVersion: 3 }, envelope),
            await metadataStatement({ ...ctx, nodeId: VERSION }, envelope),
            // A folder's name passed off as a file's.
            await metadataStatement({ ...ctx, kind: 'file' }, envelope),
            // The same bytes as a version's content-key envelope.
            await versionStatement(
                {
                    workspaceId: WS,
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 2,
                },
                envelope,
            ),
        ];
        for (const other of near)
            expect(await verifyStatement(other, signature, writer.publicKey)).toBe(false);
        // A flipped bit of the signature, or one of the wrong length, is no signature.
        const flipped = signature.slice();
        flipped[0]! ^= 1;
        expect(await verifyStatement(statement, flipped, writer.publicKey)).toBe(false);
        expect(await verifyStatement(statement, signature.subarray(1), writer.publicKey)).toBe(
            false,
        );
        expect(await verifyStatement(statement, signature, new Uint8Array(32))).toBe(false);
        await expect(signStatement(statement, writer.publicKey)).rejects.toThrow(
            'Invalid signing key',
        );
    });

    test('a version signature names the object, so it cannot vouch for a version pointed elsewhere', async () => {
        const writer = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(84));
        const ctx = {
            workspaceId: WS,
            nodeId: NODE,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 3,
        };
        const signature = await signStatement(
            await versionStatement(ctx, envelope),
            writer.privateKey,
        );
        for (const change of [{ objectId: NODE }, { versionId: NODE }, { contentSuite: 2 }])
            expect(
                await verifyStatement(
                    await versionStatement({ ...ctx, ...change }, envelope),
                    signature,
                    writer.publicKey,
                ),
            ).toBe(false);
    });

    test("a reader's verdict: verified only under the signer's current key, over the ordinary statement", async () => {
        const earlier = await keyPair();
        const current = await keyPair();
        const envelope = new Uint8Array(296).fill(3);
        const statements = () => metadataStatements(ctx, envelope);
        const trusted = { current: current.publicKey, retired: [earlier.publicKey] };
        const byCurrent = await signStatement(
            await metadataStatement(ctx, envelope),
            current.privateKey,
        );
        const byEarlier = await signStatement(
            await metadataStatement(ctx, envelope),
            earlier.privateKey,
        );
        expect(await integrityOf(statements, byCurrent, trusted)).toBe('verified');
        expect(await integrityOf(statements, null, trusted)).toBe('unsigned');
        expect(await integrityOf(statements, byCurrent, undefined)).toBe('unknown-signer');
        expect(await integrityOf(statements, byCurrent, null)).toBe('unknown-signer');
        // A record signed with a key the writer replaced vouches for nothing any more.
        expect(await integrityOf(statements, byEarlier, trusted)).toBe('retired-key');
        // ...and with no chain to that key at all, it is simply not theirs.
        expect(
            await integrityOf(statements, byEarlier, { current: current.publicKey, retired: [] }),
        ).toBe('bad-signature');
        // A retired key listed as current would verify: the caller's split is what decides.
        expect(
            await integrityOf(statements, byCurrent, {
                current: earlier.publicKey,
                retired: [current.publicKey],
            }),
        ).toBe('retired-key');
        // A statement that cannot be built (a damaged row) is not a good signature.
        expect(
            await integrityOf(
                () => Promise.reject(new CryptoError('Invalid key encoding.')),
                byCurrent,
                trusted,
            ),
        ).toBe('bad-signature');
        // A check that fails to run is unchecked: never verified, never silently dropped.
        expect(
            await integrityOf(() => Promise.reject(new Error('worker died')), byCurrent, trusted),
        ).toBe('unchecked');
    });

    test('a re-sealed signature is resealed, never verified, and an ordinary one never reads as re-sealed', async () => {
        const writer = await keyPair();
        const earlier = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(84));
        const version = {
            workspaceId: WS,
            nodeId: NODE,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 3,
        };
        const ordinary = await versionStatement(version, envelope);
        const resealed = await versionResealedStatement(version, envelope);
        expect(new TextDecoder().decode(resealed)).toBe(
            `["hushos/drive/sig/version-resealed",1,"${WS}","${NODE}","${VERSION}","${OBJECT}",3,"${sha(envelope)}"]`,
        );
        const metadataResealed = await metadataResealedStatement(ctx, envelope);
        expect(new TextDecoder().decode(metadataResealed)).toBe(
            `["hushos/drive/sig/metadata-resealed",1,"${WS}","${NODE}","folder",2,"${sha(envelope)}"]`,
        );
        const asResealed = await signStatement(resealed, writer.privateKey);
        const asOrdinary = await signStatement(ordinary, writer.privateKey);
        // Domain separation both ways, at the primitive.
        expect(await verifyStatement(ordinary, asResealed, writer.publicKey)).toBe(false);
        expect(await verifyStatement(resealed, asOrdinary, writer.publicKey)).toBe(false);
        expect(
            await verifyStatement(
                await metadataStatement(ctx, envelope),
                await signStatement(metadataResealed, writer.privateKey),
                writer.publicKey,
            ),
        ).toBe(false);
        const statements = () => versionStatements(version, envelope);
        const trusted = { current: writer.publicKey, retired: [earlier.publicKey] };
        expect(await integrityOf(statements, asResealed, trusted)).toBe('resealed');
        expect(await integrityOf(statements, asOrdinary, trusted)).toBe('verified');
        // Re-sealed under a replaced key is still only a retired key.
        const oldResealed = await signStatement(resealed, earlier.privateKey);
        expect(await integrityOf(statements, oldResealed, trusted)).toBe('retired-key');
        // A re-sealed signature over another record is no signature of this one.
        const other = crypto.getRandomValues(new Uint8Array(84));
        expect(
            await integrityOf(() => versionStatements(version, other), asResealed, trusted),
        ).toBe('bad-signature');
    });

    test('a saved signature ends in "link", reads as saved-from-link, and no form passes for another', async () => {
        const writer = await keyPair();
        const earlier = await keyPair();
        const envelope = crypto.getRandomValues(new Uint8Array(84));
        const version = {
            workspaceId: WS,
            nodeId: NODE,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 3,
        };
        expect(new TextDecoder().decode(await versionSavedStatement(version, envelope))).toBe(
            `["hushos/drive/sig/version-saved",1,"${WS}","${NODE}","${VERSION}","${OBJECT}",3,"${sha(envelope)}","link"]`,
        );
        expect(new TextDecoder().decode(await metadataSavedStatement(ctx, envelope))).toBe(
            `["hushos/drive/sig/metadata-saved",1,"${WS}","${NODE}","folder",2,"${sha(envelope)}","link"]`,
        );
        const forms: SignatureForm[] = ['ordinary', 'saved', 'resealed'];
        // Every form's signature under every form's statement: only its own holds.
        for (const signed of forms) {
            const metadataSignature = await signStatement(
                await metadataStatementAs(signed, ctx, envelope),
                writer.privateKey,
            );
            const versionSignature = await signStatement(
                await versionStatementAs(signed, version, envelope),
                writer.privateKey,
            );
            for (const checked of forms) {
                expect(
                    await verifyStatement(
                        await metadataStatementAs(checked, ctx, envelope),
                        metadataSignature,
                        writer.publicKey,
                    ),
                    `${signed} metadata under ${checked}`,
                ).toBe(signed === checked);
                expect(
                    await verifyStatement(
                        await versionStatementAs(checked, version, envelope),
                        versionSignature,
                        writer.publicKey,
                    ),
                    `${signed} version under ${checked}`,
                ).toBe(signed === checked);
            }
        }
        const saved = await signStatement(
            await versionSavedStatement(version, envelope),
            writer.privateKey,
        );
        const statements = () => versionStatements(version, envelope);
        const trusted = { current: writer.publicKey, retired: [earlier.publicKey] };
        expect(await integrityOf(statements, saved, trusted)).toBe('saved-from-link');
        expect(
            await integrityOf(
                () => metadataStatements(ctx, envelope),
                await signStatement(await metadataSavedStatement(ctx, envelope), writer.privateKey),
                trusted,
            ),
        ).toBe('saved-from-link');
        // Saved by a key since replaced is only a retired key; saved over another record holds for nothing.
        const oldSaved = await signStatement(
            await versionSavedStatement(version, envelope),
            earlier.privateKey,
        );
        expect(await integrityOf(statements, oldSaved, trusted)).toBe('retired-key');
        const other = crypto.getRandomValues(new Uint8Array(84));
        expect(await integrityOf(() => versionStatements(version, other), saved, trusted)).toBe(
            'bad-signature',
        );
        // By nobody this reader trusts, it is an unknown signer, not saved.
        expect(await integrityOf(statements, saved, undefined)).toBe('unknown-signer');
    });

    test('a copy signs by where it came from; a reseal keeps saved only for what verified as saved', () => {
        const priors: Integrity[] = [
            'verified',
            'saved-from-link',
            'resealed',
            'retired-key',
            'unknown-signer',
            'bad-signature',
            'unsigned',
        ];
        const expected: Record<string, SignatureForm> = {
            verified: 'ordinary',
            'saved-from-link': 'saved',
        };
        for (const prior of priors) {
            expect(resealForm(prior), prior).toBe(expected[prior] ?? 'resealed');
            expect(copyForm(prior, false), prior).toBe(expected[prior] ?? 'resealed');
            // From a link it is saved whatever the original's verdict: a visitor checks nothing.
            expect(copyForm(prior, true), prior).toBe('saved');
        }
        expect(copyForm(null, true)).toBe('saved');
        expect(copyForm('unchecked', true)).toBe('saved');
        expect(() => resealForm('unchecked')).toThrow('couldn’t check');
        expect(() => copyForm('unchecked', false)).toThrow('couldn’t check');
        expect(() => copyForm(null, false)).toThrow('couldn’t check');
    });
});
