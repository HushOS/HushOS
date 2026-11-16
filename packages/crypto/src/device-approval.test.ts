import sodium from 'libsodium-wrappers';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { beforeAll, describe, expect, test } from 'vitest';
import core from './__fixtures__/core-device-approval.json';
import {
    APPROVAL_PROMPTS_A_DAY,
    approvalPromptsAllowed,
    approvalQr,
    approvalWords,
    deviceStepCode,
    deviceStepCommitment,
    deviceStepStatement,
    deviceTurnOnStatement,
    drawApprovalCode,
    normalizeApprovalCode,
    readApprovalQr,
    signDeviceStep,
    signDeviceTurnOn,
    turnOnCodeDigest,
    type PromptRecord,
} from './device-approval';
import { decode, encode } from './keys';
import { stepTokenDigest } from './two-step';

/*
 * Approving on another device, the bytes (docs/two-step-design.md 12). The cases in
 * `core-device-approval.json` were built by the Rust core: a phone that asks and a browser
 * that approves agree on a code only if this module builds exactly what the core did.
 */

beforeAll(() => sodium.ready);

const stepOf = (item: (typeof core.cases)[number]) => ({
    userId: item.userId,
    requestId: item.requestId,
    purpose: item.purpose,
    tokenDigest: item.tokenDigest,
    deviceSigningKey: item.deviceSigningKey,
});

describe('what the core built', () => {
    test('the web builds the same commitment, code, statement and QR text', async () => {
        expect(core.cases.length).toBeGreaterThanOrEqual(7);
        for (const item of core.cases) {
            expect(await stepTokenDigest(item.stepToken)).toBe(item.tokenDigest);
            expect(await deviceStepCommitment(item)).toBe(item.commitment);
            expect(
                await deviceStepCode({
                    ...stepOf(item),
                    approverKey: item.approverKey,
                    nonce: item.nonce,
                }),
            ).toBe(item.code);
            expect(encode(deviceStepStatement(stepOf(item)))).toBe(item.statement);
            expect(approvalQr(item)).toBe(item.qr);
            expect(readApprovalQr(item.qr)).toEqual({
                requestId: item.requestId,
                commitment: item.commitment,
            });
        }
    });

    test('the core’s approval verifies for its own request, purpose and token only', () => {
        core.cases.forEach((item, index) => {
            const key = decode(item.approver.publicKey, 32);
            const signature = decode(item.approver.signature, 64);
            const holds = (step: ReturnType<typeof stepOf>) =>
                sodium.crypto_sign_verify_detached(signature, deviceStepStatement(step), key);
            expect(holds(stepOf(item))).toBe(true);
            const other = core.cases[(index + 1) % core.cases.length]!;
            expect(holds(stepOf(other))).toBe(false);
            expect(holds({ ...stepOf(item), purpose: other.purpose })).toBe(false);
            expect(holds({ ...stepOf(item), tokenDigest: other.tokenDigest })).toBe(false);
            expect(holds({ ...stepOf(item), deviceSigningKey: other.deviceSigningKey })).toBe(
                false,
            );
        });
    });
});

