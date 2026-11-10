import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
    hydrated,
    landedOnHome,
    mailSubjects,
    newPage,
    PASSWORD,
    registerAccount,
} from './helpers';

/*
 * Two-step sign-in (docs/two-step-design.md), through the real screens:
 * turning it on with the key read off the page and a code computed from it,
 * the other devices signed out with it, then every way a sign-in answers the
 * step (a code, a backup code, the recovery phrase) and every way it does not
 * (a slip, a wrong code, a step that ran out, a client too old to answer), a
 * password change behind the step, new backup codes, removing the method,
 * deleting the account, and the unlock of a browser that was left signed in.
 *
 * Whether the server offers it is this run's TWO_STEP_ENABLED (from the
 * environment or .env, as the server reads it; off unless `true`). The server
 * must agree: one that says otherwise fails the file rather than letting it
 * skip. With it off, the one test left checks that Account draws nothing of it.
 */

const twoStepOn = process.env.TWO_STEP_ENABLED === 'true';

/* RFC 6238 with the defaults authenticator apps use (SHA-1, six digits, 30 seconds), as an app computes it. */
function base32(text: string) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of text.replace(/\s/g, '').toUpperCase())
        bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
    const bytes = bits.match(/.{8}/g) ?? [];
    return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}
function totp(secret: string, step: number) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac('sha1', base32(secret)).update(counter).digest();
    const offset = mac[mac.length - 1]! & 0x0f;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);

/*
 * An authenticator app for one secret. The server takes each time step once, and the steps
 * either side of now: `next` gives the code for the earliest step not used yet, waiting for
 * the clock only when two codes ahead have been spent.
 */
function authenticator(secret: string) {
    let last = 0;
    return {
        async next() {
            const step = Math.max(last + 1, stepNow());
            while (step > stepNow() + 1) await new Promise((resolve) => setTimeout(resolve, 500));
            last = step;
            return totp(secret, step);
        },
        /* Six digits that are no code of this app's around now. */
        wrong() {
            const near = new Set(
                [-2, -1, 0, 1, 2].map((offset) => totp(secret, stepNow() + offset)),
            );
            let guess = 100_000;
            while (near.has(String(guess))) guess++;
            return String(guess);
        },
    };
}

const section = (page: Page) => page.locator('#two-step');
const dialog = (page: Page) => page.getByRole('dialog');
const codeField = (scope: Page | Locator) => scope.getByLabel('Code from your authenticator app');
const backupField = (scope: Page | Locator) => scope.getByLabel('Backup code', { exact: true });
const subjects = async (email: string, subject: RegExp) =>
    (await mailSubjects(email)).filter((value) => subject.test(value)).length;

async function openAccount(page: Page) {
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible({
        timeout: 60_000,
    });
}

/* The password half of a sign-in: what follows is Home, or the step. */
async function enterPassword(page: Page, email: string, password = PASSWORD) {
    await page.goto('/login', { waitUntil: 'networkidle' });
    const emailField = page.getByRole('textbox', { name: /email/i });
    await hydrated(emailField);
    await emailField.fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(password);
    await field.press('Enter');
}

/* Types an answer to the step and waits for the server's reply to it. */
async function answer(page: Page, field: Locator, value: string) {
    await field.fill(value);
    await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/auth/login/two-step')),
        field.press('Enter'),
    ]);
}

async function signOut(page: Page) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.waitForLoadState('networkidle');
}

