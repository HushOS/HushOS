import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { registerAccount, sampleFiles, sha256 } from './helpers';

/*
 * Links for anyone. The owner makes one for a folder, a visitor with no
 * account opens it from the full URL (the fragment opens the key on their
 * device), browses, previews and downloads byte-exact; a password link asks
 * for the password and refuses a wrong one; a stopped link stops. A signed-in
 * visitor can keep a copy, re-encrypted under their own keys.
 */

test.describe.configure({ mode: 'serial' });

let owner: Page;
let samples: ReturnType<typeof sampleFiles>;
let plainUrl: string;
let passwordUrl: string;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

async function makeLink(password: string | null) {
    await row(owner, 'Public').locator('button').first().click();
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    if (password) await dialog(owner).getByLabel('Password').fill(password);
    await dialog(owner).getByRole('button', { name: 'Create link' }).click();
    const url = (await dialog(owner)
        .locator('button[aria-label="Copy Link"]')
        .textContent())!.trim();
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
    await dialog(owner).getByRole('button', { name: 'Done' }).first().click();
    await owner.keyboard.press('Escape');
    await expect(dialog(owner)).toHaveCount(0);
    return url;
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    samples = sampleFiles();
    owner = await (await browser.newContext()).newPage();
    await registerAccount(owner);
    await owner
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await owner.getByPlaceholder('Reports/2026').fill('Public/inner');
    await owner.keyboard.press('Enter');
    await row(owner, 'Public').getByRole('link', { name: 'Public' }).click();
    await expect(owner).toHaveURL(/\/app\/f\//);
    await expect(row(owner, 'inner')).toBeVisible();
    await owner
        .locator('input[type=file]')
        .first()
        .setInputFiles([samples.files.binary, samples.files.markdown]);
    await expect(row(owner, 'payload.bin')).toBeVisible({ timeout: 90_000 });
    await expect(row(owner, 'notes.md')).toBeVisible();
    await owner.locator('[data-crumb-id]').first().click();
    plainUrl = await makeLink(null);
    passwordUrl = await makeLink('open sesame');
});
test.afterAll(async () => {
    await owner.context().close();
});

test('a visitor with no account browses, previews and downloads byte-exact', async ({
    browser,
}) => {
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(plainUrl);
    await expect(visitor.getByRole('heading', { name: 'Public' })).toBeVisible({ timeout: 60_000 });
    await expect(row(visitor, 'inner')).toBeVisible();
    await expect(row(visitor, 'payload.bin')).toBeVisible();
    // Folders inside the link open; the breadcrumb stays inside it.
    await row(visitor, 'inner').locator('button').first().click();
    await expect(visitor).toHaveURL(/folder=/);
    await expect(visitor.getByText('Nothing here.')).toBeVisible();
    await visitor.locator('[data-crumb-id]').first().click();
    await expect(row(visitor, 'notes.md')).toBeVisible();

    await row(visitor, 'notes.md').locator('button').first().click();
    await expect(dialog(visitor).locator('.rt-markdown')).toContainText('Notes', {
        timeout: 60_000,
    });
    await visitor.keyboard.press('Escape');

    await row(visitor, 'payload.bin').locator('button').first().click();
    const [download] = await Promise.all([
        visitor.waitForEvent('download'),
        dialog(visitor).getByRole('button', { name: 'Download', exact: true }).click(),
    ]);
    expect(sha256(readFileSync((await download.path())!))).toBe(samples.hashes.binary);
    await visitor.keyboard.press('Escape');

    // Without the fragment there is no key: the page asks for it, and pasting it opens the link.
    await visitor.goto(plainUrl.split('#')[0]!);
    await expect(visitor.getByRole('heading', { name: 'This link needs its key' })).toBeVisible();
    await expect(visitor.getByRole('button', { name: 'Open' })).toBeDisabled();
    await visitor.getByLabel('Key').fill(plainUrl.split('#')[1]!);
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(visitor.getByRole('heading', { name: 'Public' })).toBeVisible({ timeout: 60_000 });
    await expect(row(visitor, 'payload.bin')).toBeVisible();
    // The API refuses a guessed token the way it refuses a stopped one.
    const probe = await visitor.request.get(`/api/drive/links/${'A'.repeat(43)}/open`, {
        headers: { 'HushOS-Client': 'web/1' },
    });
    expect(probe.status()).toBe(404);
    await visitor.context().close();
});

