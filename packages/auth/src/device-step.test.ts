import {
    deviceStepCommitment,
    deviceStepStatement,
    normalizeApprovalCode,
} from '@hushos/crypto/device-approval';
import { describe, expect, test } from 'vitest';
import type { AuthApi } from './api';
import {
    DeviceStepError,
    approvalCode,
    approve,
    askAnotherDevice,
    openApproval,
    readApprovals,
    readDeviceConfirmed,
    readDeviceEnrolment,
    type ApprovalPrompt,
} from './device-step';

/*
 * Approving on another device, the two clients' own duties (docs/two-step-design.md 12),
 * against a server that only relays, and can be told to lie. What must hold whatever it says:
 * the asking device reveals nothing before an approving device has fixed its value, and reveals
 * once; the approving device signs only when what was revealed is what it saw committed and the
 * typed code is exactly the one it computed, and ends the request otherwise.
 */

const USER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REQUEST = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'T'.repeat(43);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

async function deviceKey() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
    ])) as CryptoKeyPair;
    return {
        privateKey: pair.privateKey,
        verifyKey: pair.publicKey,
        publicKey: b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    };
}

/* A server that keeps one request and relays what each side posts. `calls` is what it was sent. */
function relay() {
    // A request of its own each time: what a page remembers of one it opened is kept by its id.
    const id = crypto.randomUUID();
    const calls: [string, unknown][] = [];
    const held: {
        commitment?: string;
        approverKey?: string;
        reveal?: { deviceSigningKey: string; nonce: string };
        signature?: string;
        denied?: string;
        tokenDigest?: string;
    } = {};
    const api = {
        approvalStart: async (input: { stepToken: string; commitment: string }) => {
            calls.push(['start', input]);
            held.commitment = input.commitment;
            held.tokenDigest = b64(
                new Uint8Array(
                    await crypto.subtle.digest(
                        'SHA-256',
                        new TextEncoder().encode(input.stepToken),
                    ),
                ),
            );
            return { requestId: id, userId: USER, expiresAt: '2026-11-14T10:05:00.000Z' };
        },
        approvalStatus: async () => {
            calls.push(['status', null]);
            if (held.denied) return { state: 'ended', ended: 'refused' };
            if (held.signature) return { state: 'approved', approverKey: held.approverKey };
            if (held.reveal) return { state: 'revealed', approverKey: held.approverKey };
            if (held.approverKey) return { state: 'opened', approverKey: held.approverKey };
            return { state: 'waiting' };
        },
        approvalReveal: async (_id: string, input: { deviceSigningKey: string; nonce: string }) => {
            calls.push(['reveal', input]);
            held.reveal = { deviceSigningKey: input.deviceSigningKey, nonce: input.nonce };
            return { revealed: true };
        },
        approvalOpen: async (_id: string, ephemeralKey: string) => {
            calls.push(['open', ephemeralKey]);
            held.approverKey ??= ephemeralKey;
            return { approverKey: held.approverKey };
        },
        approvalApprove: async (_id: string, signature: string) => {
            calls.push(['approve', signature]);
            held.signature = signature;
            return { approved: true };
        },
        approvalDeny: async (_id: string, reason: string) => {
            calls.push(['deny', reason]);
            held.denied = reason;
            return { ended: true };
        },
    } as unknown as AuthApi;
    const prompt = (purpose = 'login'): ApprovalPrompt => ({
        id,
        purpose,
        class: 'unknown',
        device: { kind: 'web', name: 'Chrome on Windows' },
        location: null,
        selfNamed: true,
        chosen: false,
        createdAt: '2026-11-14T10:00:00.000Z',
        expiresAt: '2026-11-14T10:05:00.000Z',
        tokenDigest: held.tokenDigest!,
        commitment: held.commitment!,
        approverKey: null,
        reveal: null,
    });
    const sent = (what: string) => calls.filter(([call]) => call === what).map(([, body]) => body);
    return { api, calls, held, prompt, sent, id };
}

