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
});
