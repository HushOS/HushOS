import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, grip, newContext, registerAccount } from './helpers';

/*
 * Signing in comes back to where it was asked for: an app page through
 * ?redirect=, and a shared link through a return kept in the browser, key and
 * all, whether the visitor signs in or makes a new account on the way.
 */

test.describe.configure({ mode: 'serial' });

let owner: Page;
let ownerEmail: string;
let folderUrl: string;
let linkUrl: string;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

async function signIn(p: Page, email: string) {
    const password = p.locator('input[autocomplete=current-password]');
    await expect(password).toBeVisible({ timeout: 60_000 });
    const emailField = p.getByRole('textbox', { name: /email/i });
    if (!(await emailField.inputValue())) await emailField.fill(email);
    await password.fill(PASSWORD);
    await password.press('Enter');
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    owner = await (await newContext(browser)).newPage();
    ({ email: ownerEmail } = await registerAccount(owner));
    await owner
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await owner.getByPlaceholder('Reports/2026').fill('Deep/Deeper');
    await owner.keyboard.press('Enter');
    await expect(row(owner, 'Deep')).toBeVisible();
    // A link to the folder, for the visitors below.
    await row(owner, 'Deep').locator('button').first().click(grip);
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await dialog(owner).getByRole('button', { name: 'Link', exact: true }).click();
    await dialog(owner).getByRole('button', { name: 'Create link' }).click();
    linkUrl = (await dialog(owner).locator('button[aria-label="Copy Link"]').textContent())!.trim();
    expect(linkUrl).toMatch(/\/s\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
    await owner.keyboard.press('Escape');
    await row(owner, 'Deep').getByRole('link', { name: 'Deep' }).click();
    await expect(owner).toHaveURL(/\/app\/drive\/f\//);
    folderUrl = owner.url();
});

test('a signed-out app page sends its address to sign-in, and signing in returns to it', async () => {
    await owner.context().clearCookies();
    await owner.goto(folderUrl, { waitUntil: 'networkidle' });
    await expect(owner).toHaveURL(/\/login\?redirect=%2Fapp%2Fdrive%2Ff%2F/);
    await signIn(owner, ownerEmail);
    await expect(owner).toHaveURL(folderUrl, { timeout: 60_000 });
    await expect(row(owner, 'Deeper')).toBeVisible({ timeout: 60_000 });
});

test('a redirect that leaves the site is dropped, not followed', async ({ browser }) => {
    const page = await (await newContext(browser)).newPage();
    await page.goto('/login?redirect=%2F%2Fevil.example%2Fx', { waitUntil: 'networkidle' });
    // Dropped as the search is read, so nothing on the page can act on it.
    await expect(page).toHaveURL(/\/login$/);
    await page.close();
});

test('an existing account signs in from a shared link and comes back to it, key and all', async ({
    browser,
}) => {
    test.setTimeout(300_000);
    const visitor = await (await newContext(browser)).newPage();
    const { email } = await registerAccount(visitor, 'Visitor');
    await visitor.context().clearCookies();
    await visitor.goto(linkUrl, { waitUntil: 'networkidle' });
    await visitor.getByRole('link', { name: 'Sign in to save a copy' }).click();
    await expect(visitor).toHaveURL(/\/login$/);
    await signIn(visitor, email);
    await expect(visitor).toHaveURL(linkUrl, { timeout: 60_000 });
    await expect(visitor.getByRole('button', { name: 'Save a copy to my Drive' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.close();
});

test('a new account made from a shared link ends on that link', async ({ browser }) => {
    test.setTimeout(300_000);
    const visitor = await (await newContext(browser)).newPage();
    await visitor.goto(linkUrl, { waitUntil: 'networkidle' });
    await visitor.getByRole('link', { name: 'Sign in to save a copy' }).click();
    await visitor.getByRole('link', { name: 'Create an account' }).click();
    await expect(visitor).toHaveURL(/\/register/);
    await registerAccount(visitor, 'Newcomer', undefined, {
        viaCurrentPage: true,
        landsOn: /\/s\//,
    });
    expect(visitor.url()).toBe(linkUrl);
    await expect(visitor.getByRole('button', { name: 'Save a copy to my Drive' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.close();
});
