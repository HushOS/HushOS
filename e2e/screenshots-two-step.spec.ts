import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { newContext as baseContext, PASSWORD, registerAccount } from './helpers';
import { ZONE } from './morning-zone';

/*
 * Not a test: the pictures of two-step sign-in for the blog post (two-step-sign-in.mdx), taken
 * from a fresh account, so they never show anyone's data. Run on demand, against a server with
 * TWO_STEP_ENABLED=true and TRUSTED_COUNTRY_HEADER=cf-ipcountry, TRUSTED_REGION_HEADER=cf-region,
 * TRUSTED_CITY_HEADER=cf-ipcity (the place in the approval prompt comes from those headers):
 * `SCREENSHOTS=1 bunx playwright test e2e/screenshots-two-step.spec.ts --project=chromium`.
 * Output lands in apps/web/src/screenshots, as e2e/screenshots.spec.ts's does.
 *
 * Three browsers on one account: Maya's laptop, which holds a passkey (Chromium's virtual
 * authenticator) and turns every method on; a second browser, which approves turning on
 * Approve on another device; and a new browser signing in from Lyon, which the laptop approves.
 * The flows are live (a code is shown once), so each picture's dark twin is taken from the same
 * page with the colour scheme switched under it, and its 1.5x scale is the 2x picture drawn
 * smaller by a browser, where e2e/screenshots.spec.ts opens a 1.5x context and runs again.
 */

test.skip(!process.env.SCREENSHOTS, 'Screenshots are taken on demand.');
test.skip(process.env.TWO_STEP_ENABLED !== 'true', 'Two-step sign-in is off (TWO_STEP_ENABLED).');

// A press that finds nothing fails here, not at the end of the run.
test.use({ actionTimeout: 30_000 });

const OUT = 'apps/web/src/screenshots';
const VIEWPORT = { width: 1280, height: 800 };
const MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';

const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const section = (p: Page) => p.getByRole('region', { name: 'Two-step sign-in' });
const stepHeading = (p: Page) => p.getByRole('heading', { name: 'One more step' });
const waiting = (p: Page) => p.locator('[data-approval]');
const answer = (p: Page) => p.locator('[data-approval-answer]');
const toasts = (p: Page) => p.locator('[data-slot=toast]');

function context(browser: Browser, userAgent: string, headers: Record<string, string> = {}) {
    return baseContext(browser, {
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: 'light',
        timezoneId: ZONE,
        userAgent,
        extraHTTPHeaders: headers,
    });
}

/* RFC 6238, as an authenticator app computes it from the key the page shows. */
function totp(base32: string, step = Math.floor(Date.now() / 30_000)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const character of base32.replace(/\s/g, '').toUpperCase())
        bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac('sha1', key).update(counter).digest();
    const offset = mac[mac.length - 1]! & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/* A passkey on this page: a platform authenticator that verifies its user and syncs. */
async function passkey(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            defaultBackupEligibility: true,
            defaultBackupState: true,
        },
    });
}

async function openAccount(page: Page) {
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible({
        timeout: 60_000,
    });
}

async function enterPassword(page: Page, email: string) {
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(PASSWORD);
    await field.press('Enter');
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
}

/* The 2x picture at `from`, drawn at 1.5 device pixels per CSS pixel and saved to `to`. */
async function smaller(browser: Browser, from: string, to: string, width: number, height: number) {
    const drawn = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5 });
    const page = await drawn.newPage();
    await page.setContent(
        `<body style="margin:0"><img src="data:image/png;base64,${readFileSync(from).toString('base64')}" style="display:block;width:${width}px;height:${height}px"></body>`,
    );
    await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
    await page.screenshot({ path: to });
    await drawn.close();
}

/*
 * One picture of `target` with `margin` CSS pixels of the page around it, in both themes and at
 * the three scales Shot serves. The 2x context yields the 1x picture too.
 */
