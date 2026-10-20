import { expect, test, type Page } from '@playwright/test';
import { hydrated, landedOnHome, newFolder, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Signing out and in hold the screen still until the next page replaces it. Signing out
 * used to lock the device under the open folder, so the list gave way to "HushOS is locked
 * here" before the sign-in page came; signing in emptied the form before the app came, so
 * it looked for a moment as if it had failed. Each animation frame is read in the page,
 * since the bad state lasted only as long as a request.
 */

type Frame = {
    /* performance.now() when the frame was read. */
    t: number;
    app: boolean;
    email: string | null;
    rows: number;
    locked: boolean;
    /* "Opening your files" on screen. */
    opening: boolean;
    /* Skeleton rows on screen. */
    skeleton: boolean;
    /* The page's own title on screen ("Home"), with or without its list. */
    page: boolean;
};

/*
 * Records, every frame, whether the app is on screen (its account menu), the email field's
 * value, the Drive rows, and what Drive draws while it opens. The app's own DOM, not the
 * address: the router changes the address before the next page is drawn, and a redraw after
 * that would otherwise go unseen. Self-contained, so it also runs as an init script.
 */
function record() {
    const frames: Frame[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const shown = (element: Element) => element.getClientRects().length > 0;
    const tick = () => {
        frames.push({
            t: performance.now(),
            app: document.querySelector('button[aria-label="Account menu"]') !== null,
            email: document.querySelector<HTMLInputElement>('#email')?.value ?? null,
            rows: [...document.querySelectorAll('[data-node-id]')].filter(shown).length,
            locked: document.body.innerText.includes('HushOS is locked here'),
            opening: [...document.querySelectorAll('output')].some(
                (output) => shown(output) && output.textContent?.includes('Opening your files'),
            ),
            skeleton: [...document.querySelectorAll('output[aria-label="Loading"]')].some(shown),
            page: [...document.querySelectorAll('h1')].some(
                (heading) => shown(heading) && heading.textContent?.trim() === 'Home',
            ),
        });
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
const watch = (page: Page) => page.evaluate(record);
const frames = (page: Page) =>
    page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);

/* When the line says "Still opening" and the page shows as it is, placeholders and all. */
const LATE_MS = 4_000;
/* The line is mounted before the first frame that shows it, later still on a loaded runner. */
const MARGIN_MS = 1_000;

/*
 * From the moment the app is on screen until its list is: never the page with neither its
 * list nor skeleton rows, and never the line and skeleton rows at once. When the list came
 * well within the line's four seconds, one step: the line, then the list, with no skeleton
 * rows and no page before it. When it came later (a slow runner), the page may show with its
 * skeleton rows once the line has had about its four seconds, never sooner, and then the list.
 */
function openedWithoutSwap(recorded: Frame[]) {
    const app = recorded.filter((frame) => frame.app && !frame.locked);
    const listed = app.findIndex((frame) => frame.rows > 0);
    expect(listed).toBeGreaterThan(-1);
    const before = app.slice(0, listed);
    expect(before.filter((frame) => frame.page && !frame.skeleton)).toEqual([]);
    expect(before.filter((frame) => frame.opening && frame.skeleton)).toEqual([]);
    const line = (app.find((frame) => frame.opening) ?? app[0]!).t;
    if (app[listed]!.t - line < LATE_MS - MARGIN_MS) {
        expect(before.filter((frame) => frame.skeleton || frame.page)).toEqual([]);
    } else {
        const early = (frame: Frame) => frame.t - line < LATE_MS - MARGIN_MS;
        expect(before.filter((frame) => (frame.skeleton || frame.page) && early(frame))).toEqual(
            [],
        );
    }
}

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
    const leaving = (await frames(page)).filter((frame) => frame.app);
    expect(leaving.length).toBeGreaterThan(0);
    // As long as the app was on screen, the folder stayed as it was: never locked, never emptied.
    expect(leaving.filter((frame) => frame.locked || frame.rows !== 1)).toEqual([]);

    await page.waitForLoadState('networkidle');
    const field = page.getByRole('textbox', { name: /email/i });
    await hydrated(field);
    await field.fill(email);
    await page.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await watch(page);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await landedOnHome(page);
    await expect(page.locator('[data-node-id]')).toHaveCount(1);
    const recorded = await frames(page);
    const signingIn = recorded.filter((frame) => frame.email !== null);
    expect(signingIn.length).toBeGreaterThan(0);
    // The form kept what was typed until the app replaced it.
    expect(signingIn.filter((frame) => frame.email !== email)).toEqual([]);
    // Then the drive appeared in one step: the line, then the list.
    openedWithoutSwap(recorded);

    // A reload opens it again from the saved unlock, in one step too.
    await page.addInitScript(record);
    await page.reload();
    await expect(page.locator('[data-node-id]')).toHaveCount(1, { timeout: 60_000 });
    const reloaded = await frames(page);
    expect(reloaded.some((frame) => frame.opening)).toBe(true);
    openedWithoutSwap(reloaded);
});
