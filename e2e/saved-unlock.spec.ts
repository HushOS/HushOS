import { expect, test, type Page } from '@playwright/test';
import { newPage, registerAccount } from './helpers';

/*
 * Leaving a page while it restores the saved unlock must keep the unlock. Leaving locks the
 * app (pagehide), which cuts the restore short; that says nothing about the saved device, so
 * the next visit must open Drive without the password. The restore asks for the crypto worker
 * once it has the device key, so the departure is timed from that request, a few delays after
 * it: a fixed delay from the start lands on a different step on every machine and build.
 */

const DELAYS = [0, 25, 50, 100, 200];

const saved = (page: Page) =>
    page.evaluate(() => /"device":\{/.test(localStorage.getItem('hushos-device-unlock') ?? ''));

test('leaving while the saved unlock is restored keeps it', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await newPage(browser);
    await registerAccount(page);
    expect(await saved(page)).toBe(true);
    const restores: string[] = [];
    page.on('console', (message) => {
        if (message.text().startsWith('Device restore')) restores.push(message.text());
    });

    for (const delay of DELAYS) {
        const worker = page.waitForRequest(/auth\.worker/, { timeout: 60_000 });
        await page.goto('/app/drive', { waitUntil: 'commit' });
        await worker;
        await page.waitForTimeout(delay);
        await page.goto('about:blank');

        // The next visit opens Drive from the saved unlock, without asking for the password.
        await page.goto('/app/drive');
        await expect(page.getByText('Nothing here yet'), `left ${delay} ms in`).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByText('HushOS is locked here')).toHaveCount(0);
        expect(await saved(page), `left ${delay} ms in: ${restores.join(' | ')}`).toBe(true);
    }

    await page.context().close();
});
