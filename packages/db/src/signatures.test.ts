import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { signingKeyFromSeed } from '../test/helpers';
import {
    metadataStatement,
    successionStatement,
    verifySignature,
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

    test('succession: both key versions, the four public keys in Base64url, the new KEM key by digest', () => {
        const kem = Buffer.alloc(1184, 9);
        const key = (fill: number) => Buffer.alloc(32, fill);
        expect(
            successionStatement({
                userId: NODE,
                oldKeyVersion: 2,
                newKeyVersion: 3,
                oldEncryptionPublicKey: key(1),
                oldSigningPublicKey: key(2),
                newEncryptionPublicKey: key(3),
                newSigningPublicKey: key(4),
                newKemPublicKey: kem,
            }).toString('utf8'),
        ).toBe(
            `["hushos/identity/succession",1,"7c9e6679-7425-40de-944b-e07fc1f90ae7",2,3,"${key(1).toString('base64url')}","${key(2).toString('base64url')}","${key(3).toString('base64url')}","${key(4).toString('base64url')}","${sha(kem)}"]`,
        );
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
});
