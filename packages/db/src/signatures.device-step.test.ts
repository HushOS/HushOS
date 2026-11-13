import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
    deviceStepCodeDigest,
    deviceStepCommitment,
    deviceStepStatement,
    verifySignature,
} from './signatures';

/*
 * The server's copy of what approving on another device signs and commits to
 * (docs/two-step-design.md 12), held to both clients' fixtures: the web's
 * (`web-device-approval.json`) and the Rust core's (`core-device-approval.json`). The server
 * rebuilds the commitment at the reveal and the statement at the approval; if its bytes drift
 * from a client's, every honest approval from that client is refused.
 */

type Case = {
    purpose: string;
    userId: string;
    requestId: string;
    tokenDigest: string;
    deviceSigningKey: string;
    nonce: string;
    approverKey: string;
    commitment: string;
    code: string;
    statement: string;
    approver: { publicKey: string; signature: string };
};
const read = (path: string) =>
    (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { cases: Case[] }).cases;
const sources = {
    web: read('../../../crates/hushos-core/fixtures/web-device-approval.json'),
    core: read('../../crypto/src/__fixtures__/core-device-approval.json'),
};
const b64 = (value: string) => Buffer.from(value, 'base64url');
const wordlist = readFileSync(
    new URL('../../../crates/hushos-core/src/bip39-english.txt', import.meta.url),
    'utf8',
)
    .split('\n')
    .map((word) => word.trim())
    .filter(Boolean);

describe.each(Object.entries(sources))('requests the %s built', (_name, cases) => {
    const stepOf = (item: Case) => ({
        userId: item.userId,
        requestId: item.requestId,
        purpose: item.purpose,
        tokenDigest: b64(item.tokenDigest),
        deviceSigningKey: b64(item.deviceSigningKey),
    });

    test('the server rebuilds the same commitment, code and statement', () => {
        expect(cases.length).toBeGreaterThanOrEqual(7);
        for (const item of cases) {
            expect(
                deviceStepCommitment({
                    purpose: item.purpose,
                    tokenDigest: b64(item.tokenDigest),
                    deviceSigningKey: b64(item.deviceSigningKey),
                    nonce: b64(item.nonce),
                }).toString('base64url'),
            ).toBe(item.commitment);
            const digest = deviceStepCodeDigest({
                ...stepOf(item),
                approverKey: b64(item.approverKey),
                nonce: b64(item.nonce),
            });
            const number = String(digest.readUInt32BE(0) % 100).padStart(2, '0');
            expect(`${number} ${wordlist[(digest[4]! << 3) | (digest[5]! >> 5)]}`).toBe(item.code);
            expect(deviceStepStatement(stepOf(item)).toString('base64url')).toBe(item.statement);
        }
    });

    test('an approval verifies for its own request, purpose, token and asking device only', () => {
        cases.forEach((item, index) => {
            const key = b64(item.approver.publicKey);
            const signature = b64(item.approver.signature);
            const holds = (step: ReturnType<typeof stepOf>) =>
                verifySignature(key, deviceStepStatement(step), signature);
            expect(holds(stepOf(item))).toBe(true);
            const other = stepOf(cases[(index + 1) % cases.length]!);
            expect(holds(other)).toBe(false);
            expect(holds({ ...stepOf(item), purpose: other.purpose })).toBe(false);
            expect(holds({ ...stepOf(item), tokenDigest: other.tokenDigest })).toBe(false);
            expect(holds({ ...stepOf(item), requestId: other.requestId })).toBe(false);
            expect(holds({ ...stepOf(item), deviceSigningKey: other.deviceSigningKey })).toBe(
                false,
            );
        });
    });
});
