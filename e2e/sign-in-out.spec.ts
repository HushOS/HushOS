import { expect, test, type Page } from '@playwright/test';
import { hydrated, landedOnHome, newFolder, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Signing out and in hold the screen still until the next page replaces it. Signing out
 * used to lock the device under the open folder, so the list gave way to "HushOS is locked
 * here" before the sign-in page came; signing in emptied the form before the app came, so
 * it looked for a moment as if it had failed. Each animation frame is read in the page,
 * since the bad state lasted only as long as a request.
 */

type Frame = { path: string; email: string | null; rows: number; locked: boolean };

/* Records, every frame, the path, the email field's value and the Drive rows on screen. */
function watch(page: Page) {
    return page.evaluate(() => {
        const frames: Frame[] = [];
        (window as unknown as { __frames: typeof frames }).__frames = frames;
        const tick = () => {
            frames.push({
                path: location.pathname,
                email: document.querySelector<HTMLInputElement>('#email')?.value ?? null,
                rows: document.querySelectorAll('[data-node-id]').length,
                locked: document.body.innerText.includes('HushOS is locked here'),
            });
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}
const frames = (page: Page) =>
    page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);

test('signing out and back in never redraws the page being left', async ({ browser }) => {
    const page = await newPage(browser);
    const { email } = await registerAccount(page);
    await newFolder(page);
    await page.getByPlaceholder('Reports/2026').fill('Kept in view');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-node-id]')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await watch(page);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    const leaving = (await frames(page)).filter((frame) => frame.path.startsWith('/app'));
    expect(leaving.length).toBeGreaterThan(0);
    // Until the address changed, the folder stayed as it was: never locked, never emptied.
    expect(leaving.filter((frame) => frame.locked || frame.rows !== 1)).toEqual([]);

    await page.waitForLoadState('networkidle');
    const field = page.getByRole('textbox', { name: /email/i });
    await hydrated(field);
    await field.fill(email);
    await page.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await watch(page);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await landedOnHome(page);
    const signingIn = (await frames(page)).filter((frame) => frame.email !== null);
    expect(signingIn.length).toBeGreaterThan(0);
    // The form kept what was typed until the app replaced it.
    expect(signingIn.filter((frame) => frame.email !== email)).toEqual([]);
});
