import { expect, test, type Page } from '@playwright/test';
import { mailSubjects, registerAccount, sampleFiles } from './helpers';

/*
 * Sharing to an account, end to end as two people: the owner pins the other
 * person's fingerprint, shares a folder with a file in it, the other person
 * sees it under "Shared with me" (pinning the owner's key on first use), opens
 * the folder, previews the file, adds one of their own as an editor, and loses
 * everything the moment the owner stops sharing.
 */

test.describe.configure({ mode: 'serial' });

let owner: Page;
let guest: Page;
let guestEmail: string;
let samples: ReturnType<typeof sampleFiles>;
let linkUrl: string;

const rows = (p: Page) => p.locator('[data-node-id]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    samples = sampleFiles();
    guest = await (await browser.newContext()).newPage();
    guestEmail = (await registerAccount(guest)).email;
    owner = await (await browser.newContext()).newPage();
    await registerAccount(owner);
});
test.afterAll(async () => {
    await owner.context().close();
    await guest.context().close();
});

test('the owner pins the guest and shares a folder as editor', async () => {
    await owner.goto('/app/contacts');
    await owner.getByLabel('Email').fill(guestEmail);
    await owner.getByRole('button', { name: 'Look up' }).click();
    await expect(owner.locator('[data-fingerprint]')).toBeVisible({ timeout: 60_000 });
    await owner.getByRole('button', { name: 'Pin contact' }).click();
    await expect(owner.locator(`[data-contact="${guestEmail}"]`)).toBeVisible();

    await owner.goto('/app');
    await owner
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await owner.getByPlaceholder('Reports/2026').fill('Project');
    await owner.keyboard.press('Enter');
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(owner).toHaveURL(/\/app\/f\//);
    await owner.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });

    // Back at the top, selecting the folder puts Share in the toolbar; no right-click needed.
    await owner.locator('[data-crumb-id]').first().click();
    await row(owner, 'Project').locator('button').first().click();
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(owner)).toContainText('Share “Project”');
    await dialog(owner).getByRole('combobox', { name: 'Contact' }).click();
    await owner.getByRole('option', { name: /E2E Tester/ }).click();
    await dialog(owner).getByLabel('Can edit').check();
    await dialog(owner).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(owner.getByText(/shared with E2E Tester/)).toBeVisible();
    await expect(dialog(owner).locator(`[data-share="${guestEmail}"]`)).toContainText('can edit');
    // A link too, with a password: it has to survive the rotation that follows the revocation.
    await dialog(owner).getByLabel('Password').fill('open sesame');
    await dialog(owner).getByRole('button', { name: 'Create link' }).click();
    linkUrl = (await dialog(owner).locator('button[aria-label="Copy Link"]').textContent())!.trim();
    await dialog(owner).getByRole('button', { name: 'Done' }).first().click();
    await owner.keyboard.press('Escape');
    await expect(dialog(owner)).toHaveCount(0);
    // The guest is told by mail: who shared, never what.
    await expect
        .poll(() => mailSubjects(guestEmail), { timeout: 30_000 })
        .toContain('E2E Tester shared something with you · HushOS');
});