/* Turns two-step sign-in on from the account page and returns the app and the ten codes. */
async function turnOn(page: Page, options: { keepOthers?: boolean } = {}) {
    await openAccount(page);
    await section(page).getByRole('button', { name: 'Turn on' }).click();
    const setup = dialog(page);
    await setup.getByLabel('Your password', { exact: true }).fill(PASSWORD);
    await setup.getByRole('button', { name: 'Continue' }).click();
    await expect(setup.getByRole('heading', { name: 'Set up your authenticator app' })).toBeVisible(
        { timeout: 60_000 },
    );
    const app = authenticator((await setup.locator('[data-setup-key]').innerText()).trim());
    if (options.keepOthers) {
        const others = setup.getByRole('checkbox', { name: /Sign out my other devices/ });
        await others.click();
        await expect(others).not.toBeChecked();
    }
    await setup.getByLabel(/Enter the code the app shows/).fill(await app.next());
    await setup.getByRole('button', { name: 'Turn on' }).click();
    const list = setup.getByRole('list', { name: 'Backup codes' });
    await expect(list).toBeVisible({ timeout: 60_000 });
    const codes = await list.getByRole('listitem').allInnerTexts();
    await setup.getByRole('button', { name: 'I’ve saved them' }).click();
    await expect(setup).toHaveCount(0);
    return { app, codes };
}

test('the server offers two-step sign-in exactly when this run says so, and Account draws nothing of it otherwise', async ({
    browser,
    request,
}) => {
    test.setTimeout(300_000);
    // Without a session the route answers 401 where it is offered and 501 where it is not.
    const answer = await request.get('/api/auth/two-step');
    expect(
        answer.status(),
        `TWO_STEP_ENABLED is ${twoStepOn ? 'on' : 'off'} here, and the server must say the same`,
    ).toBe(twoStepOn ? 401 : 501);
    if (twoStepOn) return;
    // Off: nothing that could not work is shown, and the place the security notices link to
    // (/app/account#two-step) is still there.
    const page = await newPage(browser);
    await registerAccount(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.getByText(/two-step/i)).toHaveCount(0);
    await expect(section(page)).toHaveCount(1);
    await expect(section(page)).toBeHidden();
    await page.context().close();
});

