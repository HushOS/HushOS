import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { mailSubjects, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Passkeys and security keys as the second step, and the default method, in the web app
 * (docs/two-step-design.md 3, 12), against a server that offers two-step sign-in. The key is
 * Chromium's virtual authenticator, driven over the DevTools protocol: the page runs the real
 * WebAuthn ceremony through the browser, and the server verifies what the browser hands back.
 * What is proved here and nowhere else: the browser's sheet is asked for only on a press; the
 * step opens on the account's usual way, with the rest behind Use another way; a key answers
 * the step for a change as well as a sign-in; and the WebAuthn library is not part of the
 * sign-in page's first load.
 */

const twoStepOn = process.env.TWO_STEP_ENABLED === 'true';

test.beforeEach(({ browserName }) => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
    // The virtual authenticator is the DevTools protocol's, which only Chromium speaks.
    test.skip(browserName !== 'chromium', 'The virtual authenticator needs Chromium.');
});

/* The WebAuthn library, as the dev server names the module it serves it from. */
const LIBRARY = /simplewebauthn/i;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const section = (p: Page) => p.getByRole('region', { name: 'Two-step sign-in' });
const stepHeading = (p: Page) => p.getByRole('heading', { name: 'One more step' });
const inApp = (p: Page) => expect(p).toHaveURL(/\/app/, { timeout: 60_000 });
const keyRows = (p: Page) => section(p).locator('[data-two-step-key-row]');

/*
 * A security key plugged into this page: a CTAP2 key over USB that holds no resident keys and
 * asks for no PIN, as the server asks of one. It is touched as soon as it is asked.
 */
async function plugIn(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'usb',
            hasResidentKey: false,
            hasUserVerification: false,
            isUserVerified: false,
            automaticPresenceSimulation: true,
        },
    });
    return {
        credentials: async () =>
            (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    };
}

async function account(browser: Browser) {
    const page = await newPage(browser);
    const person = await registerAccount(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible();
    return { page, ...person };
}

async function signOut(page: Page) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.waitForLoadState('networkidle');
}

async function enterPassword(page: Page, email: string) {
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(PASSWORD);
    await field.press('Enter');
}

async function another(scope: Page | Locator, way: string) {
    await scope.getByRole('button', { name: 'Use another way' }).click();
    await scope.getByRole('button', { name: way }).click();
}

