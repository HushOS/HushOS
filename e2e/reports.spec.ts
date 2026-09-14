import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { registerAccount, sampleFiles, sha256 } from './helpers';

/*
 * Reports, end to end as three people: an owner links a folder, a visitor with
 * no account reports it, an operator (made one from the command line before
 * the report, so it is sealed to them) finds it in the queue, opens the
 * content under their own identity, removes it and suspends the owner. The
 * link stops, the owner cannot restore, the owner cannot sign in, and lifting
 * the suspension lets them back.
 */

test.describe.configure({ mode: 'serial' });

let owner: Page;
let operator: Page;
let ownerEmail: string;
let operatorEmail: string;
let samples: ReturnType<typeof sampleFiles>;
let linkUrl: string;
let reportId: string;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    samples = sampleFiles();
    operator = await (await browser.newContext()).newPage();
    operatorEmail = (await registerAccount(operator)).email;
    // The operator exists, with an identity, before anyone reports: the key is sealed to them.
    execFileSync('bun', ['run', 'admin:grant', operatorEmail], { stdio: 'pipe' });

    owner = await (await browser.newContext()).newPage();
    ownerEmail = (await registerAccount(owner)).email;
    await owner
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await owner.getByPlaceholder('Reports/2026').fill('Dropbox');
    await owner.keyboard.press('Enter');
    await row(owner, 'Dropbox').getByRole('link', { name: 'Dropbox' }).click();
    await expect(owner).toHaveURL(/\/app\/f\//);
    await owner.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 90_000 });
    await owner.locator('[data-crumb-id]').first().click();
    await row(owner, 'Dropbox').locator('button').first().click();
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await dialog(owner).getByRole('button', { name: 'Create link' }).click();
    linkUrl = (await dialog(owner).locator('button[aria-label="Copy Link"]').textContent())!.trim();
    await dialog(owner).getByRole('button', { name: 'Done' }).first().click();
    await owner.keyboard.press('Escape');
});
test.afterAll(async () => {
    await owner.context().close();
    await operator.context().close();
});