describe('the device that asks', () => {
    test('commits first, reveals only after a device opened, and only once', async () => {
        const server = relay();
        const asking = await deviceKey();
        const asked = await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: asking.publicKey,
        });
        // What went to the server first names neither the key nor the nonce.
        const [started] = server.sent('start') as { commitment: string }[];
        expect(JSON.stringify(started)).not.toContain(asking.publicKey);
        expect(started!.commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // Nobody has opened: however often it looks, nothing is revealed and there is no code.
        for (let look = 0; look < 3; look++)
            expect(await asked.poll()).toEqual({ state: 'waiting' });
        expect(server.sent('reveal')).toEqual([]);

        const opened = await openApproval(server.api, server.prompt());
        const first = await asked.poll();
        expect(first.state).toBe('code');
        // The server may go on answering `opened` for a while: the reveal still goes once.
        server.held.reveal = undefined;
        await asked.poll();
        await asked.poll();
        expect(server.sent('reveal')).toHaveLength(1);
        const [revealed] = server.sent('reveal') as { deviceSigningKey: string; nonce: string }[];
        // And what it revealed is what it committed to, for this token and purpose.
        expect(
            await deviceStepCommitment({
                purpose: 'login',
                tokenDigest: server.held.tokenDigest!,
                deviceSigningKey: revealed!.deviceSigningKey,
                nonce: revealed!.nonce,
            }),
        ).toBe(started!.commitment);

        // Both sides read the same code off their own values.
        const theirs = await approvalCode(server.api, opened, revealed!, USER);
        expect(first).toEqual({ state: 'code', code: theirs });
        expect(normalizeApprovalCode(theirs)).toBe(theirs);
    });

    test('a status past waiting that carries no approving value is not an answer, and reveals nothing', async () => {
        const server = relay();
        const asked = await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: (await deviceKey()).publicKey,
        });
        (server.api as unknown as { approvalStatus: () => Promise<unknown> }).approvalStatus =
            async () => ({ state: 'opened' });
        await expect(asked.poll()).rejects.toThrow();
        expect(server.sent('reveal')).toEqual([]);
    });

    test('an ended request says only how it ended', async () => {
        const server = relay();
        const asked = await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: (await deviceKey()).publicKey,
        });
        server.held.denied = 'not-me';
        expect(await asked.poll()).toEqual({ state: 'ended', ended: 'refused' });
    });
});

