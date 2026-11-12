import { describe, expect, test } from 'vitest';
import { decode, encode } from './keys';
import { createRecovery } from './recovery';
import {
    formatBackupCode,
    normalizeBackupCode,
    recoveryStepKey,
    signTwoStepPhrase,
    stepTokenDigest,
    twoStepPhraseStatement,
    verifyTwoStepPhrase,
} from './two-step';
import {
    base32,
    deriveTwoStepKey,
    generateBackupCodes,
    generateTotpSecret,
    hashBackupCode,
    openTotpSecret,
    sealTotpSecret,
    totpCode,
    totpMatches,
    totpStep,
    totpUri,
    twoStepKeyId,
} from './two-step-server';

/*
 * Two-step sign-in's cryptography (docs/two-step-design.md 2, 5, 8): the codes an
 * authenticator app shows, the window they are accepted in, the secret and the backup codes
 * as they are stored, and the statement the recovery phrase signs. Each case is something a
 * person or an attacker would meet: an app whose codes the server refuses, a code accepted
 * outside its 90 seconds, a secret that opens on another account, a stored code that can be
 * looked up, a phrase signature that passes somebody else's step.
 */

const text = new TextEncoder();
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FACTOR = '33333333-3333-4333-8333-333333333333';
const key = (fill: number) => new Uint8Array(32).fill(fill);