/* The ten codes on screen, then Done. */
async function saveCodes(page: Page) {
    await expect(dialog(page).getByRole('heading', { name: 'Save your backup codes' })).toBeVisible(
        { timeout: 60_000 },
    );
    const codes = await dialog(page)
        .getByRole('list', { name: 'Backup codes' })
        .locator('li')
        .allInnerTexts();
    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await expect(dialog(page)).toHaveCount(0);
    return codes;
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

test('a security key turns the step on, signs in on a press, and is the step for removing itself', async ({
    browser,
}) => {
    test.setTimeout(420_000);
    const { page, email } = await account(browser);
    const key = await plugIn(page);
    // What the last test looks for on the sign-in page, seen here where it is used: the name
    // it goes by in this build, so that test cannot pass by looking for the wrong thing.
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    // Adding: the password, then the key, asked only on the press of Add.
    await section(page).getByRole('button', { name: 'Add passkey or security key' }).click();
    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(page).getByRole('heading', { name: 'Add your passkey or security key' }),
    ).toBeVisible({ timeout: 60_000 });
    // The options are here and the key is plugged in, but nothing has asked it yet.
    expect(await key.credentials()).toHaveLength(0);
    await dialog(page).getByLabel('Name').fill('Desk key');
    // The account's other devices are offered for removal, as whenever the step is turned on.
    await expect(
        dialog(page).getByRole('checkbox', { name: /Remove my other devices/ }),
    ).toBeChecked();
    await dialog(page).getByRole('button', { name: 'Add and turn on' }).click();
    const codes = await saveCodes(page);
    expect(codes).toHaveLength(10);
    expect(await key.credentials()).toHaveLength(1);
    expect(requested.some((url) => LIBRARY.test(url))).toBe(true);

    // The list: the key by its name, not synced, and the step on by it alone.
    await expect(section(page).locator('[data-two-step=on]')).toBeVisible();
    await expect(keyRows(page)).toHaveCount(1);
    await expect(keyRows(page).first()).toContainText('Desk key');
    await expect(keyRows(page).first()).not.toContainText('Saved in a password manager');
    await expect(section(page).getByText('10 of 10 left')).toBeVisible();
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('Two-step sign-in is on');

    // Signing in: the step opens on the key, as a button. Nothing asks the key until it is pressed.
    await signOut(page);
    const before = (await key.credentials())[0]!.signCount;
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    const use = page.getByRole('button', { name: 'Use your passkey' });
    await expect(use).toBeVisible();
    await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);
    // Long enough for a sheet opened on load to have used the key: it has not been used.
    await page.waitForTimeout(1_500);
    expect((await key.credentials())[0]!.signCount).toBe(before);
    await expect(page).toHaveURL(/\/login/);
    await use.click();
    await inApp(page);
    expect((await key.credentials())[0]!.signCount).toBeGreaterThan(before);

    // The log says how, by the kind of method and never the key's name.
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    const activity = section(page).getByRole('list', { name: 'Recent security activity' });
    await expect(activity).toContainText(
        'Signed in with your password and a passkey or security key',
    );
    await expect(activity).not.toContainText('Desk key');

    // Renaming needs no password: it is a label.
    await keyRows(page).first().getByRole('button', { name: 'Rename Desk key' }).click();
    await dialog(page).getByLabel('Name').fill('Blue key');
    await dialog(page).getByRole('button', { name: 'Save name' }).click();
    await expect(keyRows(page).first()).toContainText('Blue key', { timeout: 60_000 });

    // The only method: its button turns the step off, and the key itself answers the step for it.
    await keyRows(page).first().getByRole('button', { name: 'Turn off Blue key' }).click();
    const off = dialog(page);
    await expect(off.getByRole('heading', { name: 'Turn off two-step sign-in?' })).toBeVisible();
    await off.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(off.getByText('Passkey or security key', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await off.getByRole('button', { name: 'Turn off' }).click();
    await expect(section(page).getByText('Off. Your password alone signs you in.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(keyRows(page)).toHaveCount(0);
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('Two-step sign-in is off');
    await page.context().close();
});

test('the step opens on the default, the rest wait behind Use another way, and Make default moves it', async ({
    browser,
}) => {
    test.setTimeout(480_000);
    const { page, email } = await account(browser);
    await plugIn(page);

    // The app first: it is the default.
    await section(page).getByRole('button', { name: 'Add authenticator app' }).click();
    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect(
        dialog(page).getByRole('img', { name: 'A code for your authenticator app' }),
    ).toBeVisible({ timeout: 60_000 });
    const secret = await dialog(page).locator('[data-two-step-key]').innerText();
    // This step's code: still inside the server's window if the clock turns before it looks.
    await dialog(page).getByLabel('Code from your authenticator app').fill(totp(secret));
    await dialog(page).getByRole('button', { name: 'Turn on' }).click();
    const codes = await saveCodes(page);

    // Then a key, with a backup code as the step for adding it.
    await section(page).getByRole('button', { name: 'Add passkey or security key' }).click();
    const add = dialog(page);
    await add.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(add.getByLabel('Code from your authenticator app')).toBeVisible({
        timeout: 60_000,
    });
    await another(add, 'Use a backup code');
    await add.getByLabel('Backup code').fill(codes[0]!);
    await add.getByRole('button', { name: 'Continue' }).click();
    await expect(
        add.getByRole('heading', { name: 'Add your passkey or security key' }),
    ).toBeVisible({ timeout: 60_000 });
    // A second method turns nothing on: no devices are offered for removal.
    await expect(add.getByRole('checkbox', { name: /Remove my other devices/ })).toHaveCount(0);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(keyRows(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(keyRows(page).first()).toContainText('Security key');
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('A passkey or security key was added');

    // The app is still the default: Default is beside it, Make default beside the key.
    const appRow = section(page).locator('[data-two-step-app]');
    const keysRow = section(page).locator('[data-two-step-keys]');
    await expect(appRow.getByText('Default', { exact: true })).toBeVisible();
    await expect(keysRow.getByText('Default', { exact: true })).toHaveCount(0);
    // With the app also on, the page says what a passkey does and does not stop.
    await expect(
        section(page).getByText(/stops a fake sign-in page only when you use it/),
    ).toBeVisible();

    // So a sign-in opens on the code, and the key is one of the other ways.
    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Code from your authenticator app')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Use your passkey' })).toHaveCount(0);
    await expect(
        page.getByRole('button', { name: 'Use your passkey or security key' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Use another way' }).click();
    await expect(page.getByRole('button', { name: /^Use (your|a) / })).toHaveText([
        'Use your passkey or security key',
        'Use a backup code',
        'Use your recovery phrase',
    ]);
    await page.getByRole('button', { name: 'Use your passkey or security key' }).click();
    await page.getByRole('button', { name: 'Use your passkey' }).click();
    await inApp(page);

    // Make default: no password, and the next sign-in opens on the key.
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await section(page)
        .getByRole('button', { name: 'Make passkey or security key the default' })
        .click();
    await expect(
        section(page).getByText('Passkey or security key is now asked for first.'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
        section(page).locator('[data-two-step-keys]').getByText('Default', { exact: true }),
    ).toBeVisible();
    await expect(
        section(page).getByRole('button', { name: 'Make authenticator app the default' }),
    ).toBeVisible();
    await expect(
        section(page).getByRole('list', { name: 'Recent security activity' }),
    ).toContainText('Default changed to passkey or security key');

    await signOut(page);
    await enterPassword(page, email);
    await expect(stepHeading(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Use your passkey' })).toBeVisible();
    await expect(page.getByLabel('Code from your authenticator app')).toHaveCount(0);

    await page.getByRole('button', { name: 'Use your passkey' }).click();
    await inApp(page);

    // Removing the key (not the last method) is Remove, and the app is the default again.
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await keyRows(page).first().getByRole('button', { name: 'Remove Security key' }).click();
    const remove = dialog(page);
    await expect(
        remove.getByRole('heading', { name: 'Remove this passkey or security key?' }),
    ).toBeVisible();
    await remove.getByLabel('Password', { exact: true }).fill(PASSWORD);
    // The step for it opens on the default too: the key that is about to go.
    await expect(remove.getByText('Passkey or security key', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await remove.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(section(page).getByText('Passkey or security key removed.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(keyRows(page)).toHaveCount(0);
    await expect(section(page).locator('[data-two-step=on]')).toBeVisible();
    await expect(
        section(page).getByRole('list', { name: 'Recent security activity' }),
    ).toContainText('Default changed to authenticator app');
    await page.context().close();
});

test('the WebAuthn library is not part of the sign-in page’s first load', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await newPage(browser);
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto('/login', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(requested.length).toBeGreaterThan(5);
    expect(requested.filter((url) => LIBRARY.test(url))).toEqual([]);
    await page.context().close();
});