describe('the device that approves', () => {
    async function revealedRequest(purpose = 'login') {
        const server = relay();
        const asking = await deviceKey();
        const asked = await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose,
            deviceSigningKey: asking.publicKey,
        });
        const opened = await openApproval(server.api, server.prompt(purpose));
        const shown = await asked.poll();
        if (shown.state !== 'code') throw new Error(shown.state);
        return { server, asking, asked, opened, code: shown.code, reveal: server.held.reveal! };
    }

    test('signs only the exact code, with its own key, over this request, purpose, token and device', async () => {
        const { server, asked, opened, code, reveal } = await revealedRequest('password');
        const approver = await deviceKey();
        // Typed as people type: other case, a hyphen, spaces around.
        const [digits, word] = code.split(' ');
        await approve(server.api, {
            opened,
            reveal,
            userId: USER,
            privateKey: approver.privateKey,
            typed: `  ${digits}-${word!.toUpperCase()} `,
        });
        expect(server.sent('deny')).toEqual([]);
        const [signature] = server.sent('approve') as string[];
        const statement = deviceStepStatement({
            userId: USER,
            requestId: server.id,
            purpose: 'password',
            tokenDigest: server.held.tokenDigest!,
            deviceSigningKey: reveal.deviceSigningKey,
        });
        const verifies = (message: Uint8Array) =>
            crypto.subtle.verify(
                { name: 'Ed25519' },
                approver.verifyKey,
                Buffer.from(signature!, 'base64url'),
                message.slice(),
            );
        expect(await verifies(statement)).toBe(true);
        // Not over the same request for another purpose.
        expect(
            await verifies(
                deviceStepStatement({
                    userId: USER,
                    requestId: server.id,
                    purpose: 'login',
                    tokenDigest: server.held.tokenDigest!,
                    deviceSigningKey: reveal.deviceSigningKey,
                }),
            ),
        ).toBe(false);
        expect((await asked.poll()).state).toBe('approved');
    });

    test('a code that does not match ends the request and signs nothing', async () => {
        const { server, opened, code, reveal } = await revealedRequest();
        const approver = await deviceKey();
        const [digits, word] = code.split(' ');
        const other = `${String((Number(digits) + 1) % 100).padStart(2, '0')} ${word}`;
        await expect(
            approve(server.api, {
                opened,
                reveal,
                userId: USER,
                privateKey: approver.privateKey,
                typed: other,
            }),
        ).rejects.toMatchObject({ reason: 'wrong' });
        expect(server.sent('approve')).toEqual([]);
        expect(server.sent('deny')).toEqual(['wrong-code']);
    });

    test('a reveal that is not what was committed to is refused before any code is asked for', async () => {
        const { server, opened, reveal } = await revealedRequest();
        const approver = await deviceKey();
        // The server swaps in a key of its own after the approving device fixed its value.
        const swapped = { deviceSigningKey: (await deviceKey()).publicKey, nonce: reveal.nonce };
        await expect(approvalCode(server.api, opened, swapped, USER)).rejects.toBeInstanceOf(
            DeviceStepError,
        );
        await expect(
            approve(server.api, {
                opened,
                reveal: { ...reveal, nonce: random() },
                userId: USER,
                privateKey: approver.privateKey,
                typed: '00 abandon',
            }),
        ).rejects.toMatchObject({ reason: 'mismatch' });
        expect(server.sent('approve')).toEqual([]);
        // Not a wrong code: the person typed nothing wrong, the other side was not honest.
        expect(server.sent('deny')).toEqual(['mismatch', 'mismatch']);
    });

    test('a commitment made for another purpose does not match the purpose the prompt shows', async () => {
        const server = relay();
        const asked = await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: (await deviceKey()).publicKey,
        });
        // The server shows a sign-in's request as a password change: the approving device
        // computes from what it is shown, and the commitment was made for something else.
        const lied = await openApproval(server.api, server.prompt('password'));
        await asked.poll();
        await expect(
            approvalCode(server.api, lied, server.held.reveal!, USER),
        ).rejects.toMatchObject({ reason: 'mismatch' });
    });

    test('a scanned code for another request’s commitment opens nothing', async () => {
        const server = relay();
        await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: (await deviceKey()).publicKey,
        });
        await expect(openApproval(server.api, server.prompt(), random())).rejects.toMatchObject({
            reason: 'mismatch',
        });
        expect(server.sent('open')).toEqual([]);
        expect(server.sent('deny')).toEqual(['mismatch']);
    });

    async function asked() {
        const server = relay();
        await askAnotherDevice(server.api, {
            stepToken: TOKEN,
            purpose: 'login',
            deviceSigningKey: (await deviceKey()).publicKey,
        });
        return server;
    }

    test('opening again sends this device’s own value again, and keeps the commitment it first saw', async () => {
        const server = await asked();
        const first = await openApproval(server.api, server.prompt());
        // The server now lists the request with another commitment, as if the asking device
        // had made it: what this page saw before it opened is what the reveal is held to.
        const again = await openApproval(server.api, {
            ...server.prompt(),
            approverKey: first.approverKey,
            commitment: random(),
        });
        expect(again).toEqual(first);
        expect(server.sent('open')).toEqual([first.approverKey, first.approverKey]);
        expect(server.sent('deny')).toEqual([]);
    });

    test('a request opened twice at once is opened with one value, and not ended', async () => {
        const server = await asked();
        // The dialog's two mounts in development, or a second press before the first reply.
        const [one, two] = await Promise.all([
            openApproval(server.api, server.prompt()),
            openApproval(server.api, server.prompt()),
        ]);
        expect(two).toEqual(one);
        expect(server.sent('open')).toEqual([one.approverKey, one.approverKey]);
        expect(server.sent('deny')).toEqual([]);
    });

    test('a request whose open got no reply is opened again with the same value', async () => {
        const server = await asked();
        const open = (server.api as unknown as { approvalOpen: AuthApi['approvalOpen'] })
            .approvalOpen;
        // The server takes the value, and its reply is lost on the way back.
        (server.api as unknown as { approvalOpen: unknown }).approvalOpen = async (
            ...sent: Parameters<AuthApi['approvalOpen']>
        ) => {
            await open(...sent);
            throw new Error('offline');
        };
        await expect(openApproval(server.api, server.prompt())).rejects.toThrow('offline');
        (server.api as unknown as { approvalOpen: unknown }).approvalOpen = open;
        // The list now says this device opened it: it did, and it still holds the value.
        const [first] = server.sent('open') as string[];
        const again = await openApproval(server.api, { ...server.prompt(), approverKey: first! });
        expect(again.approverKey).toBe(first);
        expect(server.sent('deny')).toEqual([]);
    });

    test('a value the server chose for this device is refused, and the request ended', async () => {
        const server = await asked();
        // The server answers the open with a value of its own, picked after it saw the commitment.
        const chosen = random();
        (server.api as unknown as { approvalOpen: () => Promise<unknown> }).approvalOpen =
            async () => ({ approverKey: chosen });
        await expect(openApproval(server.api, server.prompt())).rejects.toMatchObject({
            reason: 'mismatch',
        });
        expect(server.sent('deny')).toEqual(['mismatch']);
        expect(server.sent('approve')).toEqual([]);
    });

    test('a request the server says this device opened, when this page opened none, is not taken up', async () => {
        const server = await asked();
        // After a reload this page holds no value of its own for the request: the one the
        // server lists is the server's word, and the code would rest on it.
        await expect(
            openApproval(server.api, { ...server.prompt(), approverKey: random() }),
        ).rejects.toMatchObject({ reason: 'mismatch' });
        expect(server.sent('open')).toEqual([]);
        expect(server.sent('deny')).toEqual(['mismatch']);
    });
});

