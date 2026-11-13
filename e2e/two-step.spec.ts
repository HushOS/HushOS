import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
    hydrated,
    mailSubjects,
    newPage,
    PASSWORD,
    registerAccount,
    saveKit,
    verificationLink,
} from './helpers';

/*
 * Two-step sign-in in the web app (docs/two-step-design.md), against a server that offers it
 * (TWO_STEP_ENABLED=true): turning it on with an authenticator app whose codes the test
 * computes itself from the key the page shows, signing in with a code, a backup code and the
 * recovery phrase, a wrong code, the step inside Change password, a second browser, a reply
 * that never arrives, a browser signed in before the step was on, and turning it off again.
 *
 * Whether two-step sign-in is on is this run's TWO_STEP_ENABLED (from the environment or .env,
 * as the server reads it). The server must agree: one that says otherwise fails the file
 * rather than letting it skip. With it off, the one test left checks that nothing is offered.
 */

// As the server reads it: off unless set to true.
const twoStepOn = process.env.TWO_STEP_ENABLED === 'true';

test.beforeAll(async ({ request }) => {
    // Asked without a session: a server with two-step off answers 501 before it looks for
    // one, and a server with it on answers that nobody is signed in.
    const answer = await request.get('/api/auth/two-step');
    expect(
        answer.status() !== 501,
        `TWO_STEP_ENABLED is ${twoStepOn ? 'on' : 'off'} here, and the server must say the same`,
    ).toBe(twoStepOn);
});

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
     * at once; a fourth waits for the clock. The previous step's is left alone in the last
     * seconds of a step: by the time the server looked, it would be two steps old.
     */
    async next() {
        const earliest = () => Authenticator.now() - ((Date.now() / 1000) % 30 < 20 ? 1 : 0);
        while (this.used + 1 > Authenticator.now() + 1)
            await new Promise((done) => setTimeout(done, 1_000));
        const step = Math.max(this.used + 1, earliest());
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

/* A new account on its Account page. */
async function account(browser: Browser) {
    const page = await newPage(browser);
    const person = await registerAccount(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible();
    return { page, ...person };
}

/* The step opens on the account's usual way; the others are behind one button. */
async function another(scope: Page | Locator, way: string) {
    await scope.getByRole('button', { name: 'Use another way' }).click();
    await scope.getByRole('button', { name: way }).click();
}

const toasts = (p: Page) => p.locator('[data-slot=toast]');
const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());

/*
 * Turns the step on as a person does: the password, the key from the page, a code, the codes.
 * `copyKey` copies the key on the way and checks how it was copied; `keepOthers` unticks the
 * offer to remove the account's other devices.
 */
async function turnOn(page: Page, options: { copyKey?: boolean; keepOthers?: boolean } = {}) {
    await section(page).getByRole('button', { name: 'Add authenticator app' }).click();
    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(page).getByRole('img', { name: 'A code for your authenticator app' }),
    ).toBeVisible({ timeout: 60_000 });
    const key = await dialog(page).locator('[data-two-step-key]').innerText();
    expect(key.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
    if (options.copyKey) {
        // The key is a secret: copied as the app types it, and cleared again like the others.
        await dialog(page).getByRole('button', { name: 'Copy key' }).click();
        await expect(toasts(page).filter({ hasText: 'Key copied' })).toContainText(
            'Cleared from the clipboard in two minutes.',
        );
        expect(await clipboard(page)).toBe(key.replace(/\s/g, ''));
    }
    if (options.keepOthers) {
        const others = dialog(page).getByRole('checkbox', { name: /Remove my other devices/ });
        // Ticked unless the person says otherwise.
        await expect(others).toBeChecked();
        await others.click();
        await expect(others).not.toBeChecked();
    }
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

test('with two-step off, Account offers nothing about it', async ({ browser }) => {
    test.skip(twoStepOn, 'Two-step sign-in is on (TWO_STEP_ENABLED).');
    test.setTimeout(300_000);
    const { page } = await account(browser);
    await expect(section(page)).toHaveCount(0);
    await expect(page.getByText('Two-step sign-in')).toHaveCount(0);
    await page.context().close();
});

test('turning it on shows the codes once, and a code, a backup code or the phrase then signs in', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(420_000);
    const { page, email, phrase } = await account(browser);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await expect(section(page).getByText('Off. Your password alone signs you in.')).toBeVisible();
    await expect(
        section(page).getByText('It doesn’t change how your files are encrypted.'),
    ).toBeVisible();
    const { app, codes } = await turnOn(page, { copyKey: true });

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
    // Copied, they are ten lines on the clipboard, cleared again like any other secret.
    await dialog(page).getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(toasts(page).filter({ hasText: 'Backup codes copied' })).toContainText(
        'Cleared from the clipboard in two minutes.',
    );
    expect((await clipboard(page)).split('\n')).toEqual(codes);
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
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('That code didn’t work', {
        timeout: 60_000,
    });
    await expect(stepHeading(page)).toBeVisible();
    // The cursor is back in the field, though the button was pressed.
    await expect(code).toBeFocused();
    await code.fill(await app.next());
    await code.press('Enter');
    await inApp(page);

    // A backup code, in place of the app: it is used up.
    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await another(page, 'Use a backup code');
    // The button pressed is gone; the cursor is in the field that took its place.
    await expect(page.getByLabel('Backup code')).toBeFocused();
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
    await another(page, 'Use a backup code');
    await page.getByLabel('Backup code').fill(codes[0]!);
    await page.getByLabel('Backup code').press('Enter');
    await expect(page.getByRole('alert')).toContainText('That backup code didn’t work', {
        timeout: 60_000,
    });
    await another(page, 'Use your recovery phrase');
    await page.getByLabel('Recovery phrase').fill(phrase);
    await expect(page.getByText('24 of 24 words')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await inApp(page);
    await page.context().close();
});

test('changing the password asks for the step in the same dialog, keeps this browser signed in, and a second browser is asked for it', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
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
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
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
    await another(off, 'Use a backup code');
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

test('a browser signed in before the step was on is asked for it when it unlocks, and is removed when the person says so', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(480_000);
    const { page, email } = await account(browser);
    // A second browser signs in while the password alone is enough.
    const earlier = await newPage(browser);
    await earlier.goto('/login', { waitUntil: 'networkidle' });
    await enterPassword(earlier, email);
    await inApp(earlier);

    // The step is turned on, and the other browser is kept signed in.
    await page.reload({ waitUntil: 'networkidle' });
    const { app } = await turnOn(page, { keepOthers: true });
    await dialog(page).getByRole('button', { name: 'Done' }).click();

    // It is still signed in, on a session that never passed the step. Locked and unlocked
    // again, which is a sign-in, it is asked for the step in the unlock dialog itself.
    await earlier.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(section(earlier).locator('[data-two-step=on]')).toBeVisible({ timeout: 60_000 });
    await earlier.getByRole('button', { name: 'Lock on this browser' }).click();
    await earlier.getByRole('alertdialog').getByRole('button', { name: 'Lock' }).click();
    await earlier.getByRole('button', { name: 'Unlock on this browser' }).click();
    const unlock = dialog(earlier);
    await expect(unlock.getByRole('heading', { name: 'Unlock HushOS' })).toBeVisible();
    await unlock.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
    const code = unlock.getByLabel('Code from your authenticator app');
    await expect(code).toBeVisible({ timeout: 60_000 });
    await expect(unlock.getByText('This account has two-step sign-in on.')).toBeVisible();
    await code.fill(app.wrong());
    await unlock.getByRole('button', { name: 'Continue' }).click();
    await expect(unlock.getByRole('alert')).toContainText('That code didn’t work', {
        timeout: 60_000,
    });
    await expect(code).toBeFocused();
    await code.fill(await app.next());
    await unlock.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog(earlier)).toHaveCount(0, { timeout: 60_000 });
    await expect(earlier.getByRole('button', { name: 'Lock on this browser' })).toBeVisible({
        timeout: 60_000,
    });

    // Off and on again, this time leaving the offer ticked: the codes are on screen first,
    // and the other browser is then removed and has to sign in again.
    await section(page).getByRole('button', { name: 'Turn off' }).click();
    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(page)
        .getByLabel('Code from your authenticator app')
        .fill(await app.next());
    await dialog(page).getByRole('button', { name: 'Turn off' }).click();
    await expect(section(page).getByText('Off. Your password alone signs you in.')).toBeVisible({
        timeout: 60_000,
    });
    const again = await turnOn(page);
    expect(again.codes).toHaveLength(10);
    await expect(dialog(page).getByRole('button', { name: 'Done' })).toBeEnabled({
        timeout: 60_000,
    });
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await expect(
        page.getByRole('list', { name: 'Your devices' }).getByRole('listitem'),
    ).toHaveCount(1, { timeout: 60_000 });
    await earlier.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(earlier).toHaveURL(/\/login/, { timeout: 60_000 });
    await earlier.context().close();
    await page.context().close();
});

/* From "Forgot your password?" to a reset sent with the typed phrase and a new password. */
async function resetWithPhrase(page: Page, email: string, phrase: string, password: string) {
    await page.goto('/recover', { waitUntil: 'networkidle' });
    const field = page.getByRole('textbox', { name: /email/i });
    await hydrated(field);
    await field.fill(email);
    await page.getByRole('button', { name: 'Send link' }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 60_000 });
    const link = new URL(await verificationLink(email, '/recover/complete'));
    await page.goto(link.pathname + link.search + link.hash, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Type the 24 words instead' }).click();
    await page.getByLabel('Recovery phrase').fill(phrase);
    const passwords = page.locator('input[autocomplete=new-password]');
    await passwords.nth(0).fill(password);
    await passwords.nth(1).fill(password);
    await page.getByRole('button', { name: 'Reset password' }).click();
}
const wordsOn = async (p: Page) =>
    (await p.getByRole('list', { name: 'Recovery phrase' }).getByRole('listitem').allInnerTexts())
        .map((item) => item.trim().split(/\s+/).at(-1))
        .join(' ');

test('someone with only their recovery phrase resets the password and is not stranded: the new phrase passes the step and is shown', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(480_000);
    const { page, email, phrase } = await account(browser);
    await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await signOut(page);
    // The phone with the app is gone, the backup codes with it, and the password is forgotten.
    // The phrase resets the password, which also replaces the phrase: the old one is dead
    // from here on, and the new one is the only thing left that can answer the step.
    const next = `${PASSWORD}-after-reset`;
    await resetWithPhrase(page, email, phrase, next);

    // Signed in by the reset itself, on the page that shows the new words: the step that
    // sign-in met was answered with the new phrase, which the person has not seen yet.
    await expect(page).toHaveURL(/\/setup\/recovery-key/, { timeout: 120_000 });
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toBeVisible({
        timeout: 60_000,
    });
    await expect.poll(() => wordsOn(page), { timeout: 60_000 }).not.toBe(phrase);
    const fresh = await wordsOn(page);
    expect(fresh.split(' ')).toHaveLength(24);
    await saveKit(page);
    await expect(page).toHaveURL(/\/app/, { timeout: 60_000 });

    // Later, on a browser that knows nothing: the old phrase no longer answers the step, and
    // the new one does.
    const other = await newPage(browser);
    await other.goto('/login', { waitUntil: 'networkidle' });
    await enterPassword(other, email, next);
    await expect(stepHeading(other)).toBeVisible({ timeout: 60_000 });
    await another(other, 'Use your recovery phrase');
    await other.getByLabel('Recovery phrase').fill(phrase);
    await other.getByRole('button', { name: 'Continue' }).click();
    await expect(other.getByRole('alert')).toContainText('That recovery phrase didn’t work', {
        timeout: 60_000,
    });
    await other.getByLabel('Recovery phrase').fill(fresh);
    await other.getByRole('button', { name: 'Continue' }).click();
    await inApp(other);
    await other.context().close();
    await page.context().close();
});

