import type * as Emails from '@hushos/emails/server';
import { describe, expect, test, vi } from 'vitest';

/*
 * Device security notices never carry the device's name (docs/devices-design.md,
 * Notices). A device names itself, so whoever signed in writes it, and in a
 * security email from HushOS a name like the one below is a phishing line.
 * Here a device gives itself that name through the real registration path, the
 * notices are composed from the real templates, and each message is read whole:
 * subject, HTML and text.
 */
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(120);
process.env.TRUSTED_PROXY_HEADER = 'x-forwarded-for';
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';
process.env.TWO_STEP_ENABLED = 'true';

// The longest a device name may be (40), in the characters it may use.
const HOSTILE = 'HushOS Support call 5550100 evil.example';
// Each part a reader would act on; "HushOS" is in every notice by right.
const DISTINCTIVE = ['Support', 'call', '5550100', 'evil.example', 'evil'];

// As a word, in any case: the template's own "supported-color-schemes" is not the name's "Support".
const word = (piece: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${piece.replaceAll('.', '\\.')}(?![\\p{L}\\p{N}])`, 'iu');

const USER = {
    id: '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5',
    email: 'owner@hush.example',
    name: 'Owner',
    credentialVersion: 1,
};
const DEVICE_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TOKEN = 's'.repeat(43);
const device: { kind: string | null; name: string | null } = { kind: null, name: null };
const sent: { subject: string; html: string; text: string }[] = [];

// The emails package as it is, but for the last step: the message composed from the real
// templates is kept here instead of going to a mail server.
vi.mock('@hushos/emails/server', async (importOriginal) => {
    const emails = await importOriginal<typeof Emails>();
    return {
        ...emails,
        sendSecurityNotice: async (
            to: string,
            input: Parameters<typeof emails.composeSecurityNotice>[1],
        ) => {
            sent.push(emails.composeSecurityNotice(to, input));
        },
    };
});

// A method named as an intruder would name it, served wherever a method's row is read.
const factor = () => ({
    id: '3e8b3a4f-9d7b-4f74-8d76-5e4c7abc2b43',
    userId: USER.id,
    kind: 'totp',
    name: HOSTILE,
    createdAt: new Date(),
    confirmedAt: new Date(),
    lastUsedAt: null,
});

vi.mock('@hushos/db', () => {
    const row = () => ({
        id: DEVICE_ID,
        kind: device.kind,
        name: device.name,
        approvedBy: null,
        approvedByDeviceId: null,
        createdAt: new Date(),
        lastSeenAt: new Date(),
    });
    return {
        adminRepository: {},
        groupsRepository: {},
        twoStepRepository: {
            getTwoStep: async () => ({
                on: true,
                factors: [factor()],
                state: null,
                backupCodes: [],
            }),
            renameFactor: async () => true,
        },
        authRepository: {
            getSession: async () => ({ user: USER, device: { id: DEVICE_ID } }),
            getUserById: async () => USER,
            consumeRateLimit: async () => true,
            registerDevice: async (input: { kind: string; name: string }) => {
                device.kind = input.kind;
                device.name = input.name;
                return { status: 'ok', device: { ...row(), signedIn: true, current: true } };
            },
            listDevices: async () => [{ ...row(), signedIn: true, current: true }],
        },
    };
});

const auth = await import('./server');
const twoStep = await import('./two-step');

describe('device security notices', () => {
    test('never carry the name the device gave itself, in the subject, the HTML or the text', async () => {
        // The device describes itself, as a signed-in client does; the name is accepted as is.
        await auth.registerDevice(TOKEN, { kind: 'android', name: HOSTILE });
        expect(device.name).toBe(HOSTILE);

        for (const kind of [
            'new-device',
            'device-removed',
            'devices-removed',
            'password-attempts',
        ] as const)
            await auth.notifyDevices(USER.id, kind, kind === 'devices-removed' ? 2 : undefined);

        expect(sent).toHaveLength(4);
        for (const message of sent) {
            // The notice did go out, to the owner, about this account: a blank one would pass too.
            expect(message.subject).toMatch(/· HushOS$/);
            expect(message.html).toContain('https://hush.example/app/account#devices');
            for (const part of [message.subject, message.html, message.text]) {
                expect(part.toLowerCase()).not.toContain(HOSTILE.toLowerCase());
                for (const piece of DISTINCTIVE) expect(part).not.toMatch(word(piece));
            }
        }
    });

    test('about the second step never carry a method’s name or a device’s, whatever each was called', async () => {
        sent.length = 0;
        await auth.registerDevice(TOKEN, { kind: 'web', name: HOSTILE });
        // The method carries the name too, set through the real rename path.
        expect(
            (await auth.renameTwoStepMethod(TOKEN, factor().id, { name: HOSTILE })).method.name,
        ).toBe(HOSTILE);

        const kinds = [
            ['two-step-on', { method: 'totp' }, 'An authenticator app'],
            ['two-step-on', { method: 'webauthn' }, 'A security key'],
            ['two-step-off', {}, 'Two-step sign-in is off.'],
            ['two-step-method-added', { method: 'totp' }, 'An authenticator app'],
            ['two-step-method-added', { method: 'webauthn' }, 'A security key'],
            ['two-step-method-removed', { method: 'totp' }, 'An authenticator app'],
            ['two-step-method-removed', { method: 'webauthn' }, 'A security key'],
            ['backup-codes-new', {}, 'The old codes no longer work.'],
            ['backup-code-used', { count: 7 }, '7'],
            ['phrase-used', {}, 'Keep the phrase apart from your password'],
            ['two-step-failed', {}, 'Change your password.'],
            ['totp-frozen', {}, 'Devices you already use are not affected.'],
            ['totp-frozen-device', {}, 'Your other devices are not affected.'],
        ] as const;
        for (const [kind, detail] of kinds) twoStep.notifyTwoStep(USER.id, kind, detail);
        await twoStep.twoStepNoticesSettled();
        // A new device's sign-in, by each thing that can answer the step.
        const signedInWith = {
            totp: 'Your password and an authenticator code',
            webauthn: 'Your password and a security key',
            backup: 'Your password and a backup code',
            phrase: 'Your password and your recovery phrase',
        } as const;
        for (const method of Object.keys(signedInWith) as (keyof typeof signedInWith)[])
            await auth.notifyDevices(USER.id, 'new-device', undefined, new Date(), method);
        await auth.notifyDevices(USER.id, 'new-device');

        const says = [
            ...kinds.map(([, , line]) => line),
            ...Object.values(signedInWith),
            'Your password',
        ];
        expect(sent).toHaveLength(says.length);
        for (const [index, message] of sent.entries()) {
            expect(message.subject).toMatch(/· HushOS$/);
            expect(message.html).toMatch(
                /https:\/\/hush\.example\/app\/account#(two-step|devices)/,
            );
            // What the design says each one says, in both the HTML and the text.
            expect(message.text, message.subject).toContain(says[index]);
            expect(message.html, message.subject).toContain(says[index]);
            for (const part of [message.subject, message.html, message.text]) {
                expect(part.toLowerCase()).not.toContain(HOSTILE.toLowerCase());
                for (const piece of DISTINCTIVE)
                    expect(part, message.subject).not.toMatch(word(piece));
                // No placeholder left unfilled.
                expect(part).not.toMatch(/\{\{|\}\}/);
            }
        }
        // The plain new-device notice names the password alone, as it always has.
        expect(sent.at(-1)!.text).not.toMatch(/Your password and/);
    });
});