async function shoot(browser: Browser, page: Page, target: Locator, name: string, margin = 24) {
    await expect(toasts(page)).toHaveCount(0, { timeout: 30_000 });
    for (const [suffix, colorScheme] of [
        ['', 'light'],
        ['-dark', 'dark'],
    ] as const) {
        await page.emulateMedia({ colorScheme });
        await page.waitForTimeout(400);
        const box = (await target.boundingBox())!;
        // Whole, even CSS pixels, so every scale is a whole number of pixels.
        const even = (value: number) => 2 * Math.ceil(value / 2);
        const x = Math.max(0, Math.floor(box.x - margin));
        const y = Math.max(0, Math.floor(box.y - margin));
        const view = page.viewportSize()!;
        const clip = {
            x,
            y,
            width: Math.min(even(box.x + box.width + margin - x), view.width - x),
            height: Math.min(even(box.y + box.height + margin - y), view.height - y),
        };
        const path = `${OUT}/${name}${suffix}`;
        await page.screenshot({ path: `${path}.png`, clip });
        await page.screenshot({ path: `${path}@1x.png`, clip, scale: 'css' });
        await smaller(browser, `${path}.png`, `${path}@1.5x.png`, clip.width, clip.height);
        // What Shot is given as width and height: the 2x picture's size.
        console.log(`${name}${suffix}: ${clip.width * 2} x ${clip.height * 2}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
}

test('two-step sign-in: the settings, the step, and a sign-in approved on another device', async ({
    browser,
}) => {
    test.setTimeout(900_000);

    // Maya's laptop: a new account, and a passkey as its first method, so it is the default.
    const laptop = await (await context(browser, MAC)).newPage();
    const { email } = await registerAccount(laptop, 'Maya Lindqvist');
    await openAccount(laptop);
    await passkey(laptop);
    await section(laptop).getByRole('button', { name: 'Add passkey or security key' }).click();
    await dialog(laptop).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(laptop).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(laptop).getByRole('heading', { name: 'Add your passkey or security key' }),
    ).toBeVisible({ timeout: 60_000 });
    await dialog(laptop).getByLabel('Name').fill('MacBook Air');
    await dialog(laptop).getByRole('button', { name: 'Add and turn on' }).click();
    await expect(
        dialog(laptop).getByRole('heading', { name: 'Save your backup codes' }),
    ).toBeVisible({ timeout: 60_000 });
    await dialog(laptop).getByRole('button', { name: 'Done' }).click();
    await expect(dialog(laptop)).toHaveCount(0);
    await expect(section(laptop).locator('[data-two-step=on]')).toBeVisible({ timeout: 60_000 });

    // The authenticator app, with the passkey as the step for adding it.
    await section(laptop).getByRole('button', { name: 'Add authenticator app' }).click();
    const app = dialog(laptop);
    await app.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(app.getByText('Passkey or security key', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await app.getByRole('button', { name: 'Continue' }).click();
    await expect(app.getByRole('img', { name: 'A code for your authenticator app' })).toBeVisible({
        timeout: 60_000,
    });
    const secret = await app.locator('[data-two-step-key]').innerText();
    await app.getByLabel('Code from your authenticator app').fill(totp(secret));
    await app.getByRole('button', { name: 'Add app', exact: true }).click();
    await expect(dialog(laptop)).toHaveCount(0, { timeout: 60_000 });
    await expect(section(laptop).locator('[data-two-step-app]')).not.toContainText('Not added');

    // A second browser signs in with the next code, so it is another device that passed the step.
    const second = await (await context(browser, FIREFOX)).newPage();
    await enterPassword(second, email);
    await second.getByRole('button', { name: 'Use another way' }).click();
    await second.getByRole('button', { name: 'Use your authenticator app' }).click();
    await second
        .getByLabel('Code from your authenticator app')
        .fill(totp(secret, Math.floor(Date.now() / 30_000) + 1));
    await second.getByLabel('Code from your authenticator app').press('Enter');
    await expect(second).toHaveURL(/\/app/, { timeout: 60_000 });

    // Approve on another device, turned on from the laptop and approved by the second browser.
    await openAccount(laptop);
    await section(laptop)
        .getByRole('button', { name: 'Turn on Approve on another device' })
        .click();
    const setup = dialog(laptop);
    const choices = setup.getByRole('group', { name: 'Device that will approve' });
    await choices.getByRole('radio').first().check();
    const approver = (await choices.locator('label').first().innerText()).trim();
    await setup.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(setup.getByText('Passkey or security key', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await setup.getByRole('button', { name: 'Continue' }).click();
    await expect(setup.getByRole('heading', { name: `Approve on ${approver}` })).toBeVisible({
        timeout: 60_000,
    });
    await openAccount(second);
    await expect(waiting(second)).toHaveCount(1, { timeout: 30_000 });
    await waiting(second).getByRole('button', { name: 'Answer' }).click();
    await answer(second).getByRole('button', { name: 'Approve' }).click();
    const drawn = answer(second).locator('[data-approval-code]');
    await expect(drawn).toHaveText(/^\d{2} [a-z]+$/, { timeout: 60_000 });
    await setup.getByLabel(`Code on ${approver}`).fill(await drawn.innerText());
    await setup.getByRole('button', { name: /^(Turn on|Add)$/ }).click();
    await expect(dialog(laptop)).toHaveCount(0, { timeout: 60_000 });
    await expect(section(laptop).locator('[data-two-step-device=on]')).toBeVisible({
        timeout: 60_000,
    });
    await second.context().close();

    // Picture 1: the three ways, the passkey marked Default.
    await openAccount(laptop);
    await expect(
        section(laptop).locator('[data-two-step-keys]').getByText('Default', { exact: true }),
    ).toBeVisible();
    await section(laptop).scrollIntoViewIfNeeded();
    await shoot(browser, laptop, section(laptop), 'two-step-settings');

    // A new browser, in Lyon as far as the proxy's headers say, signs in with the password.
    const visitor = await (
        await context(browser, WINDOWS, {
            'cf-ipcountry': 'FR',
            'cf-region': 'Auvergne-Rh%C3%B4ne-Alpes',
            'cf-ipcity': 'Lyon',
        })
    ).newPage();
    await enterPassword(visitor, email);
    await expect(visitor.getByRole('button', { name: 'Use your passkey' })).toBeVisible();
    await visitor.getByRole('button', { name: 'Use another way' }).click();
    await expect(visitor.getByRole('button', { name: 'Use another device' })).toBeVisible();

    // Picture 2: the step, opened on the default, with the other ways listed.
    const card = visitor.getByRole('region', { name: 'One more step' });
    await shoot(browser, visitor, card, 'two-step-step', 32);

    // It asks another device. The laptop is asked, and opens the request.
    await visitor.getByRole('button', { name: 'Use another device' }).click();
    const idle = visitor.locator('[data-device-ask=idle]').getByRole('button', {
        name: 'Use another device',
    });
    if (await idle.isVisible().catch(() => false)) await idle.click();
    await expect(visitor.locator('[data-device-ask=waiting]')).toBeVisible({ timeout: 30_000 });
    // From Trash, where the line above the app offers Answer, in a window tall enough that the
    // dialog, which sits in its middle, is clear of the page's own words: the picture is the
    // dialog and nothing beside it.
    await laptop.setViewportSize({ width: VIEWPORT.width, height: 1600 });
    await laptop.goto('/app/trash', { waitUntil: 'networkidle' });
    await laptop.locator('[data-approval-banner]').getByRole('button', { name: 'Answer' }).click();
    await expect(answer(laptop).getByRole('heading', { name: /^Sign-in on / })).toBeVisible();
    const shown = visitor.locator('[data-device-code]');
    await expect(shown).toHaveText(/^\d{2} [a-z]+$/, { timeout: 30_000 });
    const code = await shown.innerText();

    // Picture 3: the new browser shows its code.
    await shoot(browser, visitor, card, 'two-step-code', 32);

    // Picture 4: the laptop's prompt, with the code typed.
    const field = answer(laptop).getByLabel('Code on the other device');
    await field.fill(code);
    await field.blur();
    // The form itself has no box of its own (display: contents); the dialog around it has.
    await shoot(browser, laptop, dialog(laptop), 'two-step-approve', 8);

    // Approved: the new browser is signed in by itself.
    await answer(laptop).getByRole('button', { name: 'Approve' }).click();
    await expect(visitor).toHaveURL(/\/app/, { timeout: 60_000 });
    await visitor.context().close();
    await laptop.context().close();
});
