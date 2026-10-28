import { expect, test, type Page } from '@playwright/test';
import { newContext, operatorRole, registerAccount } from './helpers';

/*
 * Contacts and the management area, driven as two people: one publishes an
 * identity and reads their own twelve words, the other adds them by email with
 * no words, checks it's them later and sees the same words, and finds the pin
 * on a reload. Then one of them is
 * made an operator from the command line and reaches the overview; the other
 * is turned away.
 */

test.describe.configure({ mode: 'serial' });

let alice: Page;
let bob: Page;
let bobEmail: string;
let bobFingerprint: string;
let bobWords: string;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    bob = await (await newContext(browser)).newPage();
    bobEmail = (await registerAccount(bob)).email;
    alice = await (await newContext(browser)).newPage();
    await registerAccount(alice);
});
test.afterAll(async () => {
    await alice.context().close();
    await bob.context().close();
});

test('everyone sees their own twelve words, and the code they come from', async () => {
    // The old Contacts address still lands on the page it became.
    await bob.goto('/app/contacts');
    await expect(bob).toHaveURL(/\/app\/contacts$/);
    await expect(bob.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    // One click from the page's header, however many people are listed under it.
    await bob.getByRole('button', { name: 'Your twelve words' }).click();
    const own = bob.getByRole('dialog', { name: 'Your twelve words' });
    const words = own.locator('[data-fingerprint-words]');
    await expect(words.getByRole('listitem')).toHaveCount(12, { timeout: 60_000 });
    bobWords = (await words.getAttribute('data-fingerprint-words'))!;
    expect(bobWords).toMatch(/^([a-z]+ ){11}[a-z]+$/);
    // An app that still shows the code can be checked against it.
    await own.getByRole('button', { name: 'Show as code' }).click();
    await expect(own.locator('[data-fingerprint]')).toHaveText(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
    bobFingerprint = (await own.locator('[data-fingerprint]').textContent())!.trim();
    await bob.keyboard.press('Escape');
    // The same words from the account menu, on any page: here one outside the drive.
    await bob.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(bob.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await bob.getByRole('button', { name: 'Account menu' }).click();
    await bob.getByRole('menuitem', { name: 'Your twelve words' }).click();
    await expect(
        bob.getByRole('dialog', { name: 'Your twelve words' }).locator('[data-fingerprint-words]'),
    ).toHaveAttribute('data-fingerprint-words', bobWords, { timeout: 60_000 });
    await bob.keyboard.press('Escape');
});

test('adding someone takes no words, checking them later shows theirs, and a pin survives a reload', async () => {
    await alice.goto('/app/contacts');
    await expect(alice.getByText('Nobody here yet')).toBeVisible({ timeout: 60_000 });
    const sheet = alice.locator('[data-slot=dialog-content]');
    await alice.getByRole('button', { name: 'Add someone' }).click();
    await sheet.getByLabel('Email').fill('nobody-here@hushos.local');
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(sheet.getByRole('alert')).toContainText(/No HushOS account/);

    // Added at once: no words, no second step.
    await sheet.getByLabel('Email').fill(bobEmail);
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(sheet).toHaveCount(0, { timeout: 60_000 });
    await expect(alice.getByText(/ added$/)).toBeVisible();
    const row = alice.locator(`[data-contact="${bobEmail}"]`);
    await expect(row).toHaveAttribute('data-standing', 'seen', { timeout: 60_000 });
    await expect(row).toContainText('Not verified');

    // Checking it's him, any time later, shows the very words Bob reads from his own device.
    // That opens on the words, never on an email form; a lookup that fails says so.
    const lookup = '**/api/auth/contacts/lookup';
    await alice.route(lookup, (route) =>
        route.continue({ postData: JSON.stringify({ email: 'nobody-here@hushos.local' }) }),
    );
    await row.getByRole('button', { name: /^More for/ }).click();
    await alice.getByRole('menuitem', { name: /^Check it’s / }).click();
    const check = sheet.filter({ hasText: /^Check it’s / });
    await expect(check.getByRole('alert')).toContainText(/No HushOS account/, { timeout: 60_000 });
    await expect(check.getByRole('textbox')).toHaveCount(0);
    await alice.unroute(lookup);
    await check.getByRole('button', { name: 'Try again' }).click();
    await expect(check.locator('[data-fingerprint-words]')).toHaveAttribute(
        'data-fingerprint-words',
        bobWords,
        { timeout: 60_000 },
    );
    // The code they come from is under Technical details, for an app that still shows it.
    await check.getByText('Technical details').click();
    await expect(check.locator('[data-fingerprint]')).toHaveText(bobFingerprint);
    await check.getByRole('button', { name: 'They match' }).click();
    await expect(check).toHaveCount(0);
    await expect(row).toHaveAttribute('data-standing', 'verified', { timeout: 60_000 });
    await expect(row).toContainText('Verified');

    // Pins live on the server under the settings key, so a fresh load has them.
    await alice.reload();
    await expect(alice.locator(`[data-contact="${bobEmail}"]`)).toHaveAttribute(
        'data-standing',
        'verified',
        { timeout: 60_000 },
    );
    // Adding the same person again is said so, not a second pin.
    await alice.getByRole('button', { name: 'Add someone' }).click();
    await sheet.getByLabel('Email').fill(bobEmail);
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(sheet.getByText(/is already in your contacts\.$/)).toBeVisible({
        timeout: 60_000,
    });
    await alice.keyboard.press('Escape');

    await alice
        .locator(`[data-contact="${bobEmail}"]`)
        .getByRole('button', { name: /^More for/ })
        .click();
    await alice.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(alice.getByRole('alertdialog')).toContainText(
        'keeps access to anything you’ve already shared.',
    );
    await alice.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(alice.getByText('Nobody here yet')).toBeVisible();
});

test('the management page opens for an operator granted from the command line and for nobody else', async () => {
    await alice.goto('/app/admin');
    await alice.waitForURL(/\/app\/drive$/);
    await expect(alice.getByRole('link', { name: 'Management' })).toHaveCount(0);

    operatorRole('grant', bobEmail);
    await bob.goto('/app/admin');
    await expect(bob.getByRole('heading', { name: 'Management' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(bob.getByRole('link', { name: 'Management' })).toBeVisible();
    await expect(bob.getByText('Objects missing')).toBeVisible();
    await expect(bob.getByRole('heading', { name: 'Missing objects' })).toBeVisible();
    await expect(bob.getByText(/Every audited object was found/)).toBeVisible();
    // The API refuses a member the way it refuses a missing page, lists included.
    for (const path of [
        '/api/admin/overview',
        '/api/admin/accounts',
        '/api/admin/workspaces',
        '/api/admin/accounts/00000000-0000-4000-8000-000000000000',
    ]) {
        const response = await alice.request.get(path);
        expect(response.status(), path).toBe(404);
    }

    // The Accounts count opens the list, which finds a person by email and opens them.
    await bob.getByRole('link', { name: /^Accounts/ }).click();
    await expect(bob).toHaveURL(/\/app\/admin\/accounts$/);
    await bob.getByRole('searchbox', { name: 'Search by email or name' }).fill(bobEmail);
    await expect(bob).toHaveURL(/q=/);
    const rows = bob.locator('[data-account]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-account', bobEmail);
    await rows.first().getByRole('link').click();
    await expect(bob.getByText(bobEmail)).toBeVisible();
    await expect(bob.getByText('Admin', { exact: true })).toBeVisible();
});
