import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { hybridSignerFromSeed, signingKeyFromSeed } from '../test/helpers';
import { readFileSync } from 'node:fs';
import {
    deviceSessionStatement,
    keysStatement,
    metadataRekeyedStatement,
    metadataSigned,
    metadataStatement,
    signedForm,
    successionStatement,
    verifyHybrid,
    verifySignature,
    verifySigned,
    versionRekeyedStatement,
    versionSigned,
    versionStatement,
} from './signatures';

/*
 * The statements are what every client signs, so their bytes are pinned here
 * against the layout in docs/integrity-design.md, written out by hand: a
 * change to the canonical form (spacing, case, digest encoding, field order)
 * is a protocol break, not a refactor. Verification is checked against the
 * RFC 8032 test vectors, which libsodium's crypto_sign_detached reproduces.
 */

const hex = (value: string) => Buffer.from(value, 'hex');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64url');

// RFC 8032, section 7.1, tests 1 and 2.
const RFC_1 = {
    seed: hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
    publicKey: hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
    message: Buffer.alloc(0),
    signature: hex(
        'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    ),
};
const RFC_2 = {
    publicKey: hex('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
    message: hex('72'),
    signature: hex(
        '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    ),
};

const WORKSPACE = '0F8FAD5B-D9CB-469F-A165-70867728950E';
const NODE = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';
const VERSION = '6EC0BD7F-11C0-43DA-975E-2A8AD9EBAE0B';
const OBJECT = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';

describe('statements', () => {
    test('metadata: the fixed label, lowercase ids, the kind, the version and the envelope digest', () => {
        const envelope = Buffer.from('sealed metadata');
        expect(
            metadataStatement({
                workspaceId: WORKSPACE,
                nodeId: NODE,
                kind: 'file',
                metadataVersion: 3,
                metadataEnvelope: envelope,
            }).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/metadata",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","file",3,"${sha(envelope)}"]`,
        );
        // Base64url without padding: a SHA-256 digest is 43 characters.
        expect(sha(envelope)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    test('version: node, version and object ids, the content suite, and the envelope digest', () => {
        const envelope = Buffer.alloc(84, 7);
        expect(
            versionStatement({
                workspaceId: WORKSPACE,
                nodeId: NODE,
                versionId: VERSION,
                objectId: OBJECT,
                contentSuite: 3,
                contentKeyEnvelope: envelope,
            }).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/version",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b","3f2504e0-4f89-41d3-9a0c-0305e82c3301",3,"${sha(envelope)}"]`,
        );
    });

    test('re-sealed metadata: its own label, otherwise the same fields as the ordinary statement', () => {
        const envelope = Buffer.from('sealed metadata');
        expect(
            metadataStatement(
                {
                    workspaceId: WORKSPACE,
                    nodeId: NODE,
                    kind: 'folder',
                    metadataVersion: 2,
                    metadataEnvelope: envelope,
                },
                'resealed',
            ).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/metadata-resealed",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","folder",2,"${sha(envelope)}"]`,
        );
    });

    test('re-sealed version: its own label, otherwise the same fields as the ordinary statement', () => {
        const envelope = Buffer.alloc(84, 7);
        expect(
            versionStatement(
                {
                    workspaceId: WORKSPACE,
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 2,
                    contentKeyEnvelope: envelope,
                },
                'resealed',
            ).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/version-resealed",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b","3f2504e0-4f89-41d3-9a0c-0305e82c3301",2,"${sha(envelope)}"]`,
        );
    });

    test('saved metadata and version: their own labels, the same fields, then "link"', () => {
        const metadataEnvelope = Buffer.from('sealed metadata');
        expect(
            metadataStatement(
                {
                    workspaceId: WORKSPACE,
                    nodeId: NODE,
                    kind: 'file',
                    metadataVersion: 1,
                    metadataEnvelope,
                },
                'saved',
            ).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/metadata-saved",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","file",1,"${sha(metadataEnvelope)}","link"]`,
        );
        const contentKeyEnvelope = Buffer.alloc(84, 7);
        expect(
            versionStatement(
                {
                    workspaceId: WORKSPACE,
                    nodeId: NODE,
                    versionId: VERSION,
                    objectId: OBJECT,
                    contentSuite: 3,
                    contentKeyEnvelope,
                },
                'saved',
            ).toString('utf8'),
        ).toBe(
            `["hushos/drive/sig/version-saved",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b","3f2504e0-4f89-41d3-9a0c-0305e82c3301",3,"${sha(contentKeyEnvelope)}","link"]`,
        );
    });

    test('succession version 2: both key versions, the six public keys in Base64url, the new KEM key by digest', () => {
        const kem = Buffer.alloc(1184, 9);
        const key = (fill: number) => Buffer.alloc(32, fill);
        const lattice = (fill: number) => Buffer.alloc(1952, fill);
        expect(
            successionStatement({
                userId: NODE,
                oldKeyVersion: 2,
                newKeyVersion: 3,
                oldEncryptionPublicKey: key(1),
                oldSigningPublicKey: key(2),
                oldMlDsaPublicKey: lattice(5),
                newEncryptionPublicKey: key(3),
                newSigningPublicKey: key(4),
                newMlDsaPublicKey: lattice(6),
                newKemPublicKey: kem,
            }).toString('utf8'),
        ).toBe(
            `["hushos/identity/succession",2,"7c9e6679-7425-40de-944b-e07fc1f90ae7",2,3,"${key(1).toString('base64url')}","${key(2).toString('base64url')}","${lattice(5).toString('base64url')}","${key(3).toString('base64url')}","${key(4).toString('base64url')}","${lattice(6).toString('base64url')}","${sha(kem)}"]`,
        );
    });

    test('keys statement: the account, the key version, four public keys, the KEM key by digest', () => {
        const kem = Buffer.alloc(1184, 9);
        const key = (fill: number) => Buffer.alloc(32, fill);
        const lattice = Buffer.alloc(1952, 5);
        expect(
            keysStatement({
                userId: NODE,
                keyVersion: 4,
                encryptionPublicKey: key(1),
                signingPublicKey: key(2),
                mlDsaPublicKey: lattice,
                kemPublicKey: kem,
            }).toString('utf8'),
        ).toBe(
            `["hushos/identity/keys",1,"7c9e6679-7425-40de-944b-e07fc1f90ae7",4,"${key(1).toString('base64url')}","${key(2).toString('base64url')}","${lattice.toString('base64url')}","${sha(kem)}"]`,
        );
    });
});

describe('hybrid verification', () => {
    const signer = hybridSignerFromSeed(Buffer.alloc(32, 7));
    const keys = {
        signingPublicKey: signer.signingPublicKey,
        mlDsaPublicKey: signer.mlDsaPublicKey,
    };
    const message = Buffer.from('["hushos/identity/keys",1]');

    test('holds only when both halves verify', () => {
        const signature = signer.sign(message);
        expect(signature).toHaveLength(3373);
        expect(verifyHybrid(keys, message, signature)).toBe(true);
        for (const at of [3, 64 + 3, 3372]) {
            const broken = Buffer.from(signature);
            broken[at]! ^= 1;
            expect(verifyHybrid(keys, message, broken)).toBe(false);
        }
        expect(verifyHybrid(keys, Buffer.from('another'), signature)).toBe(false);
        const other = hybridSignerFromSeed(Buffer.alloc(32, 8));
        expect(
            verifyHybrid({ ...keys, mlDsaPublicKey: other.mlDsaPublicKey }, message, signature),
        ).toBe(false);
        expect(
            verifyHybrid({ ...keys, signingPublicKey: other.signingPublicKey }, message, signature),
        ).toBe(false);
    });

    test('never falls back to the Ed25519 half, and refuses a lattice half made under another context', () => {
        const classical = signer.signClassical(message);
        expect(verifyHybrid(keys, message, classical)).toBe(false);
        expect(verifyHybrid(keys, message, Buffer.concat([classical, Buffer.alloc(3309)]))).toBe(
            false,
        );
        // The ML-DSA half of a group signature (hushos/group/v1) is not an identity signature's.
        const groupHalf = ml_dsa65.sign(
            message,
            ml_dsa65.keygen(createHash('sha256').update(Buffer.alloc(32, 7)).digest()).secretKey,
            { context: new TextEncoder().encode('hushos/group/v1') },
        );
        expect(
            verifyHybrid(keys, message, Buffer.concat([classical, Buffer.from(groupHalf)])),
        ).toBe(false);
    });
});

describe('verification', () => {
    test('accepts the RFC 8032 vectors and a key made from a libsodium-style seed', () => {
        expect(verifySignature(RFC_1.publicKey, RFC_1.message, RFC_1.signature)).toBe(true);
        expect(verifySignature(RFC_2.publicKey, RFC_2.message, RFC_2.signature)).toBe(true);
        // The test helper's seed expansion is the one libsodium uses: same seed, same public key.
        const derived = signingKeyFromSeed(RFC_1.seed);
        expect(derived.publicKey.equals(RFC_1.publicKey)).toBe(true);
        expect(derived.sign(RFC_1.message).equals(RFC_1.signature)).toBe(true);
    });

    test('refuses another message, another key, a flipped bit and malformed lengths', () => {
        expect(verifySignature(RFC_1.publicKey, RFC_2.message, RFC_1.signature)).toBe(false);
        expect(verifySignature(RFC_2.publicKey, RFC_1.message, RFC_1.signature)).toBe(false);
        const flipped = Buffer.from(RFC_1.signature);
        flipped[10]! ^= 1;
        expect(verifySignature(RFC_1.publicKey, RFC_1.message, flipped)).toBe(false);
        expect(verifySignature(RFC_1.publicKey, RFC_1.message, RFC_1.signature.subarray(1))).toBe(
            false,
        );
        expect(verifySignature(RFC_1.publicKey.subarray(1), RFC_1.message, RFC_1.signature)).toBe(
            false,
        );
    });

    test('a signature over one statement does not carry to the next metadata version', () => {
        const signer = signingKeyFromSeed(RFC_1.seed);
        const at = {
            workspaceId: WORKSPACE,
            nodeId: NODE,
            kind: 'folder' as const,
            metadataEnvelope: Buffer.from('name'),
        };
        const signature = signer.sign(metadataStatement({ ...at, metadataVersion: 1 }));
        expect(
            verifySignature(
                signer.publicKey,
                metadataStatement({ ...at, metadataVersion: 1 }),
                signature,
            ),
        ).toBe(true);
        expect(
            verifySignature(
                signer.publicKey,
                metadataStatement({ ...at, metadataVersion: 2 }),
                signature,
            ),
        ).toBe(false);
    });

    test('any of the three forms verifies; another label, another source or another key does not', () => {
        const signer = signingKeyFromSeed(RFC_1.seed);
        const other = signingKeyFromSeed(Buffer.alloc(32, 5));
        const metadata = {
            workspaceId: WORKSPACE,
            nodeId: NODE,
            kind: 'file' as const,
            metadataVersion: 1,
            metadataEnvelope: Buffer.from('name'),
        };
        const version = {
            workspaceId: WORKSPACE,
            nodeId: NODE,
            versionId: VERSION,
            objectId: OBJECT,
            contentSuite: 3,
            contentKeyEnvelope: Buffer.alloc(84, 1),
        };
        for (const form of ['ordinary', 'saved', 'resealed'] as const) {
            expect(
                verifySigned(
                    signer.publicKey,
                    metadataSigned(metadata, signer.sign(metadataStatement(metadata, form))),
                ),
            ).toBe(true);
            expect(
                verifySigned(
                    signer.publicKey,
                    versionSigned(version, signer.sign(versionStatement(version, form))),
                ),
            ).toBe(true);
            expect(
                verifySigned(
                    signer.publicKey,
                    metadataSigned(metadata, other.sign(metadataStatement(metadata, form))),
                ),
            ).toBe(false);
        }
        // A statement under any other label, even one the server might be tricked into
        // reading as a softer claim, is not accepted.
        const forged = Buffer.from(
            metadataStatement(metadata)
                .toString('utf8')
                .replace('hushos/drive/sig/metadata', 'hushos/drive/sig/metadata-relocked'),
        );
        expect(verifySigned(signer.publicKey, metadataSigned(metadata, signer.sign(forged)))).toBe(
            false,
        );
        // A saved statement naming any source but a link, or none, is a forgery too.
        for (const source of ['share', 'drive', ''])
            expect(
                verifySigned(
                    signer.publicKey,
                    metadataSigned(
                        metadata,
                        signer.sign(
                            Buffer.from(
                                metadataStatement(metadata, 'saved')
                                    .toString('utf8')
                                    .replace(/,"link"\]$/, source ? `,"${source}"]` : ']'),
                            ),
                        ),
                    ),
                ),
                source,
            ).toBe(false);
        // Nor does a metadata signature carry over to the version statement in re-sealed form.
        expect(
            verifySigned(
                signer.publicKey,
                versionSigned(version, signer.sign(metadataStatement(metadata, 'resealed'))),
            ),
        ).toBe(false);
    });
});

