import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { landedOnHome, mailSubjects, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * Approve on another device as the second step, in the web app (docs/two-step-design.md 12),
 * with two browsers on one account, against a server that offers two-step sign-in. What is
 * proved here and nowhere else: the two pages really exchange the commitment, the code and
 * the signature through the server, each computing its half in the browser; the person
 * chooses the device that turns the method on; a sign-in asks nothing of the other device
 * until a press; a wrong code and Deny both end the request without signing anyone in, and
 * are counted; the right code signs the other browser in by itself; and a change is not
 * offered the method while the devices are newer than seven days.
 */

const twoStepOn = process.env.TWO_STEP_ENABLED === 'true';

test.beforeEach(() => {
    test.skip(!twoStepOn, 'Two-step sign-in is off (TWO_STEP_ENABLED).');
});

const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const section = (p: Page) => p.getByRole('region', { name: 'Two-step sign-in' });
const activity = (p: Page) => section(p).getByRole('list', { name: 'Recent security activity' });
const stepHeading = (p: Page) => p.getByRole('heading', { name: 'One more step' });
/* The asking side: what it shows of its request, by state. */
const ask = (scope: Page | Locator, state: string) => scope.locator(`[data-device-ask=${state}]`);
/* The answering side: the requests waiting, as rows of Your devices, and the dialog that answers. */
const waiting = (p: Page) => p.locator('[data-approval]');
const answer = (p: Page) => p.locator('[data-approval-answer]');
const toast = (p: Page, words: string) =>
    p.locator('[data-slot=toast]').getByText(words, { exact: true });
const WRONG = 'Wrong answer to the second step, with another device';
const REFUSED = 'Your other device didn’t approve this.';

async function openAccount(page: Page) {
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible({
        timeout: 60_000,
    });
}

async function enterPassword(page: Page, email: string) {
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(PASSWORD);
    await field.press('Enter');
}

async function signOut(page: Page) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.waitForLoadState('networkidle');
}

/* Two browsers signed in to one new account, both on Account. */
async function twoBrowsers(browser: Browser) {
    const a = await newPage(browser);
    const { email } = await registerAccount(a);
    const b = await newPage(browser);
    await b.goto('/login', { waitUntil: 'networkidle' });
    await enterPassword(b, email);
    await landedOnHome(b);
    await openAccount(a);
    await openAccount(b);
    return { a, b, email };
}

/*
 * On the answering browser: the one request waiting, opened from its row. `says` is what the
 * row and the dialog's heading must read. The banner above the app offers Answer too; the row
 * is the one under Your devices.
 */