test('when the sign-in after a reset does not happen, the new phrase is shown on the reset page, and it is what gets the person back in', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(480_000);
    const { page, email, phrase } = await account(browser);
    await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await signOut(page);

    // The reset reaches the server; the sign-in that follows it does not (the connection drops).
    await page.route('**/api/auth/login/start', (route) => route.abort());
    const next = `${PASSWORD}-after-reset`;
    await resetWithPhrase(page, email, phrase, next);

    // Not an error and not a dead end: the words that replaced the old phrase, shown once.
    await expect(page.getByRole('heading', { name: 'Save your new recovery phrase' })).toBeVisible({
        timeout: 120_000,
    });
    await expect(page.getByText('your old recovery phrase no longer works')).toBeVisible();
    const fresh = await wordsOn(page);
    expect(fresh.split(' ')).toHaveLength(24);
    expect(fresh).not.toBe(phrase);
    await page.unroute('**/api/auth/login/start');

    // On to sign-in, with the new password. The step is asked for; the old phrase is refused,
    // and the words just shown pass it.
    await page.getByRole('link', { name: 'Continue to sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.getByText('Sign in with your new password.')).toBeVisible();
    await enterPassword(page, email, next);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await another(page, 'Use your recovery phrase');
    await page.getByLabel('Recovery phrase').fill(phrase);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('That recovery phrase didn’t work', {
        timeout: 60_000,
    });
    await page.getByLabel('Recovery phrase').fill(fresh);
    await page.getByRole('button', { name: 'Continue' }).click();
    await inApp(page);
    await page.context().close();
});

test('a new recovery phrase whose reply is lost does not lock out someone with only their phrase: the new words are shown before the sign-in that needs them', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(480_000);
    const { page, email, phrase } = await account(browser);
    await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();

    // Make a new phrase, answering the step with the phrase: the only step this person has.
    await page.getByRole('button', { name: 'Make a new phrase' }).click();
    const make = dialog(page);
    await make.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await make.getByRole('button', { name: 'Make a new phrase' }).click();
    await expect(make.getByLabel('Code from your authenticator app')).toBeVisible({
        timeout: 60_000,
    });
    await another(make, 'Use your recovery phrase');
    await make.getByLabel('Recovery phrase').fill(phrase);

    // The change reaches the server and is made; its reply, and the session it carried, are
    // lost on the way back, and so is the sign-in the page then tries.
    await page.route('**/api/auth/security/finish', async (route) => {
        await route.fetch();
        // The session the reply carried never reaches the browser, and the old one is dead.
        await page.context().clearCookies();
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<html>Sign in to Wi-Fi</html>',
        });
    });
    await page.route('**/api/auth/login/start', (route) => route.abort());
    await make.getByRole('button', { name: 'Make a new phrase' }).click();

    // Every session and the old phrase are dead now. The sign-in page shows the new words
    // first, and says what it could not confirm.
    await expect(page.getByRole('heading', { name: 'Save your new recovery phrase' })).toBeVisible({
        timeout: 120_000,
    });
    await expect(page).toHaveURL(/\/login/);
    await expect(
        page.getByText('Keep both until you know which one your account uses.'),
    ).toBeVisible();
    const fresh = await wordsOn(page);
    expect(fresh.split(' ')).toHaveLength(24);
    expect(fresh).not.toBe(phrase);
    await page.unroute('**/api/auth/security/finish');
    await page.unroute('**/api/auth/login/start');

    // On to the form. The password is the same; the step refuses the old phrase and takes
    // the words just shown.
    await page.getByRole('button', { name: 'I’ve saved these words' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await another(page, 'Use your recovery phrase');
    await page.getByLabel('Recovery phrase').fill(phrase);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('That recovery phrase didn’t work', {
        timeout: 60_000,
    });
    await page.getByLabel('Recovery phrase').fill(fresh);
    await page.getByRole('button', { name: 'Continue' }).click();
    await inApp(page);
    await page.context().close();
});