describe('the device session statement', () => {
    test('the label, lowercase ids and the attempt token’s digest, base64url', () => {
        expect(
            deviceSessionStatement({
                userId: WORKSPACE,
                deviceId: NODE,
                attemptDigest: createHash('sha256').update('abc').digest(),
            }).toString('utf8'),
        ).toBe(
            '["hushos/device/session",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"]',
        );
    });

    test('is the bytes the web wrote into the core fixture, and its proof verifies here', () => {
        const fixture = JSON.parse(
            readFileSync(
                new URL('../../../crates/hushos-core/fixtures/web.json', import.meta.url),
                'utf8',
            ),
        ).deviceSession as Record<string, string>;
        const statement = deviceSessionStatement({
            userId: fixture.userId!,
            deviceId: fixture.deviceId!,
            // The server passes the attempt's stored token hash: SHA-256 of the token's UTF-8.
            attemptDigest: createHash('sha256').update(fixture.attemptToken!).digest(),
        });
        expect(statement.toString('base64url')).toBe(fixture.statement);
        const publicKey = Buffer.from(fixture.publicKey!, 'base64url');
        const signature = Buffer.from(fixture.signature!, 'base64url');
        expect(verifySignature(publicKey, statement, signature)).toBe(true);
        const other = deviceSessionStatement({
            userId: fixture.userId!,
            deviceId: fixture.deviceId!,
            attemptDigest: createHash('sha256').update(`${fixture.attemptToken}x`).digest(),
        });
        expect(verifySignature(publicKey, other, signature)).toBe(false);
    });
});

