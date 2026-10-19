import { expect, test, type Page } from '@playwright/test';
import {
    addContact,
    hydrated,
    PASSWORD,
    newContext,
    newFolder,
    openFolder,
    registerAccount,
    sampleFiles,
    saveKit,
    shareWith,
} from './helpers';

/*
 * Who wrote what, end to end as two people (docs/integrity-design.md): what
 * the owner adds carries no mark; what someone they have not checked adds is
 * marked Unverified, until they check that person's words; a check that cannot
 * run shows Couldn't check, never no mark; and when one of them replaces their
 * sharing keys, the other follows only when they check again, what the old keys
 * signed turns Unverified, and what each shares with the other opens again.
 */

test.describe.configure({ mode: 'serial' });

let maya: Page;
let sam: Page;
let mayaEmail: string;
let samEmail: string;
let samples: ReturnType<typeof sampleFiles>;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const mark = (p: Page, name: string) => row(p, name).locator('[data-integrity]');
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

/* Account's Advanced group, opened once the page listens: a press before hydration does nothing. */
async function showAdvanced(p: Page) {
    await p.goto('/app/account', { waitUntil: 'networkidle' });
    // Unlocked again from this browser's saved access: a device restore still running
    // when a security change starts would wipe the change's state in the worker.
    await expect(p.getByText(/ of .+ used$/)).toBeVisible({ timeout: 60_000 });
    const show = p.getByRole('button', { name: 'Show' });
    await hydrated(show);
    await show.click();
    await expect(p.getByRole('button', { name: 'Hide' })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    samples = sampleFiles();
    sam = await (await newContext(browser)).newPage();
    samEmail = (await registerAccount(sam, 'Sam Okafor')).email;
    maya = await (await newContext(browser)).newPage();
    mayaEmail = (await registerAccount(maya, 'Maya Lindqvist')).email;
});
test.afterAll(async () => {
    await maya.context().close();
    await sam.context().close();
});

test('what the owner adds shows no mark', async () => {
    await maya.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(maya, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'notes.md')).toHaveCount(0);
    // Not after a reload either, when the listing is checked from scratch.
    await maya.reload();
    await expect(row(maya, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'notes.md')).toHaveCount(0);
});

test('when the people she trusts can’t load, every row says Couldn’t check, and Try again clears it', async () => {
    // The settings with her pins fail to load: nothing may be shown as clean.
    // Failing until the test says so, not until unrouted: the app retries the load by
    // itself, and a retry that lands before Try again would clear the mark first.
    let failing = true;
    const refuse = (url: URL) => url.pathname === '/api/auth/settings';
    await maya.route(refuse, (route) =>
        failing && route.request().method() === 'GET'
            ? route.fulfill({ status: 500, json: { message: 'Something went wrong.' } })
            : route.continue(),
    );
    await maya.reload();
    await expect(row(maya, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'notes.md')).toHaveAttribute('data-integrity', 'unchecked', {
        timeout: 60_000,
    });
    // In a row the mark is a shield; what it says is its name.
    await expect(mark(maya, 'notes.md')).toHaveAccessibleName(/^Couldn’t check:/);
    // Info says the same, beside who wrote it.
    const box = (await row(maya, 'notes.md').boundingBox())!;
    await maya.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(row(maya, 'notes.md')).toHaveAttribute('aria-selected', 'true');
    await maya.keyboard.press('i');
    const info = maya.locator('[data-details] [data-info="details"]');
    await expect(info).toContainText('Not checked');
    await expect(info.locator('[data-integrity]')).toHaveAttribute('data-integrity', 'unchecked');
    await mark(maya, 'notes.md').hover();
    const details = maya.locator('[data-integrity-details]');
    await expect(details).toContainText('HushOS couldn’t check who wrote this. Try again later.');
    // Once they load again, a retry checks again and her own file is clean. The details
    // stay open on a click, so Try again is in reach while the load still fails.
    await mark(maya, 'notes.md').click();
    const again = details.getByRole('button', { name: 'Try again' });
    await expect(again).toBeVisible();
    // The load is let through by the press itself, not before it: on its own the app tries
    // again about once a second, and a load let through while the click was still on its way
    // cleared the mark and took the button with it. The page tells the test of the press
    // before the app hears of it, so the load the press starts is the first to pass.
    await maya.exposeFunction('pressedTryAgain', () => {
        failing = false;
    });
    await again.evaluate((button) =>
        window.addEventListener(
            'click',
            (event) => {
                if (button.contains(event.target as Node))
                    (window as unknown as { pressedTryAgain: () => void }).pressedTryAgain();
            },
            { capture: true },
        ),
    );
    await again.click();
    await expect(mark(maya, 'notes.md')).toHaveCount(0, { timeout: 60_000 });
    await expect(info.locator('[data-integrity]')).toHaveCount(0);
    await maya.keyboard.press('i');
    await maya.unroute(refuse);
});