describe('the code', () => {
    const base = {
        ...stepOf(core.cases[0]!),
        approverKey: core.cases[0]!.approverKey,
        nonce: core.cases[0]!.nonce,
    };

    test('is the first four bytes mod 100 and the word the next 11 bits index', async () => {
        const bytes = [
            new TextEncoder().encode('hushos/two-step/device/v1'),
            new TextEncoder().encode(base.userId.toLowerCase()),
            new TextEncoder().encode(base.requestId),
            new TextEncoder().encode(base.purpose),
            decode(base.tokenDigest, 32),
            decode(base.deviceSigningKey, 32),
            decode(base.approverKey, 32),
            decode(base.nonce, 32),
        ];
        const all = new Uint8Array(bytes.reduce((length, part) => length + part.length, 0));
        let offset = 0;
        for (const part of bytes) {
            all.set(part, offset);
            offset += part.length;
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        const number =
            (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) %
            100;
        const word = wordlist[(digest[4]! << 3) | (digest[5]! >> 5)];
        expect(await deviceStepCode(base)).toBe(`${String(number).padStart(2, '0')} ${word}`);
    });

    test('changes with the account, the request, the purpose, the token and each side’s fresh value', async () => {
        const other = core.cases[1]!;
        const shown = await deviceStepCode(base);
        // 100 × 2048 codes: a change that left the digest alone would show the same one. Each
        // of these moves the digest, and the fixture's values are fixed, so none collides.
        for (const changed of [
            { ...base, userId: other.userId },
            { ...base, requestId: other.requestId },
            { ...base, purpose: other.purpose },
            { ...base, tokenDigest: other.tokenDigest },
            { ...base, deviceSigningKey: other.deviceSigningKey },
            { ...base, approverKey: other.approverKey },
            { ...base, nonce: other.nonce },
        ])
            expect(await deviceStepCode(changed)).not.toBe(shown);
    });

    test('a typed code is read forgivingly, and only a listed word is one', () => {
        expect(normalizeApprovalCode(' 07-River ')).toBe('07 river');
        expect(normalizeApprovalCode('07river')).toBe('07 river');
        expect(normalizeApprovalCode('7 river')).toBeNull();
        expect(normalizeApprovalCode('07 rivr')).toBeNull();
        expect(normalizeApprovalCode('07 river 3')).toBeNull();
        expect(approvalWords('riv')).toEqual(['rival', 'river']);
        expect(approvalWords('')).toEqual([]);
        expect(approvalWords('a', 3)).toHaveLength(3);
    });
});

/*
 * The request that turns the method on. Its code is drawn on the approving device and bound
 * into what that device signs; if the web's digest or statement drifted from the core's, a
 * phone's approval would be refused by the server a browser's confirmation is checked on.
 */
describe('turning the method on', () => {
    const turning = core.cases.filter((item) => 'turnOn' in item);
    const withCode = (item: (typeof core.cases)[number]) =>
        (
            item as typeof item & {
                turnOn: Record<'code' | 'codeDigest' | 'statement' | 'signature', string>;
            }
        ).turnOn;

    test('the web builds the core’s digest and statement, and the core’s signature verifies only for them', async () => {
        expect(turning).toHaveLength(1);
        for (const item of turning) {
            const made = withCode(item);
            expect(item.purpose).toBe('device-approval');
            const codeDigest = await turnOnCodeDigest({
                requestId: item.requestId,
                code: made.code,
            });
            expect(codeDigest).toBe(made.codeDigest);
            // Typed loosely, and with the id in capitals: the same digest.
            expect(
                await turnOnCodeDigest({
                    requestId: item.requestId.toUpperCase(),
                    code: ` ${made.code.toUpperCase().replace(' ', '-')} `,
                }),
            ).toBe(codeDigest);
            const statement = deviceTurnOnStatement({ ...stepOf(item), codeDigest });
            expect(encode(statement)).toBe(made.statement);
            const key = decode(item.approver.publicKey, 32);
            const signature = decode(made.signature, 64);
            const holds = (message: Uint8Array) =>
                sodium.crypto_sign_verify_detached(signature, message, key);
            expect(holds(statement)).toBe(true);
            // Not for another code, not for another request, and not as an ordinary approval.
            const other = await turnOnCodeDigest({ requestId: item.requestId, code: '08 river' });
            expect(other).not.toBe(codeDigest);
            expect(holds(deviceTurnOnStatement({ ...stepOf(item), codeDigest: other }))).toBe(
                false,
            );
            expect(
                await turnOnCodeDigest({ requestId: core.cases[0]!.requestId, code: made.code }),
            ).not.toBe(codeDigest);
            expect(holds(deviceStepStatement(stepOf(item)))).toBe(false);
            // And the ordinary approval of the same request is no approval with a code.
            expect(
                sodium.crypto_sign_verify_detached(
                    decode(item.approver.signature, 64),
                    statement,
                    key,
                ),
            ).toBe(false);
        }
    });

    test('only that request has such a statement, and only a code has a digest', async () => {
        const item = turning[0]!;
        const codeDigest = withCode(item).codeDigest;
        expect(() =>
            deviceTurnOnStatement({ ...stepOf(item), purpose: 'login', codeDigest }),
        ).toThrow();
        expect(() => deviceTurnOnStatement({ ...stepOf(item), codeDigest: 'short' })).toThrow();
        await expect(
            turnOnCodeDigest({ requestId: item.requestId, code: '07 rivr' }),
        ).rejects.toThrow();
        await expect(
            turnOnCodeDigest({ requestId: 'not-an-id', code: '07 river' }),
        ).rejects.toThrow();
    });

    test('a drawn code is a code, and not the same one every time', () => {
        const drawn = Array.from({ length: 400 }, drawApprovalCode);
        for (const code of drawn) expect(normalizeApprovalCode(code)).toBe(code);
        // 204,800 codes: four hundred draws that agree more than a few times are not random,
        // and both parts must move.
        expect(new Set(drawn).size).toBeGreaterThan(390);
        expect(new Set(drawn.map((code) => code.slice(0, 2))).size).toBeGreaterThan(90);
        expect(new Set(drawn.map((code) => code.slice(3))).size).toBeGreaterThan(300);
    });

    test('a browser’s own key signs the statement the server checks', async () => {
        const item = turning[0]!;
        const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
            'sign',
            'verify',
        ])) as CryptoKeyPair;
        const input = { ...stepOf(item), codeDigest: withCode(item).codeDigest };
        const signature = await signDeviceTurnOn(pair.privateKey, input);
        expect(
            await crypto.subtle.verify(
                { name: 'Ed25519' },
                pair.publicKey,
                decode(signature, 64).slice(),
                deviceTurnOnStatement(input).slice(),
            ),
        ).toBe(true);
    });
});