/*
 * The server is the third builder of the rekeyed statements (beside the web's
 * and the Rust core's): it rebuilds them from the origin it copied and must
 * produce the bytes the clients signed, byte for byte.
 */
describe('the rekeyed statements', () => {
    type FixtureRecord = {
        statement: Record<string, string | number>;
        keyEpoch: number;
        envelope: string;
        origin: { envelope: string; signerId: string; signature: string; keyEnvelope: string };
        rekeySignature: string;
    };
    const fixture = JSON.parse(
        readFileSync(
            new URL('../../../crates/hushos-core/fixtures/web.json', import.meta.url),
            'utf8',
        ),
    ).rekeyed as {
        rekeyer: { signingPublicKey: string };
        metadata: FixtureRecord;
        version: FixtureRecord;
        metadataStatement: string;
        versionStatement: string;
    };
    const bytes = (value: string) => Buffer.from(value, 'base64url');
    const originOf = (record: FixtureRecord) => ({
        envelope: bytes(record.origin.envelope),
        signerId: record.origin.signerId,
        signature: bytes(record.origin.signature),
        keyEnvelope: bytes(record.origin.keyEnvelope),
    });
    const metadataOf = (record = fixture.metadata) =>
        metadataRekeyedStatement(
            {
                workspaceId: record.statement.workspaceId as string,
                nodeId: record.statement.nodeId as string,
                kind: record.statement.kind as 'folder' | 'file',
                metadataVersion: record.statement.metadataVersion as number,
                metadataEnvelope: bytes(record.envelope),
                keyEpoch: record.keyEpoch,
            },
            originOf(record),
        );
    const versionOf = (record = fixture.version) =>
        versionRekeyedStatement(
            {
                workspaceId: record.statement.workspaceId as string,
                nodeId: record.statement.nodeId as string,
                versionId: record.statement.versionId as string,
                objectId: record.statement.objectId as string,
                contentSuite: record.statement.contentSuite as number,
                contentKeyEnvelope: bytes(record.envelope),
                keyEpoch: record.keyEpoch,
            },
            originOf(record),
        );
    const rekeyer = bytes(fixture.rekeyer.signingPublicKey);

    test('are the bytes the web wrote into the core fixture, and the re-keyer’s signatures hold here', () => {
        // The fixture's origin signer is upper case: the statement lowercases it, as every id.
        expect(fixture.metadata.origin.signerId).not.toBe(
            fixture.metadata.origin.signerId.toLowerCase(),
        );
        expect(metadataOf().toString('base64url')).toBe(fixture.metadataStatement);
        expect(versionOf().toString('base64url')).toBe(fixture.versionStatement);
        expect(verifySignature(rekeyer, metadataOf(), bytes(fixture.metadata.rekeySignature))).toBe(
            true,
        );
        expect(verifySignature(rekeyer, versionOf(), bytes(fixture.version.rekeySignature))).toBe(
            true,
        );
    });

    test('every field it names moves the bytes: the epoch, the wrapped key, the origin and its signer', () => {
        const signature = bytes(fixture.metadata.rekeySignature);
        const holds = (record: FixtureRecord) =>
            verifySignature(rekeyer, metadataOf(record), signature);
        const flip = (value: string) => {
            const raw = bytes(value);
            raw[raw.length - 1]! ^= 1;
            return raw.toString('base64url');
        };
        const m = fixture.metadata;
        expect(holds({ ...m, keyEpoch: m.keyEpoch + 1 })).toBe(false);
        expect(holds({ ...m, envelope: flip(m.envelope) })).toBe(false);
        for (const field of ['envelope', 'signature', 'keyEnvelope'] as const)
            expect(holds({ ...m, origin: { ...m.origin, [field]: flip(m.origin[field]) } })).toBe(
                false,
            );
        expect(
            holds({
                ...m,
                origin: { ...m.origin, signerId: '00000000-0000-4000-8000-000000000000' },
            }),
        ).toBe(false);
    });

    test('never pass for a writer statement, in any form, nor the reverse', () => {
        const rekeyed = bytes(fixture.metadata.rekeySignature);
        const fields = {
            workspaceId: fixture.metadata.statement.workspaceId as string,
            nodeId: fixture.metadata.statement.nodeId as string,
            kind: fixture.metadata.statement.kind as 'folder' | 'file',
            metadataVersion: fixture.metadata.statement.metadataVersion as number,
            metadataEnvelope: bytes(fixture.metadata.envelope),
        };
        expect(verifySigned(rekeyer, metadataSigned(fields, rekeyed))).toBe(false);
        expect(signedForm(rekeyer, metadataSigned(fields, rekeyed))).toBeNull();
        // The version's re-key signature does not stand for the metadata's either.
        expect(verifySignature(rekeyer, metadataOf(), bytes(fixture.version.rekeySignature))).toBe(
            false,
        );
    });
});

describe('which form a writer signature holds in', () => {
    const signer = signingKeyFromSeed(RFC_1.seed);
    const fields = {
        workspaceId: WORKSPACE,
        nodeId: NODE,
        kind: 'file' as const,
        metadataVersion: 2,
        metadataEnvelope: Buffer.alloc(42, 7),
    };
    test('is the one it was signed in, and none under another key', () => {
        for (const form of ['ordinary', 'saved', 'resealed'] as const)
            expect(
                signedForm(
                    signer.publicKey,
                    metadataSigned(fields, signer.sign(metadataStatement(fields, form))),
                ),
            ).toBe(form);
        expect(
            signedForm(
                RFC_2.publicKey,
                metadataSigned(fields, signer.sign(metadataStatement(fields, 'resealed'))),
            ),
        ).toBeNull();
    });
});