describe('replies', () => {
    const whole = {
        id: REQUEST,
        purpose: 'login',
        class: 'unknown',
        device: { kind: 'web', name: 'Chrome on Windows' },
        createdAt: '2026-11-14T10:00:00.000Z',
        expiresAt: '2026-11-14T10:05:00.000Z',
        tokenDigest: 'A'.repeat(43),
        commitment: 'B'.repeat(43),
    };

    test('a list keeps only whole requests, and a reveal only with both its values', () => {
        const read = readApprovals({
            approvals: [
                whole,
                { ...whole, commitment: 'short' },
                { ...whole, class: 'everyone' },
                { ...whole, reveal: { deviceSigningKey: 'C'.repeat(43) } },
                'not a request',
            ],
        });
        expect(read).toHaveLength(2);
        expect(read[0]).toMatchObject({
            id: REQUEST,
            approverKey: null,
            reveal: null,
            location: null,
        });
        // A place is a line of words: one that hides a control or direction mark is no place.
        const place = (location: unknown) =>
            readApprovals({ approvals: [{ ...whole, location }] })[0]!.location;
        expect(place('near Lyon, France')).toBe('near Lyon, France');
        expect(place('near Lyon\u202e, France')).toBeNull();
        expect(place('near Lyon\nApprove now')).toBeNull();
        expect(place('x'.repeat(201))).toBeNull();
        expect(place(42)).toBeNull();
        expect(read[1]!.reveal).toBeNull();
        expect(readApprovals('<html>')).toEqual([]);
    });

    test('only the server’s own shapes say the method was started or turned on', () => {
        expect(readDeviceEnrolment({ id: REQUEST, token: TOKEN })).toEqual({
            id: REQUEST,
            token: TOKEN,
        });
        expect(readDeviceEnrolment({ id: REQUEST, token: 'short' })).toBeNull();
        expect(readDeviceConfirmed({ added: true })).toEqual({ added: true });
        expect(readDeviceConfirmed({ backupCodes: ['7KQ2M-9XD4P'] })).toEqual({
            backupCodes: ['7KQ2M-9XD4P'],
        });
        // A proxy's 200 is not a confirmation, and neither is an answer that says both.
        expect(readDeviceConfirmed({ error: 'bad gateway' })).toBeNull();
        expect(readDeviceConfirmed({ added: true, backupCodes: ['7KQ2M-9XD4P'] })).toBeNull();
        expect(readDeviceConfirmed({ backupCodes: [] })).toBeNull();
        expect(readDeviceConfirmed({})).toBeNull();
    });
});
