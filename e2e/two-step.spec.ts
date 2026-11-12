import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mailSubjects, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Two-step sign-in in the web app (docs/two-step-design.md), against a server that offers it
 * (TWO_STEP_ENABLED=true): turning it on with an authenticator app whose codes the test
 * computes itself from the key the page shows, signing in with a code, a backup code and the
 * recovery phrase, a wrong code, the step inside Change password, a second browser, a reply
 * that never arrives, and turning it off again. On a server with two-step off, the settings
 * never show and these tests skip.
 */

const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const section = (p: Page) => p.getByRole('region', { name: 'Two-step sign-in' });

/* RFC 6238 as an authenticator app computes it: HMAC-SHA-1, 30 seconds, six digits. */
class Authenticator {
    private readonly key: Buffer;
    /* The last time step a code was used for: the server takes each step once. */
    private used = 0;
    constructor(base32: string) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        for (const character of base32.replace(/\s/g, '').toUpperCase())
            bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
        this.key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
    }
    private at(step: number) {
        const counter = Buffer.alloc(8);
        counter.writeBigUInt64BE(BigInt(step));
        const mac = createHmac('sha1', this.key).update(counter).digest();
        const offset = mac[mac.length - 1]! & 15;
        return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    }
    private static now() {
        return Math.floor(Date.now() / 30_000);
    }
    /*
     * A code the server will take now and has not taken before: the previous step's, this
     * one's or the next one's, whichever is the earliest unused. Three in a row can be had
     * at once; a fourth waits for the clock.
     */
    async next() {
        let step = Math.max(this.used + 1, Authenticator.now() - 1);
        while (step > Authenticator.now() + 1) await new Promise((done) => setTimeout(done, 1_000));
        step = Math.max(step, Authenticator.now() - 1);
        this.used = step;
        return this.at(step);
    }
    /* Six digits that are none of the codes the server would take now. */
    wrong() {
        const right = new Set([-2, -1, 0, 1, 2].map((d) => this.at(Authenticator.now() + d)));
        for (let guess = 0; ; guess++) {
            const code = String(guess).padStart(6, '0');
            if (!right.has(code)) return code;
        }
    }
}