test('a password link asks first, refuses a wrong password, and opens with the right one', async ({
    browser,
}) => {
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(passwordUrl);
    await expect(visitor.getByRole('heading', { name: 'This link has a password' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.getByLabel('Password').fill('wrong');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(visitor.getByRole('alert')).toContainText(/did not open/, { timeout: 60_000 });
    await visitor.getByLabel('Password').fill('open sesame');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(visitor.getByRole('heading', { name: 'Public' })).toBeVisible({ timeout: 60_000 });
    await expect(row(visitor, 'payload.bin')).toBeVisible();
    await visitor.context().close();
});

test('a signed-in visitor keeps a copy under their own keys', async ({ browser }) => {
    const keeper = await (await browser.newContext()).newPage();
    await registerAccount(keeper);
    await keeper.goto(plainUrl);
    await expect(row(keeper, 'payload.bin')).toBeVisible({ timeout: 60_000 });
    await keeper.getByRole('button', { name: 'Save a copy to my Drive' }).click();
    await expect(keeper.getByText(/being saved to your Drive/)).toBeVisible({ timeout: 60_000 });
    await keeper.goto('/app');
    await expect(row(keeper, 'Public')).toBeVisible({ timeout: 90_000 });
    await row(keeper, 'Public').getByRole('link', { name: 'Public' }).click();
    await expect(row(keeper, 'payload.bin')).toBeVisible({ timeout: 90_000 });
    await expect(row(keeper, 'inner')).toBeVisible();
    // The copy is theirs: it shares no key with the link, so it downloads the same bytes through their own account.
    await row(keeper, 'payload.bin').locator('button').first().click();
    const [download] = await Promise.all([
        keeper.waitForEvent('download'),
        keeper.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    expect(sha256(readFileSync((await download.path())!))).toBe(samples.hashes.binary);
    await keeper.context().close();
});

test('a link can be shown again, given a password, and shown as a QR code, without changing the link', async ({
    browser,
    browserName,
}) => {
    // The test reads the clipboard back; WebKit under Playwright cannot grant that.
    test.skip(browserName === 'webkit', 'WebKit cannot grant clipboard permissions');
    await owner.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await row(owner, 'Public').locator('button').first().click();
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    const rows = dialog(owner).locator('[data-link]');
    await expect(rows).toHaveCount(2);
    // The plain link is the first made: copying it again yields the very URL shown at creation.
    await rows.first().getByRole('button', { name: 'Copy link' }).click();
    await expect(owner.getByText('Link copied')).toBeVisible();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(plainUrl);
    await rows.first().getByRole('button', { name: 'Show QR code' }).click();
    await expect(rows.first().locator('svg:has(title)')).toHaveCount(1);

    // A password added later applies to the same URL.
    await rows.first().getByRole('button', { name: 'Edit link' }).click();
    await rows.first().getByLabel('Password').fill('later on');
    await rows.first().getByRole('button', { name: 'Save' }).click();
    await expect(owner.getByText('Link updated')).toBeVisible();
    await expect(rows.first()).toContainText('password');
    await owner.keyboard.press('Escape');

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(plainUrl);
    await expect(visitor.getByRole('heading', { name: 'This link has a password' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.getByLabel('Password').fill('later on');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(row(visitor, 'payload.bin')).toBeVisible({ timeout: 60_000 });
    // Moving into a folder keeps the fragment, so a reload inside still has the key,
    // and the folder opens even though this fresh page has only seen the link's root.
    await row(visitor, 'inner').locator('button').first().click();
    await expect(visitor).toHaveURL(/folder=.*#/);
    await visitor.reload();
    await visitor.getByLabel('Password').fill('later on');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(visitor.getByText('Nothing here.')).toBeVisible({ timeout: 60_000 });
    await expect(visitor.locator('[data-crumb-id]')).toHaveCount(2);
    await visitor.context().close();

    // The Shared page manages the same link from one place.
    await owner.goto('/app/shared?view=by-me');
    const managed = owner.locator('[data-link]').filter({ hasText: 'Public' }).first();
    await expect(managed).toBeVisible({ timeout: 60_000 });
    await expect(managed.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await owner.goto('/app');
    await expect(row(owner, 'Public')).toBeVisible({ timeout: 60_000 });
});

test('a stopped link stops, and the Shared page lists what is left', async ({ browser }) => {
    await row(owner, 'Public').locator('button').first().click();
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(owner).locator('[data-link]')).toHaveCount(2);
    await dialog(owner).getByRole('button', { name: 'Stop this link' }).first().click();
    await expect(owner.getByText('Link stopped')).toBeVisible();
    await expect(dialog(owner).locator('[data-link]')).toHaveCount(1);
    await owner.keyboard.press('Escape');
    await owner.goto('/app/shared?view=by-me');
    await expect(owner.locator('[data-link]').filter({ hasText: 'Public' })).toHaveCount(1, {
        timeout: 60_000,
    });

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(plainUrl);
    await expect(visitor.locator('[data-slot=alert-title]')).toHaveText(
        'This link no longer works',
        { timeout: 60_000 },
    );
    await visitor.context().close();
});
