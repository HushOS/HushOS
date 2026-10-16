import { expect, test, type Page } from '@playwright/test';
import { landedOnHome, mailSubjects, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Devices, step 1 (docs/devices-design.md), with two browsers on one account:
 * each lists the other, a sign-in with the password alone is emailed, a device
 * can be renamed and removed from the other, a removed browser is signed out
 * and clears what it kept, a lock and unlock or a password change keeps the
 * device it happens on, and Remove all other devices leaves only the one asking.
 */

const NEW_SIGN_IN = 'New sign-in to your account · HushOS';
const REMOVED = 'A device was removed from your account · HushOS';
const ALL_REMOVED = 'Devices were removed from your account · HushOS';

const devices = (page: Page) => page.getByRole('list', { name: 'Your devices' });
const rows = (page: Page) => devices(page).locator('[data-device-id]');
const current = (page: Page) =>
    rows(page).filter({ has: page.getByText('This browser', { exact: true }) });

async function openDevices(page: Page) {
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(devices(page)).toBeVisible({ timeout: 60_000 });
}

async function currentId(page: Page) {
    await openDevices(page);
    await expect(current(page)).toHaveCount(1);
    return (await current(page).getAttribute('data-device-id'))!;
}

async function signIn(page: Page, email: string, password = PASSWORD) {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(password);
    await field.press('Enter');
    await landedOnHome(page);
}

async function count(email: string, subject: string) {
    return (await mailSubjects(email)).filter((value) => value === subject).length;
}

test('two browsers on one account list, rename and remove each other', async ({ browser }) => {
    test.setTimeout(420_000);
    const a = await newPage(browser);
    const { email } = await registerAccount(a);
    // Signing up is the enrolment device: no notice for it.
    expect(await count(email, NEW_SIGN_IN)).toBe(0);

    const b = await newPage(browser);
    await signIn(b, email);
    await expect.poll(() => count(email, NEW_SIGN_IN), { timeout: 30_000 }).toBe(1);

    // Each lists both, itself first and marked; the other is signed in with the password.
    const bId = await currentId(b);
    const aId = await currentId(a);
    expect(aId).not.toBe(bId);
    await expect(rows(a)).toHaveCount(2);
    await expect(rows(a).first()).toHaveAttribute('data-device-id', aId);
    const bRow = devices(a).locator(`[data-device-id="${bId}"]`);
    await expect(bRow).toContainText('Signed in with your password');
    await expect(bRow).toContainText('Active today');
    await expect(current(a)).toContainText('Where you created your account');
    // This browser has no Remove: signing out is how it leaves.
    await expect(current(a).getByRole('button', { name: /^Remove/ })).toHaveCount(0);

    // A renames B.
    await bRow.getByRole('button', { name: /^Rename/ }).click();
    const rename = a.getByRole('dialog');
    await rename.getByLabel('Name').fill('Work laptop');
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(rename).toHaveCount(0);
    await expect(bRow).toContainText('Work laptop');

    // A removes B: B is signed out at once, and its own key and saved unlock go.
    await bRow.getByRole('button', { name: 'Remove Work laptop' }).click();
    const confirm = a.getByRole('alertdialog');
    await expect(confirm).toContainText('Remove Work laptop?');
    await expect(confirm).toContainText('may stay there');
    // Removing asks for the password: a session alone cannot sign the other devices out.
    const remove = confirm.getByRole('button', { name: 'Remove', exact: true });
    await expect(remove).toBeDisabled();
    await confirm.getByLabel('Your password', { exact: true }).fill('not-my-password-at-all');
    await remove.click();
    await expect(confirm).toContainText('isn’t right', { timeout: 60_000 });
    // Behind the dialog (hidden from roles while it is open): B is still listed, and the wrong
    // password left this browser unlocked.
    await expect(a.locator(`li[data-device-id="${bId}"]`)).toBeVisible();
    await expect(a.locator('button', { hasText: 'Lock on this browser' })).toBeVisible();
    await confirm.getByLabel('Your password', { exact: true }).fill(PASSWORD);
    await remove.click();
    await expect(bRow).toHaveCount(0);
    await expect.poll(() => count(email, REMOVED), { timeout: 30_000 }).toBe(1);

    await b.goto('/app', { waitUntil: 'networkidle' });
    await expect(b).toHaveURL(/\/login/, { timeout: 60_000 });
    // Said as what happened, not as a password change.
    await expect(b.getByText('This browser was removed from your account.')).toBeVisible({
        timeout: 30_000,
    });
    await expect
        .poll(
            () =>
                b.evaluate(
                    () =>
                        new Promise<number>((resolve) => {
                            const request = indexedDB.open('hushos-device-identity', 1);
                            request.onupgradeneeded = () =>
                                request.result.createObjectStore('identity');
                            request.onsuccess = () => {
                                const db = request.result;
                                const counting = db
                                    .transaction('identity', 'readonly')
                                    .objectStore('identity')
                                    .count();
                                counting.onsuccess = () => {
                                    resolve(counting.result);
                                    db.close();
                                };
                            };
                        }),
                ),
            { timeout: 30_000 },
        )
        .toBe(0);
    expect(await b.evaluate(() => localStorage.getItem('hushos-device-unlock'))).not.toMatch(
        /"device":\{/,
    );

    // B signs in again: a new device, the removed one stays gone, and the notice is sent again.
    await signIn(b, email);
    const bAgain = await currentId(b);
    expect(bAgain).not.toBe(bId);
    await openDevices(a);
    await expect(rows(a)).toHaveCount(2);
    await expect(devices(a).locator(`[data-device-id="${bId}"]`)).toHaveCount(0);
    await expect.poll(() => count(email, NEW_SIGN_IN), { timeout: 30_000 }).toBe(2);

    // Lock and unlock on A: the same device, and no new one.
    await a.getByRole('button', { name: 'Lock on this browser' }).click();
    await a.getByRole('alertdialog').getByRole('button', { name: 'Lock', exact: true }).click();
    await a.getByRole('button', { name: 'Unlock on this browser' }).click();
    const unlock = a.getByRole('dialog');
    await unlock.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await unlock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(unlock).toHaveCount(0, { timeout: 60_000 });
    expect(await currentId(a)).toBe(aId);
    await expect(rows(a)).toHaveCount(2);
    expect(await count(email, NEW_SIGN_IN)).toBe(2);

    // A password change on A: B is signed out, A is still the same device.
    const newPassword = `${PASSWORD}-changed`;
    await a.getByRole('button', { name: 'Change password' }).click();
    const change = a.getByRole('dialog');
    await change.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await change.getByLabel('New password', { exact: true }).fill(newPassword);
    await change.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
    await change.getByRole('button', { name: 'Change password' }).click();
    await expect(a.getByText('Password changed.')).toBeVisible({ timeout: 120_000 });
    expect(await currentId(a)).toBe(aId);
    const bSignedOut = devices(a).locator(`[data-device-id="${bAgain}"]`);
    await expect(bSignedOut).toContainText('Signed out');

    // Remove all other devices: only A is left.
    await a.getByRole('button', { name: 'Remove all other devices' }).click();
    const all = a.getByRole('alertdialog');
    await all.getByLabel('Your password', { exact: true }).fill(newPassword);
    await all.getByRole('button', { name: 'Remove all other devices' }).click();
    await expect(rows(a)).toHaveCount(1);
    await expect(rows(a).first()).toHaveAttribute('data-device-id', aId);
    await expect.poll(() => count(email, ALL_REMOVED), { timeout: 30_000 }).toBe(1);
    // A coming back to its own device after the password change sent no new-sign-in notice:
    // that notice went out before the removal notice that just arrived, if at all.
    expect(await count(email, NEW_SIGN_IN)).toBe(2);

    await a.context().close();
    await b.context().close();
});