test('a file from someone not checked is Unverified, says who, and clears once checked', async () => {
    await maya.goto('/app/people');
    await addContact(maya, samEmail);
    await sam.goto('/app/people');
    await addContact(sam, mayaEmail);

    await maya.goto('/app/drive');
    await newFolder(maya);
    await maya.getByPlaceholder('Reports/2026').fill('Together');
    await maya.keyboard.press('Enter');
    await expect(row(maya, 'Together')).toBeVisible({ timeout: 60_000 });
    await row(maya, 'Together')
        .locator('button')
        .first()
        .click({ position: { x: 16, y: 12 } });
    await maya.getByRole('button', { name: 'Share', exact: true }).click();
    await shareWith(maya, /Sam Okafor/, 'Can edit');
    await expect(maya.getByText(/shared with Sam Okafor/)).toBeVisible();
    await maya.keyboard.press('Escape');
    await expect(dialog(maya)).toHaveCount(0);

    await sam.goto('/app/shared');
    await sam
        .locator('[data-shared="Together"]')
        .getByRole('link', { name: 'Together' })
        .click({ timeout: 60_000 });
    await sam.locator('input[type=file]').first().setInputFiles([samples.files.code]);
    await expect(row(sam, 'module.ts')).toBeVisible({ timeout: 60_000 });

    // Maya checked Sam's words: his file is verified, and carries nothing.
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'module.ts')).toHaveCount(0);

    // Without that check, it is someone she hasn't checked.
    await maya.goto('/app/people');
    await maya.getByRole('button', { name: 'More for Sam Okafor' }).click();
    await maya.getByRole('menuitem', { name: 'Remove' }).click();
    await maya.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(maya.locator('[data-contact]')).toHaveCount(0);
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await expect(mark(maya, 'module.ts')).toHaveAttribute('data-integrity', 'unknown-signer', {
        timeout: 60_000,
    });
    await expect(mark(maya, 'module.ts')).toHaveAccessibleName(/^Unverified:/);
    // One mark per row, though the name and the version are both his.
    await expect(mark(maya, 'module.ts')).toHaveCount(1);
    await expect(mark(maya, 'notes.md')).toHaveCount(0);
    await mark(maya, 'module.ts').hover();
    const details = maya.locator('[data-integrity-details]');
    // The server names the writer by account id alone: no name or address it could make up.
    await expect(details).toContainText(
        'HushOS can’t confirm who wrote this. It was added or last changed by someone you haven’t checked.',
    );
    await expect(details).not.toContainText('Sam');
    await mark(maya, 'module.ts').click();
    await details.getByRole('button', { name: 'Check their words' }).click();
    const check = dialog(maya).filter({ hasText: 'Check who wrote this' });
    // Someone other than the writer is said not to be them, and cannot be checked from here.
    await check.getByLabel('Email').fill(mayaEmail);
    await check.getByRole('button', { name: 'Look up' }).click();
    await expect(
        check.getByText('This isn’t the account that wrote it.', { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(check.getByRole('button', { name: 'They match' })).toBeDisabled();
    await check.getByRole('button', { name: 'They don’t match' }).click();
    await check.getByRole('button', { name: 'Back' }).click();
    await expect(check).toHaveCount(0);
    await mark(maya, 'module.ts').click();
    await details.getByRole('button', { name: 'Check their words' }).click();
    await check.getByLabel('Email').fill(samEmail);
    await check.getByRole('button', { name: 'Look up' }).click();
    await expect(check.locator('[data-fingerprint-words]')).toBeVisible({ timeout: 60_000 });
    await check.getByRole('button', { name: 'They match' }).click();
    await expect(check).toHaveCount(0);
    await expect(mark(maya, 'module.ts')).toHaveCount(0, { timeout: 30_000 });
});

test('a copy Sam saves of what Maya shared, which he checked, carries no mark', async () => {
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await maya.locator('input[type=file]').first().setInputFiles([samples.files.text]);
    await expect(row(maya, 'README')).toBeVisible({ timeout: 60_000 });

    await sam.goto('/app/shared');
    await sam
        .locator('[data-shared="Together"]')
        .getByRole('link', { name: 'Together' })
        .click({ timeout: 60_000 });
    await expect(row(sam, 'README')).toBeVisible({ timeout: 60_000 });
    await expect(mark(sam, 'README')).toHaveCount(0);
    await row(sam, 'README')
        .locator('button')
        .first()
        .click({ position: { x: 16, y: 12 }, button: 'right' });
    await sam.getByRole('menuitem', { name: 'Save a copy to my files' }).click();
    await expect(sam.getByText(/to your files/)).toBeVisible({ timeout: 60_000 });
    // That says it started. The copy uploads from this page, and a browser that cannot
    // stash the bytes (WebKit) loses it to a navigation, so wait for it to land.
    await expect(
        sam
            .locator('section[aria-label=Transfers]')
            .getByRole('listitem')
            .filter({ hasText: 'README' })
            .last(),
    ).toContainText('Uploaded', { timeout: 60_000 });
    await sam.goto('/app/drive');
    await expect(row(sam, 'README')).toBeVisible({ timeout: 90_000 });
    // Checked when copied, so signed as his own: no mark, and no saved-from-a-link line.
    await expect(mark(sam, 'README')).toHaveCount(0);
    await sam.reload();
    await expect(row(sam, 'README')).toBeVisible({ timeout: 60_000 });
    await expect(mark(sam, 'README')).toHaveCount(0);
    const box = (await row(sam, 'README').boundingBox())!;
    await sam.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await sam.keyboard.press('i');
    await expect(sam.locator('[data-details] [data-info="details"]')).toBeVisible();
    await expect(sam.locator('[data-details] [data-integrity-saved]')).toHaveCount(0);
    await sam.keyboard.press('i');
});

test('after Sam replaces his sharing keys, Maya follows only when she checks, and his old keys vouch for nothing', async () => {
    // Something of Sam's shared with Maya, sealed and signed under his first keys.
    await sam.goto('/app/drive');
    await newFolder(sam);
    await sam.getByPlaceholder('Reports/2026').fill('From Sam');
    await sam.keyboard.press('Enter');
    await expect(row(sam, 'From Sam')).toBeVisible({ timeout: 60_000 });
    await row(sam, 'From Sam')
        .locator('button')
        .first()
        .click({ position: { x: 16, y: 12 } });
    await sam.getByRole('button', { name: 'Share', exact: true }).click();
    await shareWith(sam, /Maya Lindqvist/);
    await expect(sam.getByText(/shared with Maya Lindqvist/)).toBeVisible();
    await sam.keyboard.press('Escape');
    await maya.goto('/app/shared');
    await expect(
        maya.locator('[data-shared="From Sam"]').getByRole('link', { name: 'From Sam' }),
    ).toBeVisible({ timeout: 60_000 });

    await showAdvanced(sam);
    await sam.getByRole('button', { name: 'Replace sharing keys' }).click();
    await dialog(sam).getByRole('button', { name: 'Replace sharing keys' }).click();
    await expect(sam.getByText('Sharing keys replaced')).toBeVisible({ timeout: 60_000 });
    await expect(dialog(sam)).toHaveCount(0);

    // Maya's device does not follow his new keys by itself: his share waits for her to check.
    await maya.goto('/app/shared');
    await expect(maya.locator('[data-shared="Shared folder"]').getByRole('alert')).toContainText(
        'Sam Okafor’s sharing keys changed since you checked them. Check them again in People you share with',
        { timeout: 60_000 },
    );
    await maya.goto('/app/people');
    await expect(maya.locator(`[data-contact="${samEmail}"]`)).toBeVisible({ timeout: 60_000 });
    await expect(maya.locator(`[data-succession="${samEmail}"]`)).toHaveCount(0);

    // Checking him looks his keys up and follows the succession signed by the keys she checked.
    await maya.getByRole('button', { name: 'More for Sam Okafor' }).click();
    await maya.getByRole('menuitem', { name: 'Check it’s them' }).click();
    const checking = dialog(maya).filter({ hasText: 'Check it’s Sam' });
    await expect(checking).toContainText(
        'Sam replaced their sharing keys; the change is signed by their previous keys.',
        { timeout: 60_000 },
    );
    await checking.getByRole('button', { name: 'Already in your contacts' }).click();
    await expect(checking).toHaveCount(0);
    const notice = maya.locator(`[data-succession="${samEmail}"]`);
    await expect(notice).toContainText(
        'Sam Okafor replaced their sharing keys; the change is signed by their previous keys.',
    );
    await expect(notice.getByRole('button', { name: 'Compare words again' })).toBeVisible();
    // His contact counts as checked: nothing to check again.
    await expect(maya.locator(`[data-contact="${samEmail}"]`)).not.toContainText('Check again');

    // His share, sealed again under his new keys when he replaced them, opens.
    await maya.goto('/app/shared');
    await expect(
        maya.locator('[data-shared="From Sam"]').getByRole('link', { name: 'From Sam' }),
    ).toBeVisible({ timeout: 60_000 });

    // What he wrote under his first keys no longer verifies: keys replaced vouch for nothing.
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'module.ts')).toHaveAttribute('data-integrity', 'retired-key', {
        timeout: 60_000,
    });
    await mark(maya, 'module.ts').hover();
    await expect(maya.locator('[data-integrity-details]')).toContainText(
        'Signed with keys Sam Okafor has since replaced.',
    );
    await expect(mark(maya, 'notes.md')).toHaveCount(0);

    // What Maya shared with him still opens on his side, though sealed to his first keys.
    await sam.goto('/app/shared');
    await sam
        .locator('[data-shared="Together"]')
        .getByRole('link', { name: 'Together' })
        .click({ timeout: 60_000 });
    await expect(row(sam, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(row(sam, 'notes.md')).toHaveCount(0);
    await row(sam, 'module.ts').getByRole('link', { name: 'module.ts' }).click();
    await expect(dialog(sam)).toContainText('module.ts', { timeout: 60_000 });
    await sam.keyboard.press('Escape');

    // Maya's next open seals it again to his new keys; it opens for him all the same.
    await maya.reload();
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await sam.goto('/app/shared');
    await sam
        .locator('[data-shared="Together"]')
        .getByRole('link', { name: 'Together' })
        .click({ timeout: 60_000 });
    await expect(row(sam, 'module.ts')).toBeVisible({ timeout: 60_000 });

    // Comparing words again clears the notice.
    await maya.goto('/app/people');
    await maya
        .locator(`[data-succession="${samEmail}"]`)
        .getByRole('button', { name: 'Compare words again' })
        .click();
    const again = dialog(maya).filter({ hasText: 'Check Sam again' });
    await expect(again.locator('[data-fingerprint-words]')).toBeVisible({ timeout: 60_000 });
    await expect(again).toContainText('Sam replaced their sharing keys');
    await again.getByRole('button', { name: 'They match' }).click();
    await expect(maya.locator(`[data-succession="${samEmail}"]`)).toHaveCount(0);
});

test('a copy of what no longer verifies keeps its Unverified mark', async () => {
    // Signed with keys Sam has since replaced: Maya copies it beside itself.
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await expect(mark(maya, 'module.ts')).toHaveAttribute('data-integrity', 'retired-key', {
        timeout: 60_000,
    });
    await row(maya, 'module.ts')
        .locator('button')
        .first()
        .click({ position: { x: 16, y: 12 } });
    await maya.keyboard.press('c');
    await expect(dialog(maya)).toContainText('Copy “module.ts”');
    // The picker opens on My files: the copy lands there.
    await maya.getByRole('button', { name: 'Copy here' }).click();
    await expect(dialog(maya)).toHaveCount(0, { timeout: 60_000 });
    await maya.goto('/app/drive');
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    // Re-locked by her, never vouched for: the copy is as Unverified as the original.
    await expect(mark(maya, 'module.ts')).toHaveAttribute('data-integrity', 'resealed', {
        timeout: 60_000,
    });
    await expect(mark(maya, 'module.ts')).toHaveAccessibleName(/^Unverified:/);
});

test('rotating Sam’s account key carries his earlier keys and his settings key over', async () => {
    // A new master key rewraps every identity Sam has had and the key his settings are under:
    // a share sealed to his first keys and his pins must both still open afterwards.
    await showAdvanced(sam);
    await sam.getByRole('button', { name: 'Rotate account key' }).click();
    await dialog(sam).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await dialog(sam).getByRole('button', { name: 'Rotate account key' }).click();
    await expect(sam).toHaveURL(/\/setup\/recovery-key/, { timeout: 120_000 });
    await saveKit(sam);
    await expect(sam).toHaveURL(/\/app/, { timeout: 60_000 });

    await sam.goto('/app/people');
    await expect(sam.locator(`[data-contact="${mayaEmail}"]`)).toBeVisible({ timeout: 60_000 });
    await sam.goto('/app/shared');
    await sam
        .locator('[data-shared="Together"]')
        .getByRole('link', { name: 'Together' })
        .click({ timeout: 60_000 });
    await expect(row(sam, 'module.ts')).toBeVisible({ timeout: 60_000 });
});