describe('authenticator codes', () => {
    // RFC 6238, appendix B: the SHA-1 secret, and the last six digits of each eight-digit vector.
    const secret = text.encode('12345678901234567890');
    test.each([
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037'],
        [20000000000, '353130'],
    ])('RFC 6238 at %i seconds is %s', async (seconds, code) => {
        expect(await totpCode(secret, Math.floor(seconds / 30))).toBe(code);
        expect(totpStep(seconds * 1000)).toBe(Math.floor(seconds / 30));
    });

    test('a code is taken for the step before, the step itself and the step after, and no further', async () => {
        const now = 1_700_000_000_000;
        const step = totpStep(now);
        for (const [offset, expected] of [
            [-2, []],
            [-1, [step - 1]],
            [0, [step]],
            [1, [step + 1]],
            [2, []],
        ] as const)
            expect(await totpMatches(secret, await totpCode(secret, step + offset), now)).toEqual(
                expected,
            );
        // The whole window moves with the clock: the last second of a step, and the first of the next.
        const edge = (step + 1) * 30_000;
        const code = await totpCode(secret, step - 1);
        expect(await totpMatches(secret, code, edge - 1)).toEqual([step - 1]);
        expect(await totpMatches(secret, code, edge)).toEqual([]);
    });

    test('only the six digits are a code: spaces are forgiven, anything else is refused', async () => {
        const now = 1_700_000_000_000;
        const code = await totpCode(secret, totpStep(now));
        expect(await totpMatches(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toEqual([
            totpStep(now),
        ]);
        for (const typed of ['', code.slice(1), `${code}0`, `0${code}`, 'abcdef', `${code}\u0000`])
            expect(await totpMatches(secret, typed, now)).toEqual([]);
        // Another app's secret gives another code.
        const other = await totpCode(text.encode('09876543210987654321'), totpStep(now));
        expect(other).not.toBe(code);
        expect(await totpMatches(secret, other, now)).toEqual([]);
    });

    test('the key URI is one every authenticator app reads', () => {
        expect(base32(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        const uri = totpUri({ secret, email: 'maya+work@hush.example', issuer: 'HushOS' });
        expect(uri).toBe(
            'otpauth://totp/HushOS:maya%2Bwork%40hush.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=HushOS&algorithm=SHA1&digits=6&period=30',
        );
        // A self-hosted server's issuer names its host, in the label and the parameter alike.
        const selfHosted = new URL(
            totpUri({ secret, email: 'maya@hush.example', issuer: 'HushOS (drive.example.org)' }),
        );
        expect(selfHosted.searchParams.get('issuer')).toBe('HushOS (drive.example.org)');
        expect(selfHosted.host).toBe('totp');
        expect(decodeURIComponent(selfHosted.pathname)).toBe(
            '/HushOS (drive.example.org):maya@hush.example',
        );
        // 160 bits, and not the same twice.
        const made = generateTotpSecret();
        expect(made).toHaveLength(20);
        expect(base32(made)).toHaveLength(32);
        expect(encode(generateTotpSecret())).not.toBe(encode(made));
    });
});

describe('the secret at rest', () => {
    const secret = text.encode('12345678901234567890');

    test('opens only for the account, factor and key it was sealed with', async () => {
        const stored = await sealTotpSecret({
            secret,
            key: key(1),
            userId: USER,
            factorId: FACTOR,
        });
        // What the table holds: a nonce, the 20 bytes with their tag, and which key.
        expect(stored.nonce).toHaveLength(24);
        expect(stored.sealed).toHaveLength(36);
        expect(encode(stored.keyId)).toBe(encode(await twoStepKeyId(key(1))));
        expect(Buffer.from(stored.sealed).includes(Buffer.from(secret))).toBe(false);
        const open = (change: Partial<Parameters<typeof openTotpSecret>[0]>) =>
            openTotpSecret({
                sealed: stored.sealed,
                nonce: stored.nonce,
                key: key(1),
                userId: USER,
                factorId: FACTOR,
                ...change,
            });
        expect(encode((await open({}))!)).toBe(encode(secret));
        // A row copied onto another account, or another of the account's factors.
        expect(await open({ userId: OTHER })).toBeNull();
        expect(await open({ factorId: OTHER })).toBeNull();
        // A copy of the database without the key.
        expect(await open({ key: key(2) })).toBeNull();
        // A changed byte.
        const tampered = stored.sealed.slice();
        tampered[0] = tampered[0]! ^ 1;
        expect(await open({ sealed: tampered })).toBeNull();
        // Sealed twice, the same secret is never the same bytes.
        const again = await sealTotpSecret({ secret, key: key(1), userId: USER, factorId: FACTOR });
        expect(encode(again.sealed)).not.toBe(encode(stored.sealed));
    });

    test('the derived key follows the OPAQUE setup, and is not the server hash key', async () => {
        const setup = text.encode('setup-a'.repeat(20));
        const derived = await deriveTwoStepKey(setup);
        expect(derived).toHaveLength(32);
        // The same setup, read from the environment or from the database, is the same key.
        expect(encode(await deriveTwoStepKey(setup.slice()))).toBe(encode(derived));
        expect(encode(await deriveTwoStepKey(text.encode('setup-b'.repeat(20))))).not.toBe(
            encode(derived),
        );
        // The server hash key comes from the same setup under another `info` (packages/db hash-key.ts).
        const material = await crypto.subtle.importKey('raw', setup, 'HKDF', false, ['deriveBits']);
        const hashKey = new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: new Uint8Array(0),
                    info: text.encode('hushos/server/hash-key/v1'),
                },
                material,
                256,
            ),
        );
        expect(encode(derived)).not.toBe(encode(hashKey));
        // A key's id is eight bytes of its SHA-256: it names the key without giving it.
        const id = await twoStepKeyId(derived);
        expect(id).toHaveLength(8);
        expect(encode(id)).not.toBe(encode(await twoStepKeyId(hashKey)));
        expect(Buffer.from(derived).includes(Buffer.from(id))).toBe(false);
    });
});

describe('backup codes', () => {
    const salt = (fill: number) => new Uint8Array(16).fill(fill);

    test('a typed code is read whatever its case, spaces and hyphens, and its look-alike letters', () => {
        expect(normalizeBackupCode('7KQ2M-9XD4P')).toBe('7KQ2M9XD4P');
        expect(normalizeBackupCode('7kq2m 9xd4p')).toBe('7KQ2M9XD4P');
        expect(normalizeBackupCode('  7kq2m - 9xd4p\n')).toBe('7KQ2M9XD4P');
        // I and L are 1, O is 0: none of the three is in the alphabet.
        expect(normalizeBackupCode('ilo2m-9xd4p')).toBe('1102M9XD4P');
        expect(formatBackupCode('7KQ2M9XD4P')).toBe('7KQ2M-9XD4P');
        // U is in no code; nine or eleven characters are not one either.
        for (const typed of [
            '7KQ2M-9XD4U',
            '7KQ2M-9XD4',
            '7KQ2M-9XD4PP',
            '',
            '7KQ2M_9XD4P',
            '７KQ2M9XD4P',
        ])
            expect(normalizeBackupCode(typed)).toBeNull();
    });

    test('a set is ten different codes of the alphabet, each read back as itself', () => {
        const codes = generateBackupCodes();
        expect(new Set(codes).size).toBe(10);
        for (const code of codes) {
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
            expect(normalizeBackupCode(formatBackupCode(code))).toBe(code);
        }
        expect(generateBackupCodes()).not.toEqual(codes);
    });

    test('what is stored is neither the code nor its hash, and verifies only under its own key and salt', async () => {
        const code = '7KQ2M9XD4P';
        const stored = await hashBackupCode({ code, key: key(1), salt: salt(1) });
        expect(stored).toHaveLength(32);
        const plain = new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(code)));
        expect(encode(stored)).not.toBe(encode(plain));
        expect(Buffer.from(stored).includes(Buffer.from(code))).toBe(false);
        // The same code hashes to the same bytes: that is how a typed one is found.
        expect(encode(await hashBackupCode({ code, key: key(1), salt: salt(1) }))).toBe(
            encode(stored),
        );
        // Another account's salt, another two-step key, another code.
        expect(encode(await hashBackupCode({ code, key: key(1), salt: salt(2) }))).not.toBe(
            encode(stored),
        );
        expect(encode(await hashBackupCode({ code, key: key(2), salt: salt(1) }))).not.toBe(
            encode(stored),
        );
        expect(
            encode(await hashBackupCode({ code: '7KQ2M9XD4Q', key: key(1), salt: salt(1) })),
        ).not.toBe(encode(stored));
        // Unkeyed Argon2id of the code with the same salt is something else: without the key, a
        // copy of the database gives nothing to test a guess against.
        const { argon2id } = await import('hash-wasm');
        const unkeyed = await argon2id({
            password: text.encode(code),
            salt: salt(1),
            memorySize: 19 * 1024,
            iterations: 2,
            parallelism: 1,
            hashLength: 32,
            outputType: 'binary',
        });
        expect(encode(unkeyed)).not.toBe(encode(stored));
        // Only a whole, normalised code is hashed.
        await expect(
            hashBackupCode({ code: '7KQ2M-9XD4P', key: key(1), salt: salt(1) }),
        ).rejects.toThrow();
    });
});