describe('malformed input', () => {
    const good = core.cases[0]!;
    test('a purpose, id or key that is not one is refused, never hashed as it came', async () => {
        await expect(deviceStepCommitment({ ...good, purpose: 'Login' })).rejects.toThrow();
        await expect(
            deviceStepCommitment({ ...good, nonce: encode(new Uint8Array(31)) }),
        ).rejects.toThrow();
        expect(() => deviceStepStatement({ ...stepOf(good), userId: 'not-an-id' })).toThrow();
        expect(readApprovalQr('https://hushos.com/')).toBeNull();
        expect(readApprovalQr('hushos-approve:AAAA')).toBeNull();
    });

    test('a browser’s own Ed25519 key signs the statement the server checks', async () => {
        const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
            'sign',
            'verify',
        ])) as CryptoKeyPair;
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const signature = await signDeviceStep(pair.privateKey, stepOf(good));
        expect(
            sodium.crypto_sign_verify_detached(
                decode(signature, 64),
                deviceStepStatement(stepOf(good)),
                publicKey,
            ),
        ).toBe(true);
    });
});

describe('the approving device’s own limit on prompts', () => {
    const day = new Date('2026-11-14T10:00:00Z');
    test('no more than five a day for a class, whatever is sent, and classes share nothing', () => {
        let record: PromptRecord | null = null;
        let shown = 0;
        for (let round = 0; round < 20; round++) {
            const allowed = approvalPromptsAllowed(
                record,
                [{ id: `s${round}`, class: 'unknown' }],
                day,
            );
            shown += allowed.shown.length;
            record = allowed.record;
        }
        expect(shown).toBe(APPROVAL_PROMPTS_A_DAY);
        const own = approvalPromptsAllowed(
            record,
            [
                { id: 's19', class: 'unknown' },
                { id: 'k', class: 'known' },
                { id: 'c', class: 'change' },
            ],
            day,
        );
        expect(own.shown).toEqual(['k', 'c']);
        // What was shown stays shown while it is still asked, and a new day starts again.
        expect(
            approvalPromptsAllowed(own.record, [{ id: 's0', class: 'unknown' }], day).shown,
        ).toEqual(['s0']);
        expect(
            approvalPromptsAllowed(
                own.record,
                [{ id: 'new', class: 'unknown' }],
                new Date('2026-11-15T00:00:01Z'),
            ).shown,
        ).toEqual(['new']);
    });
});