test('the guest sees the share, opens it with the owner’s key pinned on first use, and adds a file', async () => {
    await guest.goto('/app/shared');
    const item = guest.locator('[data-shared="Project"]');
    await expect(item).toBeVisible({ timeout: 60_000 });
    await expect(item).toContainText('you can edit');
    // First use pinned the owner: the contacts page now lists them.
    await guest.goto('/app/contacts');
    await expect(guest.locator('[data-contact]')).toHaveCount(1, { timeout: 60_000 });

    await guest.goto('/app/shared');
    await guest.locator('[data-shared="Project"]').getByRole('link', { name: 'Project' }).click();
    await expect(guest).toHaveURL(/\/app\/f\//);
    await expect(row(guest, 'notes.md')).toBeVisible({ timeout: 60_000 });
    // The breadcrumb starts at the share, with a way back to the list; nothing above it shows.
    await expect(
        guest.locator('nav[aria-label=breadcrumb]').getByRole('link', { name: 'Shared with me' }),
    ).toBeVisible();
    await expect(guest.locator('[data-crumb-id]')).toHaveCount(0);
    // The guest cannot share what is not theirs.
    await row(guest, 'notes.md').locator('button').first().click({ button: 'right' });
    await expect(guest.getByRole('menuitem', { name: 'Share…' })).toHaveCount(0);
    await guest.keyboard.press('Escape');

    // Preview decrypts on the guest's device with the key the share carried.
    await row(guest, 'notes.md').getByRole('link', { name: 'notes.md' }).click();
    await expect(dialog(guest).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
    await guest.keyboard.press('Escape');

    // As an editor, an upload lands in the owner's folder and counts against the owner.
    // The owner is looking at the parent folder: the change feed brings the new file in without a reload.
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(rows(owner)).toHaveCount(1);
    await guest.locator('input[type=file]').first().setInputFiles([samples.files.code]);
    await expect(row(guest, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(row(owner, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(rows(owner)).toHaveCount(2);
});

test('a shared folder in the trash leaves both lists, without breaking either, and returns on restore', async () => {
    // The owner is looking at the parent folder; Backspace moves the selected folder to the trash.
    await owner.locator('[data-crumb-id]').first().click();
    await expect(row(owner, 'Project')).toBeVisible({ timeout: 60_000 });
    await row(owner, 'Project').locator('button').first().click();
    await owner.keyboard.press('Backspace');
    await expect(row(owner, 'Project')).toHaveCount(0);

    await owner.goto('/app/shared?view=by-me');
    await expect(owner.getByText('You are not sharing anything yet.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(owner.getByText('Could not load')).toHaveCount(0);
    await guest.goto('/app/shared');
    await expect(guest.getByText('Nothing shared with you yet.')).toBeVisible({ timeout: 60_000 });

    await owner.goto('/app/trash');
    await owner
        .getByRole('row')
        .filter({ hasText: 'Project' })
        .getByRole('button', { name: /^Restore/ })
        .click();
    await expect(owner.getByText('“Project” restored')).toBeVisible();
    await owner.goto('/app/shared?view=by-me');
    await expect(owner.locator(`[data-by-me="${guestEmail}"]`)).toContainText('Project', {
        timeout: 60_000,
    });
    await guest.goto('/app/shared');
    await expect(guest.locator('[data-shared="Project"]')).toBeVisible({ timeout: 60_000 });
    // Back inside the folder, where the next test expects the guest to be.
    await guest.locator('[data-shared="Project"]').getByRole('link', { name: 'Project' }).click();
    await expect(row(guest, 'notes.md')).toBeVisible({ timeout: 60_000 });
});

test('stopping the share, from the Shared page’s “by me” view, cuts the guest off on the next request', async () => {
    await owner.goto('/app/shared?view=by-me');
    const entry = owner.locator(`[data-by-me="${guestEmail}"]`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await expect(entry).toContainText('Project');
    await entry.getByRole('button', { name: /Stop sharing Project/ }).click();
    await expect(owner.getByText(/Sharing with E2E Tester stopped/)).toBeVisible();
    await expect(entry).toHaveCount(0);
    // Revocation stops the server; the rotation that follows shuts the door.
    await expect(owner.getByText('Keys rotated')).toBeVisible({ timeout: 120_000 });
    await expect(owner.getByText(/re-keyed and re-sealed/)).toBeVisible();

    const url = guest.url();
    await guest.goto('/app/shared');
    await expect(guest.getByText('Nothing shared with you yet.')).toBeVisible({ timeout: 60_000 });
    await guest.goto(url);
    await expect(guest.getByText('This item no longer exists.')).toBeVisible({ timeout: 60_000 });
});

test('after the rotation the owner still opens everything, and the link made before it still works', async ({
    browser,
}) => {
    // A fresh page of the owner's: no cached keys, every envelope is the rotated one.
    await owner.goto('/app');
    await expect(row(owner, 'Project')).toBeVisible({ timeout: 60_000 });
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(row(owner, 'module.ts')).toBeVisible();
    await row(owner, 'notes.md').getByRole('link', { name: 'notes.md' }).click();
    await expect(dialog(owner).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
    await owner.keyboard.press('Escape');
    // Moves work again once the rotation is over.
    await owner.locator('[data-crumb-id]').first().click();
    await expect(row(owner, 'Project')).toBeVisible();

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(linkUrl);
    await expect(visitor.getByRole('heading', { name: 'This link has a password' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.getByLabel('Password').fill('open sesame');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(row(visitor, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await row(visitor, 'notes.md').locator('button').first().click();
    await expect(dialog(visitor).locator('.rt-markdown')).toContainText('Notes', {
        timeout: 60_000,
    });
    await visitor.context().close();
});