describe('the recovery phrase as a step', () => {
    const TOKEN = 'k3J9s0mQx1Yt7uVw2Zb4Nc6Lr8Pd5Hf0Ga9Se3Tq1Wo';

    test('the statement names the account and the token, and nothing else moves it', async () => {
        const tokenDigest = await stepTokenDigest(TOKEN);
        expect(
            new TextDecoder().decode(
                twoStepPhraseStatement({ userId: USER.toUpperCase(), tokenDigest }),
            ),
        ).toBe(`["hushos/two-step/phrase",1,"${USER}","${tokenDigest}"]`);
        // The digest is the SHA-256 the server keeps of the token: 32 bytes, base64url.
        expect(decode(tokenDigest, 32)).toHaveLength(32);
        expect(() => twoStepPhraseStatement({ userId: '', tokenDigest })).toThrow();
        for (const notDigest of ['', 'AAAA', `${tokenDigest}A`, tokenDigest.slice(1)])
            expect(() =>
                twoStepPhraseStatement({ userId: USER, tokenDigest: notDigest }),
            ).toThrow();
    });

    test('the phrase’s signature passes its own account’s step for its own token, and no other', async () => {
        const { recovery, phrase } = await createRecovery(key(9), USER);
        const signingKey = await recoveryStepKey(phrase, recovery.wrappingSalt);
        const signature = await signTwoStepPhrase(signingKey, { userId: USER, stepToken: TOKEN });
        const tokenDigest = await stepTokenDigest(TOKEN);
        expect(
            await verifyTwoStepPhrase({ userId: USER, tokenDigest }, signature, recovery.publicKey),
        ).toBe(true);
        // Typed with other spacing and case, the phrase is the same phrase.
        const sloppy = await recoveryStepKey(
            `  ${phrase.toUpperCase().replaceAll(' ', '\n ')} `,
            recovery.wrappingSalt,
        );
        expect(encode(sloppy)).toBe(encode(signingKey));

        // Another step's token, and another account's statement.
        const otherDigest = await stepTokenDigest(`${TOKEN.slice(1)}A`);
        expect(
            await verifyTwoStepPhrase(
                { userId: USER, tokenDigest: otherDigest },
                signature,
                recovery.publicKey,
            ),
        ).toBe(false);
        expect(
            await verifyTwoStepPhrase(
                { userId: OTHER, tokenDigest },
                signature,
                recovery.publicKey,
            ),
        ).toBe(false);
        // Another account's recovery key, and this account's key after it was rotated.
        const theirs = await createRecovery(key(9), OTHER);
        const rotated = await createRecovery(key(9), USER, 2);
        for (const publicKey of [theirs.recovery.publicKey, rotated.recovery.publicKey])
            expect(
                await verifyTwoStepPhrase({ userId: USER, tokenDigest }, signature, publicKey),
            ).toBe(false);
        // The key depends on the envelope's salt: derived with another, it is another key.
        const wrongSalt = await recoveryStepKey(phrase, rotated.recovery.wrappingSalt);
        expect(
            await verifyTwoStepPhrase(
                { userId: USER, tokenDigest },
                await signTwoStepPhrase(wrongSalt, { userId: USER, stepToken: TOKEN }),
                recovery.publicKey,
            ),
        ).toBe(false);
        // A signature that is not one is refused, not thrown.
        for (const bad of ['', 'AAAA', signature.slice(1), `${signature.slice(0, -1)}!`])
            expect(
                await verifyTwoStepPhrase({ userId: USER, tokenDigest }, bad, recovery.publicKey),
            ).toBe(false);
    });

    test('words that are no phrase are refused before anything is derived', async () => {
        const { recovery } = await createRecovery(key(9), USER);
        await expect(
            recoveryStepKey('correct horse battery staple', recovery.wrappingSalt),
        ).rejects.toThrow(/not a valid recovery phrase/);
    });
});