async function openRequest(page: Page, says: RegExp) {
    await expect(waiting(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(waiting(page)).toContainText(says);
    await waiting(page).getByRole('button', { name: 'Answer' }).click();
    await expect(answer(page).getByRole('heading', { name: says })).toBeVisible();
}

/* The code the asking browser shows once the other one opened its request: two digits and a word. */
async function codeOn(scope: Page | Locator) {
    const shown = scope.locator('[data-device-code]');
    await expect(shown).toHaveText(/^\d{2} [a-z]+$/, { timeout: 30_000 });
    return shown.innerText();
}

/* Types a code where the other device's is asked for, and presses Approve. */
async function typeCode(page: Page, code: string) {
    const field = answer(page).getByLabel('Code on the other device');
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.fill(code);
    await answer(page).getByRole('button', { name: 'Approve' }).click();
}

/* A well-formed code that is not `code`: the same word under another number. */
function another(code: string) {
    const [digits, word] = code.split(' ') as [string, string];
    return `${String((Number(digits) + 1) % 100).padStart(2, '0')} ${word}`;
}

test('another browser turns the step on, then answers a sign-in: a wrong code and Deny sign nobody in, the right code does', async ({
    browser,
}) => {
    test.setTimeout(600_000);
    const { a, b, email } = await twoBrowsers(browser);

    // Turning it on from A. The method is offered because another device is signed in.
    await expect(section(a).locator('[data-two-step=off]')).toBeVisible();
    await section(a).getByRole('button', { name: 'Turn on Approve on another device' }).click();
    const setup = dialog(a);
    await expect(setup.getByRole('heading', { name: 'Turn on two-step sign-in?' })).toBeVisible();
    // The person chooses which device approves: with one other device it is chosen, and named.
    const choices = setup.getByRole('group', { name: 'Device that will approve' });
    await expect(choices.getByRole('radio')).toHaveCount(1);
    await expect(choices.getByRole('radio')).toBeChecked();
    const approver = (await choices.locator('label').innerText()).trim();
    expect(approver).not.toBe('');
    // The other devices are offered for removal, as whenever the step is turned on.
    await expect(setup.getByRole('checkbox', { name: /Remove my other devices/ })).toBeChecked();
    await setup.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await setup.getByRole('button', { name: 'Continue' }).click();
    await expect(setup.getByRole('heading', { name: `Approve on ${approver}` })).toBeVisible({
        timeout: 60_000,
    });
    await expect(ask(setup, 'waiting')).toContainText(
        `Open HushOS on ${approver} and choose Answer.`,
    );

    // B is asked, by the name the account has for A, and told it was the one chosen.
    await openAccount(b);
    await openRequest(b, /^Turn on Approve on another device on .+/);
    await expect(
        answer(b).getByText('The other device asked for this device to approve.'),
    ).toBeVisible();
    // Only now, with B's own value in, does A show the code. B types it; A goes on by itself.
    await typeCode(b, await codeOn(setup));
    await expect(toast(b, 'Approved')).toBeVisible({ timeout: 60_000 });
    await expect(setup.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible({
        timeout: 60_000,
    });
    const codes = await setup
        .getByRole('list', { name: 'Backup codes' })
        .locator('li')
        .allInnerTexts();
    expect(codes).toHaveLength(10);
    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(setup).toHaveCount(0);
    await expect(section(a).locator('[data-two-step=on]')).toBeVisible({ timeout: 60_000 });
    await expect(section(a).locator('[data-two-step-device=on]')).toBeVisible();
    await expect(activity(a)).toContainText('Two-step sign-in turned on');
    await expect
        .poll(async () => (await mailSubjects(email)).join('\n'), { timeout: 30_000 })
        .toContain('Two-step sign-in is on');
    // Removing the other devices kept the one that approved: it is the method.
    await openAccount(b);
    await expect(section(b).locator('[data-two-step-device=on]')).toBeVisible({
        timeout: 60_000,
    });

    // A sign-in on B: the step opens on the account's usual way, and asks nothing until a press.
    await signOut(b);
    await enterPassword(b, email);
    await expect(stepHeading(b)).toBeVisible({ timeout: 60_000 });
    await expect(b.locator('[data-step-method=device]')).toBeVisible();
    await expect(ask(b, 'idle').getByRole('button', { name: 'Use another device' })).toBeVisible();
    await expect(b.locator('[data-step-note]')).toHaveCount(0);
    await openAccount(a);
    await expect(waiting(a)).toHaveCount(0);
    // The other ways are behind Use another way, and coming back is the press that asks.
    await b.getByRole('button', { name: 'Use another way' }).click();
    await expect(b.getByRole('button', { name: /^Use (your|a) / })).toHaveText([
        'Use a backup code',
        'Use your recovery phrase',
    ]);
    await b.getByRole('button', { name: 'Use a backup code' }).click();
    await expect(b.getByLabel('Backup code')).toBeVisible();
    await b.getByRole('button', { name: 'Use another way' }).click();
    await b.getByRole('button', { name: 'Use another device' }).click();
    await expect(ask(b, 'waiting')).toContainText(
        'Open HushOS on another device and choose Answer.',
    );

    // A is asked. The name is the new browser's own word for itself, and the prompt says so.
    const signIn = /^Sign-in on a new device calling itself “.+”/;
    await openRequest(a, signIn);
    await expect(answer(a).getByText(/asked for this device/)).toHaveCount(0);
    // A wrong code: nothing is approved, the request is over, and B is not signed in.
    const first = await codeOn(b);
    await typeCode(a, another(first));
    await expect(toast(a, 'That code didn’t match, so nothing was approved.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(ask(b, 'ended')).toContainText(REFUSED, { timeout: 30_000 });
    await expect(b).toHaveURL(/\/login/);
    await expect(stepHeading(b)).toBeVisible();
    // It is counted as a failed step, by the kind of method and never the device's name.
    await openAccount(a);
    await expect(activity(a).getByText(WRONG, { exact: true })).toHaveCount(1);

    // Asked again, and denied: over again, nobody signed in, counted again.
    await ask(b, 'ended').getByRole('button', { name: 'Ask again' }).click();
    await expect(ask(b, 'waiting')).toBeVisible({ timeout: 30_000 });
    await openRequest(a, signIn);
    await answer(a).getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(toast(a, 'Denied')).toBeVisible({ timeout: 60_000 });
    await expect(ask(b, 'ended')).toContainText(REFUSED, { timeout: 30_000 });
    await expect(b).toHaveURL(/\/login/);
    await openAccount(a);
    await expect(activity(a).getByText(WRONG, { exact: true })).toHaveCount(2);

    // Asked a third time: a new request has a new code, and the right one signs B in by itself.
    await ask(b, 'ended').getByRole('button', { name: 'Ask again' }).click();
    await expect(ask(b, 'waiting')).toBeVisible({ timeout: 30_000 });
    await openRequest(a, signIn);
    const third = await codeOn(b);
    await typeCode(a, third);
    await expect(toast(a, 'Approved')).toBeVisible({ timeout: 60_000 });
    await expect(b).toHaveURL(/\/app/, { timeout: 60_000 });
    await openAccount(a);
    await expect(activity(a)).toContainText('Signed in with your password and another device');
    await expect(activity(a).getByText(WRONG, { exact: true })).toHaveCount(2);
    await expect(waiting(a)).toHaveCount(0);

    // A change, on devices newer than seven days: another device is not a way to confirm it.
    // The form says its usual way is out in one line, and opens on the next.
    await section(a).getByRole('button', { name: 'Turn off Approve on another device' }).click();
    const off = dialog(a);
    await expect(off.getByRole('heading', { name: 'Turn off two-step sign-in?' })).toBeVisible();
    await off.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const step = off.locator('[data-step-up]');
    await expect(step.locator('[data-step-note]')).toHaveText(
        'Your usual way isn’t available for this change.',
        { timeout: 60_000 },
    );
    await expect(step.locator('[data-step-method=backup]')).toBeVisible();
    await expect(step.locator('[data-device-ask]')).toHaveCount(0);
    await step.getByRole('button', { name: 'Use another way' }).click();
    await expect(step.getByRole('button', { name: /^Use (your|a|another) / })).toHaveText([
        'Use your recovery phrase',
    ]);
    // A backup code still answers it, and nothing was asked of B.
    await step.getByLabel('Backup code').fill(codes[0]!);
    await off.getByRole('button', { name: 'Turn off' }).click();
    await expect(section(a).locator('[data-two-step=off]')).toBeVisible({ timeout: 60_000 });
    await expect(activity(a).getByText(WRONG, { exact: true })).toHaveCount(2);

    await a.context().close();
    await b.context().close();
});
