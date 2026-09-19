import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { newContext, registerAccount } from './helpers';

/*
 * Contacts and the management area, driven as two people: one publishes an
 * identity and reads their own fingerprint, the other looks them up, sees the
 * same fingerprint, pins it, and finds the pin on a reload. Then one of them is
 * made an operator from the command line and reaches the overview; the other
 * is turned away.
 */

test.describe.configure({ mode: 'serial' });

let alice: Page;
let bob: Page;
let bobEmail: string;
let bobFingerprint: string;

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

test('everyone sees their own fingerprint, ten groups of four', async () => {
    await bob.goto('/app/contacts');
    const own = bob.locator('section', { hasText: 'Your fingerprint' }).locator('button').first();
    await expect(own).toHaveText(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/, { timeout: 60_000 });
    bobFingerprint = (await own.textContent())!.trim();
});

test('a lookup shows the other person’s fingerprint, and a pin survives a reload', async () => {
    await alice.goto('/app/contacts');
    await expect(alice.getByText('Nobody pinned yet.')).toBeVisible({ timeout: 60_000 });
    await alice.getByLabel('Email').fill('nobody-here@hushos.local');
    await alice.getByRole('button', { name: 'Look up' }).click();
    await expect(alice.getByRole('alert')).toContainText(/No HushOS account/);

    await alice.getByLabel('Email').fill(bobEmail);
    await alice.getByRole('button', { name: 'Look up' }).click();
    await expect(alice.locator('[data-fingerprint]')).toHaveText(bobFingerprint);
    await expect(alice.locator('[data-kem]')).toHaveAttribute('data-kem', 'signed');
    await alice.getByRole('button', { name: 'Pin contact' }).click();
    await expect(alice.getByText(/pinned$/)).toBeVisible();
    const row = alice.locator(`[data-contact="${bobEmail}"]`);
    await expect(row).toContainText(bobFingerprint);

    // Pins live on the server under the identity key, so a fresh load has them.
    await alice.reload();
    await expect(alice.locator(`[data-contact="${bobEmail}"]`)).toContainText(bobFingerprint, {
        timeout: 60_000,
    });
    // Looking the same person up again is a no-op, not a second pin.
    await alice.getByLabel('Email').fill(bobEmail);
    await alice.getByRole('button', { name: 'Look up' }).click();
    await expect(alice.getByText('Already pinned with this key.')).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Pin contact' })).toHaveCount(0);

    await alice.getByRole('button', { name: `Remove ${'E2E Tester'}` }).click();
    await expect(alice.getByText('Nobody pinned yet.')).toBeVisible();
});

test('the management page opens for an operator granted from the command line and for nobody else', async () => {
    await alice.goto('/app/admin');
    await alice.waitForURL(/\/app\/drive$/);
    await expect(alice.getByRole('link', { name: 'Management' })).toHaveCount(0);

    execFileSync('bun', ['run', 'admin:grant', bobEmail], { stdio: 'pipe' });
    await bob.goto('/app/admin');
    await expect(bob.getByRole('heading', { name: 'Management' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(bob.getByRole('link', { name: 'Management' })).toBeVisible();
    await expect(bob.getByText('Objects missing')).toBeVisible();
    await expect(bob.getByRole('heading', { name: 'Missing objects' })).toBeVisible();
    await expect(bob.getByText(/Every audited object was found/)).toBeVisible();
    // The API refuses a member the way it refuses a missing page.
    const response = await alice.request.get('/api/admin/overview');
    expect(response.status()).toBe(404);
});
