import type * as Emails from '@hushos/emails/server';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * A share's email, against the test database. Sharing again with the same person updates the
 * share in place and asks for another email, so replaying one request could send without end,
 * from whatever name the sharer gave themselves, through the operator's mail. The emails stop at
 * a few per pair and a few dozen per sharer an hour; the share itself is never refused for it.
 */
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(120);
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';

const outbox: { to: string }[] = [];

vi.mock('@hushos/emails/server', async (importOriginal) => {
    const emails = await importOriginal<typeof Emails>();
    return {
        ...emails,
        sendShareEmail: async (to: string) => {
            outbox.push({ to });
        },
    };
});

const { closeDatabase, createTestAccount, resetDatabase } = await import('../../db/test/helpers');
const auth = await import('./server');

beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
});

afterAll(closeDatabase);

describe('a share’s email', () => {
    test('goes three times an hour from one person to another, then is skipped', async () => {
        const sharer = await createTestAccount();
        const friend = await createTestAccount();
        const answers = [];
        for (let n = 0; n < 6; n++)
            answers.push(await auth.notifyShare(sharer.userId, friend.userId, 'viewer'));
        expect(answers).toEqual(['sent', 'sent', 'sent', 'limited', 'limited', 'limited']);
        expect(outbox).toHaveLength(3);
        expect(outbox.every((message) => message.to === friend.email)).toBe(true);
    });

    test('the sharer’s cap holds across everyone they share with', async () => {
        const sharer = await createTestAccount();
        const people = await Promise.all(Array.from({ length: 55 }, () => createTestAccount()));
        const answers = [];
        for (const person of people)
            answers.push(await auth.notifyShare(sharer.userId, person.userId, 'editor'));
        expect(answers.filter((answer) => answer === 'sent')).toHaveLength(50);
        expect(answers.slice(50)).toEqual(Array(5).fill('limited'));
        expect(outbox).toHaveLength(50);
    });

    test('one sharer reaching their cap leaves another’s emails alone', async () => {
        const noisy = await createTestAccount();
        const quiet = await createTestAccount();
        const friend = await createTestAccount();
        for (let n = 0; n < 4; n++) await auth.notifyShare(noisy.userId, friend.userId, 'viewer');
        expect(await auth.notifyShare(quiet.userId, friend.userId, 'viewer')).toBe('sent');
    });
});
