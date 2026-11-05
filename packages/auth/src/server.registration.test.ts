import type * as Emails from '@hushos/emails/server';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Asking for a sign-up or recovery email, against the test database. A link is
 * minted only where it can finish: sign-up for an address with no account,
 * recovery for one with an account. The other two cases get a notice with no
 * token, and nothing is stored. Whichever it is, the caller gets the same answer
 * under the same limits, so the form can't be used to learn who has an account.
 * Messages are composed from the real templates and kept here instead of sent.
 */
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(120);
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM = 'HushOS <hushos@hushos.test>';

type Sent = { to: string; subject: string; html: string; text: string };
const outbox: Sent[] = [];
const mailer = { down: false };

vi.mock('@hushos/emails/server', async (importOriginal) => {
    const emails = await importOriginal<typeof Emails>();
    const post = (message: Sent) => {
        if (mailer.down) throw new Error('The mail server refused the connection.');
        outbox.push(message);
    };
    return {
        ...emails,
        sendVerificationEmail: async (
            to: string,
            url: string,
            purpose: Parameters<typeof emails.composeVerificationEmail>[2],
        ) => post(emails.composeVerificationEmail(to, url, purpose)),
        sendAccountNotice: async (
            to: string,
            input: Parameters<typeof emails.composeAccountNotice>[1],
        ) => post(emails.composeAccountNotice(to, input)),
    };
});

const { closeDatabase, createTestAccount, resetDatabase } = await import('../../db/test/helpers');
const { authRepository, db } = await import('@hushos/db');
const { accountEnrollments } = await import('@hushos/db/schema');
const auth = await import('./server');

const MAYA = 'maya@hush.example';
const NEW = 'new@hush.example';

beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
    mailer.down = false;
});
afterAll(closeDatabase);

const enrollments = async (email: string) =>
    (await db.select().from(accountEnrollments)).filter((row) => row.normalizedEmail === email);

/* What a request answered, or the status it failed with. */
async function ask(email: string, purpose: 'register' | 'recover', address = '203.0.113.7') {
    try {
        return { status: 200, body: await auth.requestRegistrationEmail(email, purpose, address) };
    } catch (error) {
        if (error instanceof auth.AuthError) return { status: error.status, body: error.message };
        throw error;
    }
}

function mailTo(email: string) {
    const mail = outbox.filter((message) => message.to === email);
    expect(mail).toHaveLength(1);
    return mail[0]!;
}

/* The one-time token in a verification email's link, which verifyEmail takes. */
function tokenIn(message: Sent, purpose: 'register' | 'recover') {
    const match = message.text.match(
        new RegExp(`https://hush\\.example/${purpose}/complete#verify=([A-Za-z0-9_-]{43})`),
    );
    expect(match).not.toBeNull();
    return match![1]!;
}

function expectNoToken(message: Sent) {
    for (const body of [message.html, message.text]) {
        expect(body).not.toContain('verify=');
        expect(body).not.toContain('/complete');
    }
}

describe('sign-up', () => {
    test('a new address gets a link that verifies', async () => {
        expect(await ask(NEW, 'register')).toMatchObject({ status: 200 });
        const mail = mailTo(NEW);
        expect(mail.subject).toBe('Verify your email · HushOS');
        const { enrollment } = await auth.verifyEmail(tokenIn(mail, 'register'));
        expect(enrollment).toMatchObject({ email: NEW, purpose: 'register' });
    });

    test('an address with an account stores nothing and is told to sign in, with the same answer', async () => {
        await createTestAccount({ email: MAYA });
        const fresh = await ask(NEW, 'register');
        const taken = await ask(MAYA, 'register');
        expect(taken).toEqual(fresh);
        expect(await enrollments(MAYA)).toEqual([]);
        expect(await enrollments(NEW)).toHaveLength(1);

        const mail = mailTo(MAYA);
        expect(mail.subject).toBe('You already have an account · HushOS');
        expectNoToken(mail);
        expect(mail.text).toContain('You already have a HushOS account.');
        expect(mail.text).toContain('https://hush.example/login');
        expect(mail.text).toContain('https://hush.example/recover');
        expect(mail.text).not.toContain('https://hush.example/register');
    });

    test('a suspended account still counts as one', async () => {
        const { userId } = await createTestAccount({ email: MAYA });
        await authRepository.setUserSuspended(userId, true);
        await ask(MAYA, 'register');
        expect(await enrollments(MAYA)).toEqual([]);
        expect(mailTo(MAYA).subject).toBe('You already have an account · HushOS');
    });
});

describe('recovery', () => {
    test('an address with an account gets a link that verifies', async () => {
        await createTestAccount({ email: MAYA });
        expect(await ask(MAYA, 'recover')).toMatchObject({ status: 200 });
        const mail = mailTo(MAYA);
        expect(mail.subject).toBe('Recover your account · HushOS');
        const { enrollment } = await auth.verifyEmail(tokenIn(mail, 'recover'));
        expect(enrollment).toMatchObject({ email: MAYA, purpose: 'recover' });
    });

    test('an address with no account stores nothing and is offered sign-up, with the same answer', async () => {
        await createTestAccount({ email: MAYA });
        const known = await ask(MAYA, 'recover');
        const unknown = await ask(NEW, 'recover');
        expect(unknown).toEqual(known);
        expect(await enrollments(NEW)).toEqual([]);
        expect(await enrollments(MAYA)).toHaveLength(1);

        const mail = mailTo(NEW);
        expect(mail.subject).toBe('No account uses this email · HushOS');
        expectNoToken(mail);
        expect(mail.text).toContain('There’s no HushOS account for this email.');
        expect(mail.text).toContain('https://hush.example/register');
        expect(mail.text).not.toContain('https://hush.example/login');
    });
});

test('the address is matched as stored, whatever its case and surrounding space', async () => {
    await createTestAccount({ email: MAYA });
    await ask('  Maya@HUSH.example ', 'register');
    await ask(' MAYA@hush.EXAMPLE', 'recover');
    const [notice, recovery] = outbox;
    expect(outbox).toHaveLength(2);
    expect(notice).toMatchObject({ to: MAYA, subject: 'You already have an account · HushOS' });
    expect(recovery).toMatchObject({ to: MAYA, subject: 'Recover your account · HushOS' });
    expect(await enrollments(MAYA)).toEqual([
        expect.objectContaining({ purpose: 'recover', email: MAYA }),
    ]);
});

test('the per-address limit holds whether or not an account exists', async () => {
    await createTestAccount({ email: MAYA });
    for (const [email, purpose] of [
        [MAYA, 'register'],
        [NEW, 'register'],
        [MAYA, 'recover'],
        [NEW, 'recover'],
    ] as const) {
        // A different client address each time: only the email's own limit is in play.
        const answers = [];
        for (let attempt = 1; attempt <= 4; attempt++)
            answers.push((await ask(email, purpose, `198.51.100.${attempt}`)).status);
        expect(answers, `${purpose} for ${email}`).toEqual([200, 200, 200, 429]);
    }
});

test('a mail failure answers 503 on every path and leaves nothing stored', async () => {
    await createTestAccount({ email: MAYA });
    mailer.down = true;
    const answers = await Promise.all([
        ask(NEW, 'register'),
        ask(MAYA, 'register'),
        ask(MAYA, 'recover'),
        ask(NEW, 'recover'),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([503, 503, 503, 503]);
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
    expect(await db.select().from(accountEnrollments)).toEqual([]);
});