test('a new recovery phrase is shown at once wherever the person lands, and is gone once saved: nothing of it is left for the signed-out screen', async ({
    browser,
}) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    test.setTimeout(480_000);
    const { page, email, phrase } = await account(browser);
    const { app } = await turnOn(page);
    await dialog(page).getByRole('button', { name: 'Done' }).click();

    // The change is made and its session arrives, but the sign-in that follows it fails
    // (here the connection; a device key that cannot be read does the same).
    await page.route('**/api/auth/login/start', (route) => route.abort());
    await page.getByRole('button', { name: 'Make a new phrase' }).click();
    const make = dialog(page);
    await make.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await make.getByRole('button', { name: 'Make a new phrase' }).click();
    const code = make.getByLabel('Code from your authenticator app');
    await expect(code).toBeVisible({ timeout: 60_000 });
    await code.fill(await app.next());
    await make.getByRole('button', { name: 'Make a new phrase' }).click();

    // The session is still good, so the sign-in page sends the person on to the page that
    // asks them to unlock. The new words are over it all the same: not behind the unlock.
    const gate = page.locator('[data-new-phrase]');
    await expect(gate.getByRole('heading', { name: 'Save your new recovery phrase' })).toBeVisible({
        timeout: 120_000,
    });
    await expect(gate.getByText('Your old recovery phrase no longer works.')).toBeVisible();
    const fresh = (await gate.getByRole('listitem').allInnerTexts())
        .map((item) => item.trim().split(/\s+/).at(-1))
        .join(' ');
    expect(fresh.split(' ')).toHaveLength(24);
    expect(fresh).not.toBe(phrase);
    await expect(page).toHaveURL(/\/setup\/recovery-key/, { timeout: 60_000 });
    await page.unroute('**/api/auth/login/start');
    // It is a modal: what is under it (the page's own Unlock) cannot be reached by keyboard
    // or by a screen reader until the words are acknowledged, and Escape does not close it.
    expect(await gate.evaluate((dialog) => dialog.matches(':modal'))).toBe(true);
    const reached = await page.evaluate(() => {
        const under = [...document.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Unlock' && !button.closest('dialog'),
        );
        under?.focus();
        return { there: under !== undefined, focused: document.activeElement === under };
    });
    expect(reached).toEqual({ there: true, focused: false });
    // However often: a browser lets a page refuse Escape only so many times, then closes a
    // modal dialog whatever the page says, and the words would be held with nothing showing them.
    for (let pressed = 0; pressed < 5; pressed++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
    }
    await expect(
        gate.getByRole('heading', { name: 'Save your new recovery phrase' }),
    ).toBeVisible();
    await expect(gate.getByRole('list', { name: 'Recovery phrase' })).toBeVisible();
    expect(await gate.evaluate((dialog) => dialog.matches(':modal'))).toBe(true);

    // Saved: the words leave the screen and the tab.
    await gate.getByRole('button', { name: 'I’ve saved these words' }).click();
    await expect(gate).toHaveCount(0);
    await expect(page.getByText(fresh.split(' ').slice(0, 3).join(' '))).toHaveCount(0);

    // Unlocking with the password shows the same phrase on its own page, as the account's.
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toBeVisible({
        timeout: 60_000,
    });
    expect(await wordsOn(page)).toBe(fresh);
    await saveKit(page);
    await inApp(page);

    // Signed out a moment later, the sign-in page shows no phrase to whoever is there.
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await signOut(page);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('[data-new-phrase]')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toHaveCount(0);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toHaveCount(0);
    await page.context().close();
});
