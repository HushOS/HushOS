import { writeFile } from 'node:fs/promises';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encode } from '../src/keys';
import { recoverySigningKey } from '../src/recovery';
import { signTwoStepPhrase, stepTokenDigest, twoStepPhraseStatement } from '../src/two-step';

/*
 * The recovery phrase answering the second step (docs/two-step-design.md 5), as
 * the web builds and signs it, for the Rust core to match byte for byte:
 * crates/hushos-core/fixtures/web-two-step.json. Every input is a fixed value
 * and Ed25519 is deterministic, so the file is the same on every run, and
 * packages/crypto/src/two-step.test.ts fails when the code and the file part
 * ways. Regenerate with `bun run --cwd packages/crypto fixtures:two-step` only
 * when the statement itself changes, which is a new version of it.
 */
const bytes = (length: number, seed: number) =>
    Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + ((i * seed) >> 3)) & 0xff);

/* An account id in upper case, as a caller may hand it over: the statement lowercases it. */
const userId = '0B7F1C2E-3D4A-4B5C-8D6E-7F8091A2B3C4';
const phrase = entropyToMnemonic(bytes(32, 53), wordlist);
const wrappingSalt = encode(bytes(32, 59));
const stepToken = encode(bytes(32, 61));
const { publicKey, privateKey } = await recoverySigningKey(phrase, wrappingSalt);
privateKey.fill(0);

const input = { userId, stepToken };
await writeFile(
    new URL('../../../crates/hushos-core/fixtures/web-two-step.json', import.meta.url),
    `${JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/two-step-fixtures.ts',
            phrase: {
                userId,
                phrase,
                wrappingSalt,
                stepToken,
                stepTokenDigest: await stepTokenDigest(stepToken),
                publicKey,
                statement: encode(await twoStepPhraseStatement(input)),
                signature: await signTwoStepPhrase(phrase, { ...input, wrappingSalt }),
            },
        },
        null,
        4,
    )}\n`,
);
console.info('Wrote the two-step fixture.');
