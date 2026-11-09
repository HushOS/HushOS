import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode, encode } from './keys';
import { createRecovery, openRecovery, recoverySigningKey } from './recovery';
import {
    signTwoStepPhrase,
    stepTokenDigest,
    twoStepPhraseStatement,
    verifyTwoStepPhrase,
} from './two-step';

/*
 * The recovery phrase answering the second step (docs/two-step-design.md 5).
 * The fixture is the bytes the Rust core must build too; here it pins this
 * twin, so a change to the statement cannot pass unnoticed on either side.
 * Then what a server relies on: a signature answers one token of one account,
 * under the phrase the account has now, and nothing else.
 */
const fixture = JSON.parse(
    readFileSync(
        new URL('../../../crates/hushos-core/fixtures/web-two-step.json', import.meta.url),
        'utf8',
    ),
).phrase as {
    userId: string;
    phrase: string;
    wrappingSalt: string;
    stepToken: string;
    stepTokenDigest: string;
    publicKey: string;
    statement: string;
    signature: string;
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the phrase statement', () => {
    it('is the fixture’s bytes: the domain, version 1, the account in lower case, the token’s digest', async () => {
        const statement = await twoStepPhraseStatement(fixture);
        expect(encode(statement)).toBe(fixture.statement);
        expect(JSON.parse(text(statement))).toEqual([
            'hushos/two-step/phrase',
            1,
            fixture.userId.toLowerCase(),
            fixture.stepTokenDigest,
        ]);
        expect(await stepTokenDigest(fixture.stepToken)).toBe(fixture.stepTokenDigest);
    });

    it('is signed with the key derived from the phrase and the salt, to the fixture’s signature', async () => {
        const key = await recoverySigningKey(fixture.phrase, fixture.wrappingSalt);
        expect(key.publicKey).toBe(fixture.publicKey);
        expect(await signTwoStepPhrase(fixture.phrase, fixture)).toBe(fixture.signature);
        expect(await verifyTwoStepPhrase(fixture, fixture.signature, fixture.publicKey)).toBe(true);
    });

    it('refuses an empty account or token rather than sign over nothing', async () => {
        await expect(twoStepPhraseStatement({ ...fixture, userId: '' })).rejects.toThrow();
        await expect(twoStepPhraseStatement({ ...fixture, stepToken: '' })).rejects.toThrow();
    });
});

describe('a phrase signature', () => {
    it('answers its own step token only, for its own account only', async () => {
        const { signature, publicKey } = fixture;
        // Another token: a signature lifted from one sign-in does not pass another.
        expect(
            await verifyTwoStepPhrase(
                { ...fixture, stepToken: `${fixture.stepToken.slice(0, -1)}A` },
                signature,
                publicKey,
            ),
        ).toBe(false);
        // Another account with the same token.
        expect(
            await verifyTwoStepPhrase(
                { ...fixture, userId: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5' },
                signature,
                publicKey,
            ),
        ).toBe(false);
    });

    it('is refused when a single bit of it is changed, and when it is not a signature at all', async () => {
        const bytes = decode(fixture.signature, 64);
        for (const at of [0, 31, 32, 63]) {
            const tampered = bytes.slice();
            tampered[at]! ^= 1;
            expect(await verifyTwoStepPhrase(fixture, encode(tampered), fixture.publicKey)).toBe(
                false,
            );
        }
        for (const junk of ['', 'not-base64!', encode(bytes.subarray(0, 63)), 'A'.repeat(86)])
            expect(await verifyTwoStepPhrase(fixture, junk, fixture.publicKey)).toBe(false);
    });

    it('made with another salt, or another phrase, does not verify under the account’s key', async () => {
        const otherSalt = encode(decode(fixture.wrappingSalt, 32).map((byte) => byte ^ 0xff));
        expect(
            await verifyTwoStepPhrase(
                fixture,
                await signTwoStepPhrase(fixture.phrase, { ...fixture, wrappingSalt: otherSalt }),
                fixture.publicKey,
            ),
        ).toBe(false);
        const stranger = await createRecovery(
            crypto.getRandomValues(new Uint8Array(32)),
            fixture.userId,
        );
        expect(
            await verifyTwoStepPhrase(
                fixture,
                await signTwoStepPhrase(stranger.phrase, fixture),
                fixture.publicKey,
            ),
        ).toBe(false);
    });

    it('is made by the same key a phrase reset signs with, so the stored recovery public key checks both', async () => {
        const accountKey = crypto.getRandomValues(new Uint8Array(32));
        const userId = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
        const { recovery, phrase } = await createRecovery(accountKey, userId);
        const opened = await openRecovery(phrase, userId, recovery);
        const step = await recoverySigningKey(phrase, recovery.wrappingSalt);
        expect(step.publicKey).toBe(recovery.publicKey);
        expect(step.privateKey).toEqual(opened.signingKey);
        const input = { userId, stepToken: fixture.stepToken };
        const signature = await signTwoStepPhrase(phrase, {
            ...input,
            wrappingSalt: recovery.wrappingSalt,
        });
        expect(await verifyTwoStepPhrase(input, signature, recovery.publicKey)).toBe(true);

        // After a rotation the account has a new recovery key: the old phrase passes nothing.
        const rotated = await createRecovery(accountKey, userId, 2);
        expect(await verifyTwoStepPhrase(input, signature, rotated.recovery.publicKey)).toBe(false);
    });

    it('is not made from words that are not a phrase', async () => {
        await expect(
            signTwoStepPhrase('twelve words are not a recovery phrase at all', fixture),
        ).rejects.toThrow(/recovery phrase/);
    });
});