test('a visitor with no account reports what a link shows', async ({ browser }) => {
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(linkUrl);
    await expect(row(visitor, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await visitor.getByRole('button', { name: 'Report' }).click();
    await expect(dialog(visitor)).toContainText('Report “Dropbox”');
    // Nothing is sent without a category and a reason.
    await expect(dialog(visitor).getByRole('button', { name: 'Send report' })).toBeDisabled();
    await dialog(visitor).getByRole('combobox', { name: 'Category' }).click();
    await visitor.getByRole('option', { name: 'Harassment or threats' }).click();
    await dialog(visitor).getByLabel('What is wrong').fill('The notes file threatens someone.');
    await dialog(visitor).getByLabel('Your email').fill('witness@hushos.local');
    await dialog(visitor).getByRole('button', { name: 'Send report' }).click();
    await expect(visitor.getByText('Report sent')).toBeVisible({ timeout: 60_000 });
    await expect(dialog(visitor)).toHaveCount(0);
    // Reporting the same thing again from the same place is answered, not duplicated.
    await visitor.getByRole('button', { name: 'Report' }).click();
    await dialog(visitor).getByRole('combobox', { name: 'Category' }).click();
    await visitor.getByRole('option', { name: 'Something else' }).click();
    await dialog(visitor).getByLabel('What is wrong').fill('Again.');
    await dialog(visitor).getByRole('button', { name: 'Send report' }).click();
    await expect(visitor.getByText('Already reported')).toBeVisible({ timeout: 60_000 });
    await visitor.context().close();
});

test('the operator sees it in the queue, opens the content under their own identity, and the look is on the record', async () => {
    await operator.goto('/app/admin/reports');
    // Filtered by the owner's address: a local database may hold other people's reports.
    const entry = operator
        .locator('[data-report-id]')
        .filter({ hasText: 'Harassment' })
        .filter({ hasText: ownerEmail });
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await expect(entry).toContainText('folder · 1 inside');
    reportId = (await entry.getAttribute('data-report-id'))!;
    await entry.getByRole('link', { name: 'Harassment or threats' }).click();
    await expect(operator).toHaveURL(new RegExp(`/app/admin/reports/${reportId}$`));
    await expect(operator.getByText('The notes file threatens someone.')).toBeVisible();
    await expect(operator.getByText('Anonymous, witness@hushos.local')).toBeVisible();
    await expect(operator.locator('ol li')).toHaveCount(1);

    await operator.getByRole('button', { name: 'Open the content' }).click();
    // The snapshot lists the folder, and the file decrypts on this device.
    await expect(row(operator, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(operator.locator('ol li')).toHaveCount(2);
    await expect(operator.locator('ol li').nth(1)).toContainText('Opened by an operator');
    await row(operator, 'notes.md').locator('button').click();
    await expect(dialog(operator).locator('.rt-markdown')).toContainText('Notes', {
        timeout: 60_000,
    });
    await operator.keyboard.press('Escape');

    // The packet: built on this device, files and hashes inside, and on the record.
    const [download] = await Promise.all([
        operator.waitForEvent('download'),
        operator.getByRole('button', { name: 'Download evidence packet' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^hushos-report-[0-9a-f]{8}-harassment\.zip$/);
    const zip = readFileSync((await download.path())!);
    // Store-only zip: the entries and their text are readable as bytes.
    for (const needle of ['report.txt', 'report.json', 'hashes.txt', 'files/Dropbox/notes.md'])
        expect(zip.includes(needle)).toBe(true);
    expect(zip.includes('The notes file threatens someone.')).toBe(true);
    expect(zip.includes(`sha256=${sha256(readFileSync(samples.files.markdown))}`)).toBe(true);
    expect(zip.includes('Local police')).toBe(true);
    await expect(operator.locator('ol li').last()).toContainText('Evidence packet downloaded');
    // No evidence store here: the copy is pending or skipped, never made, so there is nothing to fetch.
    await expect(
        operator.getByRole('button', { name: 'Fetch from the evidence store' }),
    ).toHaveCount(0);
    const refused = await operator.request.post(`/api/admin/reports/${reportId}/evidence`, {
        data: {},
        headers: { origin: new URL(operator.url()).origin },
    });
    expect(refused.status()).toBe(409);
    // A member cannot reach any of it.
    const probe = await owner.request.get(`/api/admin/reports/${reportId}`);
    expect(probe.status()).toBe(404);
});

test('removing the content stops the link and the owner’s restore; suspending the owner ends their session; lifting it lets them back', async ({
    browser,
}) => {
    await operator.getByRole('button', { name: 'Remove the content' }).click();
    await operator.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(operator.getByText('Content removed').first()).toBeVisible({ timeout: 60_000 });
    await expect(operator.locator('ol li')).toHaveCount(5);

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(linkUrl);
    await expect(visitor.locator('[data-slot=alert-title]')).toHaveText(
        'This link no longer works',
        { timeout: 60_000 },
    );
    await visitor.context().close();

    await owner.goto('/app/trash');
    const trashed = owner.locator('tr').filter({ hasText: 'Dropbox' });
    await expect(trashed).toBeVisible({ timeout: 60_000 });
    await trashed.getByRole('button', { name: /^Restore/ }).click();
    await expect(owner.getByText(/removed by the operator/)).toBeVisible({ timeout: 60_000 });

    await operator.getByRole('button', { name: 'Suspend the uploader' }).click();
    await expect(operator.getByText('Uploader suspended').first()).toBeVisible({ timeout: 60_000 });
    await owner.reload();
    await owner.waitForURL(/\/login/, { timeout: 60_000 });
    // Typing before hydration is typing into a form hydration then resets.
    await owner.waitForLoadState('networkidle');
    const emailField = owner.getByRole('textbox', { name: /email/i });
    await emailField.fill(ownerEmail);
    await expect(emailField).toHaveValue(ownerEmail);
    await owner.locator('input[type=password]').fill('correct-horse-battery-staple-9');
    await owner.locator('form button[type=submit]').click();
    await expect(owner.getByText(/suspended/)).toBeVisible({ timeout: 60_000 });

    await operator.getByRole('button', { name: 'Reinstate the uploader' }).click();
    await expect(operator.getByText('Uploader reinstated').first()).toBeVisible({
        timeout: 60_000,
    });
    await owner.locator('form button[type=submit]').click();
    await owner.waitForURL(/\/app/, { timeout: 60_000 });
    // The queue no longer lists the report as open; the closed view still does.
    await operator.goto('/app/admin/reports');
    await expect(operator.getByText(/ever filed/)).toBeVisible({ timeout: 60_000 });
    await expect(operator.locator(`[data-report-id="${reportId}"]`)).toHaveCount(0);
    await operator.goto('/app/admin/reports?status=all');
    await expect(operator.locator(`[data-report-id="${reportId}"]`)).toContainText(
        'Content removed',
        { timeout: 60_000 },
    );
});

test('an operator promoted after the report cannot open it until an operator who can grants access', async ({
    browser,
}) => {
    const late = await (await browser.newContext()).newPage();
    const lateEmail = (await registerAccount(late)).email;
    execFileSync('bun', ['run', 'admin:grant', lateEmail], { stdio: 'pipe' });
    await late.goto(`/app/admin/reports/${reportId}`);
    await late.getByRole('button', { name: 'Open the content' }).click();
    await expect(late.getByRole('alert')).toContainText(/not sealed to you/, { timeout: 60_000 });

    await operator.goto(`/app/admin/reports/${reportId}`);
    await operator.getByRole('button', { name: 'Open the content' }).click();
    await expect(row(operator, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await operator.getByRole('button', { name: /Grant access to \d+ operators?/ }).click();
    await expect(operator.getByText(/more operators? can open this report/)).toBeVisible({
        timeout: 60_000,
    });
    await expect(operator.getByRole('button', { name: /Grant access/ })).toHaveCount(0);
    await expect(operator.locator('ol li').last()).toContainText('Sealed to more operators');

    await late.reload();
    await late.getByRole('button', { name: 'Open the content' }).click();
    await expect(row(late, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await late.context().close();
});