/* A new account on its Account page, or a skip when this server has two-step off. */
async function account(browser: Browser) {
    const page = await newPage(browser);
    const person = await registerAccount(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible();
    test.skip(
        (await section(page).count()) === 0,
        'This server has TWO_STEP_ENABLED off: nothing about two-step sign-in is offered.',
    );
    return { page, ...person };
}

/* Turns the step on as a person does: the password, the key from the page, a code, the codes. */
async function turnOn(page: Page) {
    await section(page).getByRole('button', { name: 'Turn on' }).click();
    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(page).getByRole('img', { name: 'A code for your authenticator app' }),
    ).toBeVisible({ timeout: 60_000 });
    const key = await dialog(page).locator('[data-two-step-key]').innerText();
    expect(key.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
    const app = new Authenticator(key);
    await dialog(page)
        .getByLabel('Code from your authenticator app')
        .fill(await app.next());
    await dialog(page).getByRole('button', { name: 'Turn on' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Save your backup codes' })).toBeVisible(
        { timeout: 60_000 },
    );
    const codes = await dialog(page)
        .getByRole('list', { name: 'Backup codes' })
        .getByRole('listitem')
        .allInnerTexts();
    return { app, codes };
}

async function signOut(page: Page) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.waitForLoadState('networkidle');
}

/* The password's half of a sign-in: for an account with the step it ends on "One more step". */
async function enterPassword(page: Page, email: string, password = PASSWORD) {
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(password);
    await field.press('Enter');
}
const stepHeading = (p: Page) => p.getByRole('heading', { name: 'One more step' });
const inApp = (p: Page) => expect(p).toHaveURL(/\/app/, { timeout: 60_000 });

test('turning it on shows the codes once, and a code, a backup code or the phrase then signs in', async ({
    browser,
}) => {
    test.setTimeout(420_000);
    const { page, email, phrase } = await account(browser);
    await expect(section(page).getByText('Off. Your password alone signs you in.')).toBeVisible();
    const { app, codes } = await turnOn(page);

    // Ten codes, shown once, to copy or to keep as a file made here.
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(new Set(codes).size).toBe(10);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog(page).getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('hushos-backup-codes.txt');
    const saved = readFileSync(await download.path(), 'utf8');
    for (const code of codes) expect(saved).toContain(code);
    expect(saved).toContain(email);
    await expect(dialog(page).getByRole('button', { name: 'Print' })).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await expect(dialog(page)).toHaveCount(0);

    // The settings say so, the log has it, and so does the inbox.
    await expect(section(page).locator('[data-two-step=on]')).toBeVisible();
    await expect(section(page).getByText('10 of 10 left')).toBeVisible();
    await expect(
        section(page).getByRole('list', { name: 'Recent security activity' }),
    ).toContainText('Two-step sign-in turned on');
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('Two-step sign-in is on');
    // The codes are not shown again: New codes makes a new set, it does not show the old one.
    await page.reload({ waitUntil: 'networkidle' });
    for (const code of codes) await expect(page.getByText(code)).toHaveCount(0);

    // The password alone no longer signs in. A wrong code is refused and can be tried again.
    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/login/);
    const code = page.getByLabel('Code from your authenticator app');
    await code.fill(app.wrong());
    await code.press('Enter');
    await expect(page.getByRole('alert')).toContainText('That code didn’t work', {
        timeout: 60_000,
    });
    await expect(stepHeading(page)).toBeVisible();
    await code.fill(await app.next());
    await code.press('Enter');
    await inApp(page);

    // A backup code, in place of the app: it is used up.
    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Use a backup code' }).click();
    await page.getByLabel('Backup code').fill(codes[0]!.toLowerCase());
    await page.getByLabel('Backup code').press('Enter');
    await inApp(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(section(page).getByText('9 of 10 left')).toBeVisible();
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('A backup code was used');

    // The same code again is refused; the recovery phrase passes.
    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Use a backup code' }).click();
    await page.getByLabel('Backup code').fill(codes[0]!);
    await page.getByLabel('Backup code').press('Enter');
    await expect(page.getByRole('alert')).toContainText('That backup code didn’t work', {
        timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Use your recovery phrase' }).click();
    await page.getByLabel('Recovery phrase').fill(phrase);
    await expect(page.getByText('24 of 24 words')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await inApp(page);
    await page.context().close();
});

test('changing the password asks for the step in the same dialog, keeps this browser signed in, and a second browser is asked for it', async ({
    browser,
}) => {
    test.setTimeout(420_000);
    const { page, email } = await account(browser);
    const { app } = await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    const next = `${PASSWORD}-changed`;

    await page.getByRole('button', { name: 'Change password' }).click();
    await dialog(page).getByLabel('Current password').fill(PASSWORD);
    await dialog(page).getByLabel('New password', { exact: true }).fill(next);
    await dialog(page).getByLabel('Confirm new password').fill(next);
    const change = dialog(page).getByRole('button', { name: 'Change password' });
    await change.click();
    // The step is asked for before anything changes.
    const code = dialog(page).getByLabel('Code from your authenticator app');
    await expect(code).toBeVisible({ timeout: 60_000 });
    await expect(dialog(page).getByText('this needs your second step too')).toBeVisible();
    await change.click();
    await expect(dialog(page).getByRole('alert')).toContainText('Enter the 6-digit code');
    // A wrong code changes nothing: the old password still signs in elsewhere, as far as the step.
    await code.fill(app.wrong());
    await change.click();
    await expect(dialog(page).getByRole('alert')).toContainText('That code didn’t work', {
        timeout: 60_000,
    });
    const other = await newPage(browser);
    await other.goto('/login', { waitUntil: 'networkidle' });
    await enterPassword(other, email);
    await expect(stepHeading(other)).toBeVisible({ timeout: 60_000 });
    await other.getByRole('button', { name: 'Start again' }).click();
    await expect(other.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    await code.fill(await app.next());
    await change.click();
    await expect(
        page.getByText('Password changed. Your other devices are signed out.'),
    ).toBeVisible({ timeout: 90_000 });
    // This browser is still signed in and open, and was not asked for a second code.
    await expect(page).toHaveURL(/\/app\/account/);
    await expect(stepHeading(page)).toHaveCount(0);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(section(page).locator('[data-two-step=on]')).toBeVisible({ timeout: 60_000 });

    // The second browser: the old password is refused, and the new one is asked for the step.
    await enterPassword(other, email);
    await expect(other.getByRole('alert').first()).toContainText('don’t match', {
        timeout: 60_000,
    });
    await enterPassword(other, email, next);
    await expect(stepHeading(other)).toBeVisible({ timeout: 60_000 });

    // The answer's reply never arrives (a proxy's page in its place): the person is back at
    // the password with the reason, and signing in again works.
    await other.route('**/api/auth/login/two-step', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html>Sign in to Wi-Fi</html>',
        }),
    );
    const otherCode = other.getByLabel('Code from your authenticator app');
    await otherCode.fill(await app.next());
    await otherCode.press('Enter');
    await expect(other.getByRole('heading', { name: 'Welcome back' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(other.getByRole('alert')).toContainText('The server’s answer didn’t arrive');
    await expect(other.locator('input[autocomplete=current-password]')).toHaveValue('');
    await other.unroute('**/api/auth/login/two-step');
    await enterPassword(other, email, next);
    await expect(stepHeading(other)).toBeVisible({ timeout: 60_000 });
    await otherCode.fill(await app.next());
    await otherCode.press('Enter');
    await inApp(other);
    // Both browsers are listed, and the log says how the second one got in.
    await other.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(
        section(other).getByRole('list', { name: 'Recent security activity' }),
    ).toContainText('Signed in with your password and an authenticator code');
    await other.context().close();
    await page.context().close();
});

test('new backup codes replace the old ones, and turning it off needs the step and leaves the password alone', async ({
    browser,
}) => {
    test.setTimeout(420_000);
    const { page, email } = await account(browser);
    const { app, codes } = await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();

    // A new set: the password and the step, then ten codes that are none of the old ones.
    await section(page).getByRole('button', { name: 'New codes' }).click();
    const fresh = dialog(page);
    await fresh.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await fresh.getByLabel('Code from your authenticator app').fill(await app.next());
    await fresh.getByRole('button', { name: 'Make new codes' }).click();
    await expect(fresh.getByRole('heading', { name: 'Save your new backup codes' })).toBeVisible({
        timeout: 60_000,
    });
    const made = await fresh
        .getByRole('list', { name: 'Backup codes' })
        .getByRole('listitem')
        .allInnerTexts();
    expect(made).toHaveLength(10);
    for (const code of made) expect(codes).not.toContain(code);
    await fresh.getByRole('button', { name: 'Done' }).click();

    // Deleting the account asks for the step too, and deletes nothing without it.
    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByRole('button', { name: 'Delete account' }).click();
    const gone = dialog(page);
    await gone.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await gone.getByLabel('Type DELETE to confirm').fill('DELETE');
    await gone.getByRole('button', { name: 'Delete forever' }).click();
    await expect(gone.getByLabel('Code from your authenticator app')).toBeVisible({
        timeout: 60_000,
    });
    await gone.getByLabel('Code from your authenticator app').fill(app.wrong());
    await gone.getByRole('button', { name: 'Delete forever' }).click();
    await expect(gone.getByRole('alert')).toContainText('That code didn’t work', {
        timeout: 60_000,
    });
    await expect(page).toHaveURL(/\/app\/account/);
    await gone.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);

    // Turning it off: without the step nothing happens; an old backup code is no step any more.
    await section(page).getByRole('button', { name: 'Turn off' }).click();
    const off = dialog(page);
    await off.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await off.getByRole('button', { name: 'Use a backup code' }).click();
    await off.getByLabel('Backup code').fill(codes[0]!);
    await off.getByRole('button', { name: 'Turn off' }).click();
    await expect(off.getByRole('alert')).toContainText('That backup code didn’t work', {
        timeout: 60_000,
    });
    // Behind the open dialog, where the page is hidden from roles: found by its mark.
    await expect(page.locator('#two-step [data-two-step=on]')).toBeVisible();
    // One of the new ones is.
    await off.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await off.getByLabel('Backup code').fill(made[0]!);
    await off.getByRole('button', { name: 'Turn off' }).click();
    await expect(section(page).getByText('Off. Your password alone signs you in.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(section(page).getByText('Two-step sign-in is off.')).toBeVisible();
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('Two-step sign-in is off');

    // The password alone signs in again.
    await signOut(page);
    await enterPassword(page, email);
    await inApp(page);
    await expect(stepHeading(page)).toHaveCount(0);
    await page.context().close();
});