test.describe('an account with two-step sign-in', () => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.describe.configure({ mode: 'serial' });

    let a: Page;
    let b: Page;
    let email: string;
    let phrase: string;
    let password = PASSWORD;
    let app: ReturnType<typeof authenticator>;
    let codes: string[];

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300_000);
        a = await newPage(browser);
        ({ email } = await registerAccount(a));
        // The recovery phrase, as the person would have it written down.
        await a.goto('/app/recovery-key', { waitUntil: 'networkidle' });
        const words = a.getByRole('list', { name: 'Recovery phrase' });
        await expect(words).toBeVisible({ timeout: 60_000 });
        phrase = (await words.getByRole('listitem').allInnerTexts())
            .map((item) => item.split(/\s+/).at(-1))
            .join(' ');
        // A second browser, signed in with the password alone.
        b = await newPage(browser);
        await enterPassword(b, email);
        await landedOnHome(b);
    });
    test.afterAll(async () => {
        await a?.context().close();
        await b?.context().close();
    });

    test('turning it on takes the password and a code from the app, shows ten codes once, and signs the other devices out', async () => {
        test.setTimeout(240_000);
        await openAccount(a);
        // What it is, and what it is not, before anything is turned on.
        await expect(section(a)).toContainText(
            'A second step stops someone who has your password from signing in. It doesn’t change how your files are encrypted.',
        );
        await section(a).getByRole('button', { name: 'Turn on' }).click();
        const setup = dialog(a);
        // The password first: a session alone cannot turn it on.
        await setup.getByLabel('Your password', { exact: true }).fill('not-my-password-at-all');
        await setup.getByRole('button', { name: 'Continue' }).click();
        await expect(setup).toContainText('isn’t right', { timeout: 60_000 });
        await setup.getByLabel('Your password', { exact: true }).fill(PASSWORD);
        await setup.getByRole('button', { name: 'Continue' }).click();
        await expect(
            setup.getByRole('heading', { name: 'Set up your authenticator app' }),
        ).toBeVisible({ timeout: 60_000 });
        // The code to scan, and the same key as text for typing.
        await expect(
            setup.getByRole('img', { name: 'Code for your authenticator app' }),
        ).toBeVisible();
        const key = (await setup.locator('[data-setup-key]').innerText()).trim();
        expect(key).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
        app = authenticator(key);
        // Another device is signed in, so signing it out is offered, and ticked.
        await expect(
            setup.getByRole('checkbox', { name: /Sign out my other devices/ }),
        ).toBeChecked();
        const code = setup.getByLabel(/Enter the code the app shows/);
        await expect(code).toHaveAttribute('inputmode', 'numeric');
        await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
        // A wrong code turns nothing on.
        await code.fill(app.wrong());
        await setup.getByRole('button', { name: 'Turn on' }).click();
        await expect(setup.getByRole('alert')).toHaveText(
            'That code didn’t work. Codes change every 30 seconds.',
            { timeout: 60_000 },
        );
        await code.fill(await app.next());
        await setup.getByRole('button', { name: 'Turn on' }).click();

        // Ten backup codes, once: only the dialog's own button closes it.
        await expect(setup.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible({
            timeout: 60_000,
        });
        codes = await setup
            .getByRole('list', { name: 'Backup codes' })
            .getByRole('listitem')
            .allInnerTexts();
        expect(codes).toHaveLength(10);
        expect(new Set(codes).size).toBe(10);
        for (const each of codes)
            expect(each).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        await a.keyboard.press('Escape');
        await expect(setup).toBeVisible();
        // The file holds the codes the page showed, and says whose they are.
        const [download] = await Promise.all([
            a.waitForEvent('download'),
            setup.getByRole('button', { name: 'Download' }).click(),
        ]);
        expect(download.suggestedFilename()).toBe('hushos-backup-codes.txt');
        const file = readFileSync((await download.path())!, 'utf8');
        for (const each of codes) expect(file).toContain(each);
        expect(file).toContain(email);
        await setup.getByRole('button', { name: 'I’ve saved them' }).click();
        await expect(setup).toHaveCount(0);

        // Settings now lists the app and the codes left, and says what happened.
        await expect(section(a)).toContainText(
            'Two-step sign-in is on. Your other devices were signed out.',
        );
        const methods = section(a).getByRole('list', { name: 'Your second steps' });
        await expect(methods.getByRole('listitem')).toHaveCount(1);
        await expect(methods).toContainText('Authenticator app');
        await expect(section(a)).toContainText('10 backup codes left');
        await expect(section(a).getByRole('button', { name: 'Turn on' })).toHaveCount(0);
        await expect
            .poll(() => subjects(email, /^Two-step sign-in is on · /), { timeout: 30_000 })
            .toBe(1);

        // The other browser never passed the step: it is signed out, as a removed device is.
        await b.goto('/app', { waitUntil: 'networkidle' });
        await expect(b).toHaveURL(/\/login/, { timeout: 60_000 });
        await expect(b.getByText('This browser was removed from your account.')).toBeVisible({
            timeout: 30_000,
        });
    });

    test('a sign-in asks for a code after the password: a slip costs nothing, a wrong code is refused, the right one opens the account', async () => {
        test.setTimeout(180_000);
        let answers = 0;
        b.on('request', (request) => {
            if (request.url().endsWith('/api/auth/login/two-step')) answers++;
        });
        await enterPassword(b, email);
        await expect(b.getByRole('heading', { name: 'Enter your code' })).toBeVisible({
            timeout: 60_000,
        });
        // The password alone opened nothing.
        await expect(b).toHaveURL(/\/login/);
        const code = codeField(b);
        await expect(code).toBeFocused();
        await expect(code).toHaveAttribute('inputmode', 'numeric');
        await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
        // The other ways to answer are offered, by name.
        await expect(b.getByRole('button', { name: 'Use a backup code' })).toBeVisible();
        await expect(b.getByRole('button', { name: 'Use your recovery phrase' })).toBeVisible();

        // Five digits is a slip of the hand: said at once, and never sent.
        await code.fill('12345');
        await code.press('Enter');
        await expect(b.getByRole('alert')).toHaveText(
            'Enter the six digits your authenticator app shows.',
        );
        expect(answers).toBe(0);
        await expect(code).toBeFocused();

        // A wrong code is refused, and the step is asked again without the password.
        await answer(b, code, app.wrong());
        await expect(b.getByRole('alert')).toHaveText(
            'That code didn’t work. Codes change every 30 seconds.',
        );
        await expect(b).toHaveURL(/\/login/);
        await expect(code).toBeFocused();
        // The refusal was about that code: choosing another way to answer does not carry it along.
        await b.getByRole('button', { name: 'Use a backup code' }).click();
        await expect(backupField(b)).toBeFocused();
        await expect(b.getByRole('alert')).toHaveCount(0);
        await b.getByRole('button', { name: 'Use your authenticator app' }).click();

        // Typed the way the app shows it, with a space.
        const right = await app.next();
        await code.fill(`${right.slice(0, 3)} ${right.slice(3)}`);
        await code.press('Enter');
        await landedOnHome(b);
        expect(answers).toBe(2);

        await openAccount(b);
        await expect(section(b).getByRole('list', { name: 'Your second steps' })).toContainText(
            'Last used today',
        );
    });

    test('a client too old to answer the step is told to update, and gets nothing', async ({
        browser,
    }) => {
        test.setTimeout(120_000);
        const old = await newPage(browser);
        // An older client: it never says it can answer a second step.
        await old.route('**/api/auth/login/finish', async (route) => {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            delete body.twoStep;
            await route.continue({ postData: JSON.stringify(body) });
        });
        await enterPassword(old, email);
        await expect(old.getByRole('alert')).toHaveText(
            'Update HushOS to sign in. This account asks for a second step.',
            { timeout: 60_000 },
        );
        await expect(old.getByRole('button', { name: 'Reload this page' })).toBeVisible();
        await old.unroute('**/api/auth/login/finish');
        await old.goto('/app', { waitUntil: 'networkidle' });
        await expect(old).toHaveURL(/\/login/, { timeout: 60_000 });
        await old.context().close();
    });

    test('a step that runs out, or takes five wrong answers, goes back to the password', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const page = await newPage(browser);
        // A step token with four seconds left, as one left waiting for five minutes has.
        await page.route('**/api/auth/login/finish', async (route) => {
            const response = await route.fetch();
            const json = (await response.json()) as { twoStep?: { expiresAt: string } };
            if (json.twoStep) json.twoStep.expiresAt = new Date(Date.now() + 4_000).toISOString();
            await route.fulfill({ response, json });
        });
        await enterPassword(page, email);
        await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByRole('alert')).toHaveText('Your sign-in timed out. Sign in again.', {
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        await page.unroute('**/api/auth/login/finish');

        // The form kept what was typed: the password again, then five wrong codes.
        await page.locator('input[autocomplete=current-password]').press('Enter');
        const code = codeField(page);
        await expect(code).toBeVisible({ timeout: 60_000 });
        for (let wrong = 1; wrong <= 4; wrong++) {
            await answer(page, code, app.wrong());
            await expect(page.getByRole('alert')).toHaveText(
                'That code didn’t work. Codes change every 30 seconds.',
            );
        }
        await answer(page, code, app.wrong());
        await expect(page.getByRole('alert')).toHaveText('Too many wrong answers. Sign in again.', {
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
        await page.goto('/app', { waitUntil: 'networkidle' });
        await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
        // Five failed steps after a right password: the account's email hears of it.
        await expect
            .poll(() => subjects(email, /^Someone signed in with your password but did not pass/), {
                timeout: 30_000,
            })
            .toBe(1);
        await page.context().close();
    });

    test('a backup code signs in once, and the sign-in screen says when few are left', async ({
        browser,
    }) => {
        test.setTimeout(240_000);
        const page = await newPage(browser);
        await enterPassword(page, email);
        await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible({
            timeout: 60_000,
        });
        await page.getByRole('button', { name: 'Use a backup code' }).click();
        await expect(page.getByRole('heading', { name: 'Use a backup code' })).toBeVisible();
        const field = backupField(page);
        await expect(field).toBeFocused();
        // Typed in lower case with a space, as people do.
        await field.fill(codes[0]!.toLowerCase().replace('-', ' '));
        await field.press('Enter');
        await landedOnHome(page);
        await openAccount(page);
        await expect(section(page)).toContainText('9 backup codes left');
        await expect
            .poll(() => subjects(email, /^A backup code was used · /), { timeout: 30_000 })
            .toBe(1);

        // The same code a second time is a wrong answer.
        await signOut(page);
        await enterPassword(page, email);
        await page.getByRole('button', { name: 'Use a backup code' }).click();
        await answer(page, backupField(page), codes[0]!);
        await expect(page.getByRole('alert')).toHaveText(
            'That backup code didn’t work. Each code works once.',
        );
        // With two left after this sign-in (the count is the server's; here it is told two),
        // the screen suggests a new set before the app opens.
        await page.route('**/api/auth/two-step', async (route) => {
            const response = await route.fetch();
            await route.fulfill({
                response,
                json: { ...((await response.json()) as object), backupCodesLeft: 2 },
            });
        });
        await backupField(page).fill(codes[1]!);
        await backupField(page).press('Enter');
        await expect(page.getByRole('heading', { name: '2 backup codes left' })).toBeVisible({
            timeout: 60_000,
        });
        await page.unroute('**/api/auth/two-step');
        await page.getByRole('link', { name: 'Make new codes' }).click();
        await expect(page).toHaveURL(/\/app\/account#two-step$/, { timeout: 60_000 });
        await expect(section(page)).toContainText('8 backup codes left', { timeout: 60_000 });
        await page.context().close();
    });

    test('the recovery phrase answers the step on a browser that kept nothing, and opens Account on two-step sign-in', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const page = await newPage(browser);
        await enterPassword(page, email);
        await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible({
            timeout: 60_000,
        });
        await page.getByRole('button', { name: 'Use your recovery phrase' }).click();
        await expect(page.getByRole('heading', { name: 'Use your recovery phrase' })).toBeVisible();
        const field = page.getByLabel('Recovery phrase', { exact: true });
        await expect(field).toBeFocused();
        // A word short: said on this device, nothing sent.
        await field.fill(phrase.split(' ').slice(0, 23).join(' '));
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('not a valid recovery phrase');
        // A real phrase that is not this account's: the server refuses it.
        await field.fill(`${'abandon '.repeat(23)}art`);
        await Promise.all([
            page.waitForResponse((response) => response.url().endsWith('/api/auth/login/two-step')),
            page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
        await expect(page.getByRole('alert')).toHaveText(
            'That recovery phrase doesn’t match this account. Check each word and try again.',
        );
        await field.fill(phrase);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page).toHaveURL(/\/app\/account#two-step$/, { timeout: 60_000 });
        await expect(section(page)).toContainText('You signed in with your recovery phrase', {
            timeout: 60_000,
        });
        await expect
            .poll(() => subjects(email, /^Your recovery phrase was used for the second step · /), {
                timeout: 30_000,
            })
            .toBe(1);
        await page.context().close();
    });

    test('changing the password asks for the step before anything changes', async () => {
        test.setTimeout(240_000);
        const next = 'a-new-password-behind-the-step-4';
        await openAccount(a);
        await a.getByRole('button', { name: 'Change password' }).click();
        const change = dialog(a);
        await change.getByLabel('Current password', { exact: true }).fill(PASSWORD);
        await change.getByLabel('New password', { exact: true }).fill(next);
        await change.getByLabel('Confirm new password', { exact: true }).fill(next);
        await change.getByRole('button', { name: 'Change password' }).click();
        // The same dialog asks for the second step.
        await expect(change).toContainText('Confirm it’s you with your second step.', {
            timeout: 60_000,
        });
        const code = codeField(change);
        await expect(code).toBeFocused();
        // A wrong code changes nothing, and the dialog asks again.
        await code.fill(app.wrong());
        await change.getByRole('button', { name: 'Change password' }).click();
        await expect(change.getByRole('alert')).toHaveText(
            'That code didn’t work. Codes change every 30 seconds.',
            { timeout: 60_000 },
        );
        await expect(a).toHaveURL(/\/app\/account/);
        // Backing out returns to the form as it was, and leaves this browser unlocked (behind the
        // dialog, hidden from roles while it is open).
        await change.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(change.getByLabel('Current password', { exact: true })).toBeFocused();
        await expect(change.getByLabel('New password', { exact: true })).toHaveValue(next);
        await expect(a.locator('button', { hasText: 'Lock on this browser' })).toBeVisible({
            timeout: 60_000,
        });
        await change.getByRole('button', { name: 'Change password' }).click();
        await expect(change).toContainText('Confirm it’s you with your second step.', {
            timeout: 60_000,
        });
        // A backup code answers a change as it answers a sign-in.
        await change.getByRole('button', { name: 'Use a backup code' }).click();
        await backupField(change).fill(codes[2]!);
        await change.getByRole('button', { name: 'Change password' }).click();
        // The change ends every session; this browser signs in again, with the step.
        await expect(a).toHaveURL(/\/login/, { timeout: 120_000 });
        await expect(a.getByText('Password changed')).toBeVisible();
        password = next;
        await enterPassword(a, email, password);
        await expect(a.getByRole('heading', { name: 'Enter your code' })).toBeVisible({
            timeout: 60_000,
        });
        await codeField(a).fill(await app.next());
        await codeField(a).press('Enter');
        await landedOnHome(a);
    });

    test('new backup codes take the password and the step, and replace the old ones', async () => {
        test.setTimeout(240_000);
        await openAccount(a);
        await expect(section(a)).toContainText('7 backup codes left');
        await section(a).getByRole('button', { name: 'Make new codes' }).click();
        const make = dialog(a);
        await make.getByLabel('Your password', { exact: true }).fill(password);
        await make.getByRole('button', { name: 'Make new codes' }).click();
        await expect(make).toContainText('Confirm it’s you with your second step.', {
            timeout: 60_000,
        });
        await make.getByRole('button', { name: 'Use a backup code' }).click();
        await backupField(make).fill(codes[3]!);
        await make.getByRole('button', { name: 'Make new codes' }).click();
        const list = make.getByRole('list', { name: 'Backup codes' });
        await expect(list).toBeVisible({ timeout: 60_000 });
        const fresh = await list.getByRole('listitem').allInnerTexts();
        expect(fresh).toHaveLength(10);
        for (const each of fresh) expect(codes).not.toContain(each);
        await make.getByRole('button', { name: 'I’ve saved them' }).click();
        await expect(make).toHaveCount(0);
        await expect(section(a)).toContainText('10 backup codes left');
        // A code from the old set no longer answers anything (the removal below tries one).
        codes = [codes[4]!, ...fresh];
    });

    test('renaming a method, then removing it with the password and the step, turns two-step sign-in off', async () => {
        test.setTimeout(240_000);
        await openAccount(a);
        const methods = section(a).getByRole('list', { name: 'Your second steps' });
        await methods.getByRole('button', { name: 'Rename Authenticator app' }).click();
        const rename = dialog(a);
        await expect(rename).toContainText('Names aren’t encrypted.');
        await rename.getByLabel('Name').fill('My phone');
        await rename.getByRole('button', { name: 'Save name' }).click();
        await expect(rename).toHaveCount(0);
        await expect(methods).toContainText('My phone');

        await methods.getByRole('button', { name: 'Remove My phone' }).click();
        const remove = dialog(a);
        await expect(remove).toContainText('This turns two-step sign-in off.');
        await remove.getByLabel('Your password', { exact: true }).fill(password);
        await remove.getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(remove).toContainText('Confirm it’s you with your second step.', {
            timeout: 60_000,
        });
        // A code from the set that was replaced: refused, and nothing is removed.
        await remove.getByRole('button', { name: 'Use a backup code' }).click();
        await backupField(remove).fill(codes[0]!);
        await remove.getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(remove.getByRole('alert')).toHaveText(
            'That backup code didn’t work. Each code works once.',
            { timeout: 60_000 },
        );
        await backupField(remove).fill(codes[1]!);
        await remove.getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(remove).toHaveCount(0, { timeout: 60_000 });
        await expect(section(a).getByRole('button', { name: 'Turn on' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(methods).toHaveCount(0);
        await expect
            .poll(() => subjects(email, /^Two-step sign-in is off · /), { timeout: 30_000 })
            .toBe(1);

        // The password alone signs in again.
        await enterPassword(b, email, password);
        await landedOnHome(b);
    });
});

test('deleting an account with two-step sign-in asks for the step, and a wrong code deletes nothing', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(300_000);
    const page = await newPage(browser);
    const { email } = await registerAccount(page);
    await openAccount(page);
    // No other device is signed in, so there is none to offer to sign out.
    await section(page).getByRole('button', { name: 'Turn on' }).click();
    await dialog(page).getByLabel('Your password', { exact: true }).fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(page).getByRole('heading', { name: 'Set up your authenticator app' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    const { app } = await turnOn(page);

    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByRole('button', { name: 'Delete account' }).click();
    const confirm = dialog(page);
    await confirm.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await confirm.getByLabel('Type DELETE to confirm').fill('DELETE');
    await confirm.getByRole('button', { name: 'Delete forever' }).click();
    await expect(confirm).toContainText('Confirm it’s you with your second step.', {
        timeout: 60_000,
    });
    await codeField(confirm).fill(app.wrong());
    await confirm.getByRole('button', { name: 'Delete forever' }).click();
    await expect(confirm.getByRole('alert')).toHaveText(
        'That code didn’t work. Codes change every 30 seconds.',
        { timeout: 60_000 },
    );
    await expect(page).toHaveURL(/\/app\/account/);
    await codeField(confirm).fill(await app.next());
    await confirm.getByRole('button', { name: 'Delete forever' }).click();
    await expect(page).toHaveURL(/\/account-deleted/, { timeout: 60_000 });

    // Gone: the password is refused as any wrong one is, with no step asked.
    await enterPassword(page, email);
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toHaveCount(0);
    await page.context().close();
});

test('a browser left signed in when the step is turned on is asked for it at its next unlock, and not at the one after', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(300_000);
    const a = await newPage(browser);
    const { email } = await registerAccount(a);
    const b = await newPage(browser);
    await enterPassword(b, email);
    await landedOnHome(b);
    // Turned on with the offer to sign the other devices out unticked: B keeps its session.
    const { app } = await turnOn(a, { keepOthers: true });
    await expect(section(a)).toContainText('Two-step sign-in is on.');
    await expect(section(a)).not.toContainText('Your other devices were signed out.');
    await b.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(b.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible({
        timeout: 60_000,
    });

    const lock = async () => {
        await b.getByRole('button', { name: 'Lock on this browser' }).click();
        await b.getByRole('alertdialog').getByRole('button', { name: 'Lock', exact: true }).click();
        await b.getByRole('button', { name: 'Unlock on this browser' }).click();
        const unlock = b.getByRole('dialog');
        await unlock.locator('input[autocomplete=current-password]').fill(PASSWORD);
        await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
        return unlock;
    };
    // B's session never passed the step: its unlock is a sign-in, so the same form asks for it.
    const unlock = await lock();
    const code = codeField(unlock);
    await expect(code).toBeVisible({ timeout: 60_000 });
    await expect(code).toBeFocused();
    await code.fill(app.wrong());
    await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(unlock.getByRole('alert')).toHaveText(
        'That code didn’t work. Codes change every 30 seconds.',
        { timeout: 60_000 },
    );
    await code.fill(await app.next());
    await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(unlock).toHaveCount(0, { timeout: 60_000 });
    await expect(b.getByRole('button', { name: 'Lock on this browser' })).toBeVisible();

    // Passed on this browser now: the next unlock, within thirty days, takes the password alone.
    const again = await lock();
    await expect(again).toHaveCount(0, { timeout: 60_000 });
    await expect(b.getByRole('button', { name: 'Lock on this browser' })).toBeVisible();
    await a.context().close();
    await b.context().close();
});
