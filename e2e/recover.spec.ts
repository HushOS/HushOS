import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
    hydrated,
    newContext,
    PASSWORD,
    registerAccount,
    saveKit,
    verificationLink,
} from './helpers';

/*
 * Getting back in with the recovery kit, through the real keys: the kit
 * downloaded from the app opens the account from the reset page, a file that
 * isn't a kit is refused before anything is sent, the reset hands out a new
 * phrase, and the kit from before the reset no longer opens anything.
 */

test.describe.configure({ mode: 'serial' });

const NEW_PASSWORD = 'a-new-password-after-the-kit-7';
let page: Page;
let email: string;
let oldKit: string;
let oldWords: string;

const wordsOn = async (p: Page) =>
    (await p.getByRole('list', { name: 'Recovery phrase' }).getByRole('listitem').allInnerTexts())
        .map((item) => item.split(/\s+/).at(-1))
        .join(' ');

async function signOut(p: Page) {
    await p.getByRole('button', { name: 'Account menu' }).click();
    await p.getByRole('menuitem', { name: 'Sign out' }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(p).toHaveURL(/\/login/, { timeout: 60_000 });
    // Signing out can land on /login twice (the menu, then the guard); let it settle
    // so the next goto isn't cut off by the second one.
    await expect(p.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await p.waitForLoadState('networkidle');
}

/* From "Forgot your password?" to the page that asks for the kit. */
async function startReset(p: Page) {
    await p.goto('/recover', { waitUntil: 'networkidle' });
    const field = p.getByRole('textbox', { name: /email/i });
    await hydrated(field);
    await field.fill(email);
    await p.getByRole('button', { name: 'Send link' }).click();
    await expect(p.getByText('Check your inbox')).toBeVisible({ timeout: 60_000 });
    const link = new URL(await verificationLink(email, '/recover/complete'));
    await p.goto(link.pathname + link.search + link.hash, { waitUntil: 'networkidle' });
    await expect(p.getByRole('heading', { name: 'Use your recovery kit' })).toBeVisible({
        timeout: 60_000,
    });
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await (await newContext(browser)).newPage();
    ({ email } = await registerAccount(page));
    await page.goto('/app/recovery-key', { waitUntil: 'networkidle' });
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toBeVisible({
        timeout: 60_000,
    });
    oldWords = await wordsOn(page);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download kit' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('hushos-recovery-kit.txt');
    oldKit = (await download.path())!;
    // The kit holds the words the page showed.
    expect(readFileSync(oldKit, 'utf8')).toContain(oldWords);
});
test.afterAll(async () => {
    await page.context().close();
});

test('the kit file opens the account on the reset page, and a stray file is refused', async () => {
    test.setTimeout(300_000);
    await signOut(page);
    await startReset(page);
    const input = page.locator('input[type=file]');

    const stray = join(mkdtempSync(join(tmpdir(), 'hushos-kit-')), 'notes.txt');
    writeFileSync(stray, `Shopping list\n${oldWords}\n`);
    await input.setInputFiles(stray);
    await expect(page.getByRole('alert')).toContainText('That isn’t a HushOS recovery kit');

    await input.setInputFiles(oldKit);
    await expect(page.getByText('24 of 24 words read')).toBeVisible();
    expect(await wordsOn(page)).toBe(oldWords);
    const passwords = page.locator('input[autocomplete=new-password]');
    await passwords.nth(0).fill(NEW_PASSWORD);
    await passwords.nth(1).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Reset password' }).click();

    // A reset hands out a new phrase, saved before anything else.
    await expect(page).toHaveURL(/\/setup\/recovery-key/, { timeout: 120_000 });
    await expect(page.getByRole('list', { name: 'Recovery phrase' })).toBeVisible({
        timeout: 60_000,
    });
    // The reset page's list can still be on screen as the URL changes; wait for the new words.
    await expect.poll(() => wordsOn(page), { timeout: 60_000 }).not.toBe(oldWords);
    await saveKit(page);
    await expect(page).toHaveURL(/\/app/, { timeout: 60_000 });
});

test('the kit from before the reset no longer opens the account', async () => {
    test.setTimeout(300_000);
    await signOut(page);
    await startReset(page);
    await page.locator('input[type=file]').setInputFiles(oldKit);
    await expect(page.getByText('24 of 24 words read')).toBeVisible();
    const passwords = page.locator('input[autocomplete=new-password]');
    await passwords.nth(0).fill('yet-another-password-to-try-1');
    await passwords.nth(1).fill('yet-another-password-to-try-1');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alert')).toContainText('didn’t open your account', {
        timeout: 120_000,
    });
    await expect(page).toHaveURL(/\/recover\/complete/);

    // The password set with the kit is the one that works now.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const password = page.locator('input[autocomplete=current-password]');
    await password.fill(PASSWORD);
    await password.press('Enter');
    await expect(page.getByRole('alert').first()).toContainText('don’t match', {
        timeout: 60_000,
    });
    await password.fill(NEW_PASSWORD);
    await password.press('Enter');
    await expect(page).toHaveURL(/\/app/, { timeout: 60_000 });
});
