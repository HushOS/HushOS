import { expect, test, type Page } from '@playwright/test';
import { grip, newContext, registerAccount, sampleFiles } from './helpers';

/*
 * The catalogue: the tree mirrored on this device and opened, and what is
 * built on it. The mirror resumes from its cursor instead of starting over;
 * a tag renamed in the registry is renamed everywhere at once; and after the
 * rotation that follows a revoked share, the rotated items are still found,
 * both through the feed and after a reload from the mirror.
 */

test.describe.configure({ mode: 'serial' });

let owner: Page;
let guest: Page;
let guestEmail: string;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const palette = (p: Page) => p.getByPlaceholder(/search files and folders/i);

function mirror(page: Page) {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hushos-drive-mirror');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const count = await new Promise<number>((resolve) => {
            const request = db.transaction('nodes').objectStore('nodes').count();
            request.onsuccess = () => resolve(request.result);
        });
        const cursors = await new Promise<{ workspaceId: string; cursor: number }[]>((resolve) => {
            const request = db.transaction('cursors').objectStore('cursors').getAll();
            request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return { count, cursor: cursors[0]?.cursor ?? 0 };
    });
}

async function search(page: Page, query: string) {
    await page.keyboard.press('Escape');
    // Right after a navigation the button is drawn before the palette is wired to it.
    await expect(async () => {
        await page.getByRole('button', { name: 'Search' }).click();
        await expect(palette(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await palette(page).fill(query);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    guest = await (await newContext(browser)).newPage();
    guestEmail = (await registerAccount(guest)).email;
    owner = await (await newContext(browser)).newPage();
    await registerAccount(owner);
});
test.afterAll(async () => {
    await owner.context().close();
    await guest.context().close();
});

test('the mirror fills from the feed, grows with changes, and resumes from its cursor on reload', async () => {
    await expect.poll(async () => (await mirror(owner)).count, { timeout: 30_000 }).toBe(1);
    const first = await mirror(owner);
    expect(first.cursor).toBeGreaterThan(0);

    await owner
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await owner.getByPlaceholder('Reports/2026').fill('Project/inner');
    await owner.keyboard.press('Enter');
    await expect(row(owner, 'Project')).toBeVisible();
    await expect.poll(async () => (await mirror(owner)).count, { timeout: 30_000 }).toBe(3);
    const grown = await mirror(owner);
    expect(grown.cursor).toBeGreaterThan(first.cursor);

    const pulls: string[] = [];
    owner.on('request', (request) => {
        const url = request.url();
        if (url.includes('/changes?') && url.includes('limit=500')) pulls.push(new URL(url).search);
    });
    await owner.reload();
    await expect(row(owner, 'Project')).toBeVisible();
    await expect.poll(() => pulls.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(pulls.every((s) => s.includes(`since=${grown.cursor}`))).toBe(true);
    expect((await mirror(owner)).count).toBe(3);
});

test('a tag applied to a folder is found by name and by tag, and a rename reaches every row at once', async () => {
    const folder = row(owner, 'Project');
    const box = (await folder.boundingBox())!;
    await owner.mouse.click(box.x + box.width - 60, box.y + box.height / 2);
    await expect(folder).toHaveAttribute('aria-selected', 'true');
    await owner.keyboard.press('t');
    await expect(dialog(owner)).toContainText('Tags for “Project”');
    await dialog(owner).getByPlaceholder('Home, Tax, Travel…').fill('Client');
    await owner.keyboard.press('Enter');
    await expect(dialog(owner).getByRole('checkbox', { name: 'Client' })).toBeChecked();
    await dialog(owner)
        .getByRole('button', { name: /save tags/i })
        .click();
    await expect(folder).toContainText('Client');

    await search(owner, 'client');
    await expect(owner.getByRole('option', { name: /^Project/ })).toBeVisible({ timeout: 30_000 });
    await owner.keyboard.press('Escape');

    // The stamp opens the tag's page; a rename there is the registry's, so the row follows at once.
    await folder.getByRole('link', { name: 'Tag Client' }).click();
    await owner.waitForURL(/\/app\/tags\//);
    await expect(owner.getByRole('row', { name: /Project/ })).toBeVisible();
    await owner.getByRole('button', { name: /rename/i }).click();
    await dialog(owner).getByLabel('Name').fill('Clients 2026');
    await owner.keyboard.press('Enter');
    await expect(owner.getByRole('heading', { name: /Clients 2026/ })).toBeVisible();
    await owner.goto('/app/drive');
    await expect(row(owner, 'Project')).toContainText('Clients 2026');
    await expect(row(owner, 'Project')).not.toContainText(/Client\b(?! )/);

    // The registry page lists it with its count, and Info shows the stamp with a way to edit.
    await owner.goto('/app/tags');
    const entry = owner.locator('[data-tag-id]').filter({ hasText: 'Clients 2026' });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('1');
    await owner.goto('/app/drive');
    const target = row(owner, 'Project');
    const spot = (await target.boundingBox())!;
    await owner.mouse.click(spot.x + spot.width - 60, spot.y + spot.height / 2);
    await owner.keyboard.press('i');
    const details = owner.locator('[data-details]');
    await expect(details).toContainText('Clients 2026');
    await details.getByRole('button', { name: 'Edit' }).click();
    await expect(dialog(owner).filter({ hasText: 'Tags for “Project”' })).toBeVisible();
    await owner.keyboard.press('Escape');
});

test('after a revoked share is rotated, the rotated items are still found, through the feed and from the mirror', async () => {
    test.setTimeout(480_000);
    // Share the tagged folder, with a file in it, then take it back.
    await owner.goto('/app/contacts');
    await owner.getByLabel('Email').fill(guestEmail);
    await owner.getByRole('button', { name: 'Look up' }).click();
    await expect(owner.locator('[data-fingerprint]')).toBeVisible({ timeout: 60_000 });
    await owner.getByRole('button', { name: 'Pin contact' }).click();
    await expect(owner.locator(`[data-contact="${guestEmail}"]`)).toBeVisible();

    await owner.goto('/app/drive');
    await row(owner, 'Project').getByRole('link', { name: 'Project' }).click();
    await expect(owner).toHaveURL(/\/app\/drive\/f\//);
    const samples = sampleFiles();
    await owner.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(owner, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await owner.locator('[data-crumb-id]').first().click();
    await row(owner, 'Project').locator('button').first().click(grip);
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await dialog(owner).getByRole('combobox', { name: 'Contact' }).click();
    await owner.getByRole('option', { name: /E2E Tester/ }).click();
    await dialog(owner).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(owner.getByText(/shared with E2E Tester/)).toBeVisible();
    await owner.keyboard.press('Escape');

    await owner.goto('/app/shared?view=by-me');
    const entry = owner.locator(`[data-by-me="${guestEmail}"]`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await entry.getByRole('button', { name: /Stop sharing Project/ }).click();
    await expect(owner.getByText('Keys rotated')).toBeVisible({ timeout: 120_000 });

    // Through the feed: the rotated envelopes arrive and reopen in place.
    await owner.goto('/app/drive');
    await expect(row(owner, 'Project')).toBeVisible({ timeout: 60_000 });
    await search(owner, 'notes');
    await expect(owner.getByRole('option', { name: /notes\.md/ })).toBeVisible({
        timeout: 60_000,
    });
    await expect(owner.getByRole('option', { name: /notes\.md/ })).toContainText('Project');
    await owner.keyboard.press('Escape');

    // From the mirror: a fresh page rebuilds the catalogue from the rotated rows it kept.
    await owner.reload();
    await expect(row(owner, 'Project')).toBeVisible({ timeout: 60_000 });
    await search(owner, 'inner');
    await expect(owner.getByRole('option', { name: /^inner/ })).toBeVisible({ timeout: 60_000 });
    await owner.keyboard.press('Escape');
    await search(owner, 'notes');
    await expect(owner.getByRole('option', { name: /notes\.md/ })).toBeVisible({
        timeout: 60_000,
    });
    await owner.keyboard.press('Enter');
    await expect(owner.getByRole('option', { name: /^open$/i })).toBeVisible();
    await owner.keyboard.press('Enter');
    await owner.waitForURL(/preview=/);
    await expect(dialog(owner).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
});
