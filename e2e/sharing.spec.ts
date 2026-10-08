import { expect, test, type Page } from '@playwright/test';
import {
    grip,
    mailSubjects,
    newContext,
    newFolder,
    newLink,
    registerAccount,
    rotationsDone,
    sampleFiles,
    shareWith,
    waitForRotation,
} from './helpers';

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
    guest = await (await newContext(browser)).newPage();
    guestEmail = (await registerAccount(guest)).email;
    owner = await (await newContext(browser)).newPage();
    await registerAccount(owner);
});
test.afterAll(async () => {
    await owner.context().close();
    await guest.context().close();
});

test('the owner pins the guest and shares a folder as editor', async () => {
    await owner.goto('/app/people');
    await owner.getByRole('button', { name: 'Add someone' }).click();
    await dialog(owner).getByLabel('Email').fill(guestEmail);
    await dialog(owner).getByRole('button', { name: 'Look up' }).click();
    await expect(dialog(owner).locator('[data-fingerprint-words]')).toBeVisible({
        timeout: 60_000,
    });
    // The guest's post-quantum key is served with a binding their identity signed.
    await expect(dialog(owner).locator('[data-kem]')).toHaveAttribute('data-kem', 'signed');
    await dialog(owner).getByRole('button', { name: 'They match' }).click();
    await expect(owner.locator(`[data-contact="${guestEmail}"]`)).toBeVisible();

    await owner.goto('/app/drive');
    await newFolder(owner);
    await owner.getByPlaceholder('Reports/2026').fill('Project');
    await owner.keyboard.press('Enter');
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(owner).toHaveURL(/\/app\/drive\/f\//);
    await owner.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });

    // Back at the top, selecting the folder puts Share in the toolbar; no right-click needed.
    await owner.locator('[data-crumb-id]').first().click();
    await row(owner, 'Project').locator('button').first().click(grip);
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(owner)).toContainText('Who can open this?');
    await expect(dialog(owner)).toContainText('Project');
    await shareWith(owner, /E2E Tester/, 'Can edit');
    await expect(owner.getByText(/shared with E2E Tester/)).toBeVisible();
    await expect(dialog(owner).locator(`[data-share="${guestEmail}"]`)).toContainText('Can edit');
    // Sealed hybrid: X25519 and ML-KEM-768 together.
    await expect(dialog(owner).locator(`[data-share="${guestEmail}"]`)).toHaveAttribute(
        'data-suite',
        '2',
    );
    // A link too, with a password: it has to survive the rotation that follows the revocation.
    linkUrl = await newLink(owner, 'open sesame');
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
    await expect(item).toContainText('From E2E · can edit');
    // First use pinned the owner: the contacts page now lists them.
    await guest.goto('/app/people');
    await expect(guest.locator('[data-contact]')).toHaveCount(1, { timeout: 60_000 });

    await guest.goto('/app/shared');
    await guest.locator('[data-shared="Project"]').getByRole('link', { name: 'Project' }).click();
    await expect(guest).toHaveURL(/\/app\/drive\/f\//);
    await expect(row(guest, 'notes.md')).toBeVisible({ timeout: 60_000 });
    // The breadcrumb starts at the share, with a way back to the list; nothing above it shows.
    await expect(
        guest
            .locator('nav[aria-label="Folder path"]')
            .getByRole('link', { name: 'Shared with me' }),
    ).toBeVisible();
    await expect(guest.locator('[data-crumb-id]')).toHaveCount(0);
    // The guest cannot share what is not theirs.
    await row(guest, 'notes.md')
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await expect(guest.getByRole('menuitem', { name: 'Share', exact: true })).toHaveCount(0);
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
    await row(owner, 'Project').locator('button').first().click(grip);
    await owner.keyboard.press('Backspace');
    await expect(row(owner, 'Project')).toHaveCount(0);

    await owner.goto('/app/shared?view=by-me');
    await expect(owner.getByText('You haven’t shared anything yet')).toBeVisible({
        timeout: 60_000,
    });
    await expect(owner.getByText('Couldn’t load what’s shared')).toHaveCount(0);
    await guest.goto('/app/shared');
    await expect(guest.getByText('Nothing shared with you yet')).toBeVisible({ timeout: 60_000 });

    await owner.goto('/app/trash');
    await owner
        .getByRole('row')
        .filter({ hasText: 'Project' })
        .getByRole('button', { name: /^Restore/ })
        .click();
    await expect(owner.getByText('Restored “Project” to My files')).toBeVisible();
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
    const rotated = await rotationsDone(owner);
    await entry.getByRole('button', { name: /Stop sharing Project/ }).click();
    await owner.getByRole('alertdialog').getByRole('button', { name: 'Stop sharing' }).click();
    await expect(owner.getByText(/E2E Tester can’t open “Project” any more/)).toBeVisible();
    await expect(entry).toHaveCount(0);
    // Revocation stops the server; the rotation that follows shuts the door, quietly:
    // stopping already said what happened, so no toast narrates the re-keying.
    await waitForRotation(owner, rotated);
    await expect(owner.getByText(/Rotating the keys|Keys rotated|re-keyed/)).toHaveCount(0);

    const url = guest.url();
    await guest.goto('/app/shared');
    await expect(guest.getByText('Nothing shared with you yet')).toBeVisible({ timeout: 60_000 });
    await guest.goto(url);
    await expect(guest.getByText('This item no longer exists.')).toBeVisible({ timeout: 60_000 });
});

test('after the rotation the owner still opens everything, and the link made before it still works', async ({
    browser,
}) => {
    // A fresh page of the owner's: no cached keys, every envelope is the rotated one.
    await owner.goto('/app/drive');
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

    const visitor = await (await newContext(browser)).newPage();
    await visitor.goto(linkUrl);
    await expect(visitor.getByRole('heading', { name: 'This link has a password' })).toBeVisible({
        timeout: 60_000,
    });
    await visitor.getByLabel('Password').fill('open sesame');
    await visitor.getByRole('button', { name: 'Open' }).click();
    await expect(row(visitor, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await row(visitor, 'notes.md').locator('button').first().click(grip);
    await expect(dialog(visitor).locator('.rt-markdown')).toContainText('Notes', {
        timeout: 60_000,
    });
    await visitor.context().close();
});

test('a shared file, with no folder to open it from, opens in the viewer on both Shared views', async () => {
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await row(owner, 'notes.md').locator('button').first().click(grip);
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(owner)).toContainText('notes.md');
    await shareWith(owner, /E2E Tester/);
    await expect(owner.getByText(/shared with E2E Tester/)).toBeVisible();
    await owner.keyboard.press('Escape');

    await guest.goto('/app/shared');
    const received = guest.locator('[data-shared="notes.md"]');
    await expect(received).toBeVisible({ timeout: 60_000 });
    await received.getByRole('button', { name: 'notes.md', exact: true }).click();
    await expect(dialog(guest).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
    await guest.keyboard.press('Escape');

    await owner.goto('/app/shared?view=by-me');
    const sent = owner.locator(`[data-by-me="${guestEmail}"]`).filter({ hasText: 'notes.md' });
    await expect(sent).toBeVisible({ timeout: 60_000 });
    await sent.getByRole('button', { name: 'notes.md', exact: true }).click();
    await expect(dialog(owner).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
});
