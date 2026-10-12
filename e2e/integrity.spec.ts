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
 * marked Unverified and says who, until they check that person's words; and
 * when one of them replaces their sharing keys, the other is told the change
 * is signed, nothing they wrote before turns Unverified, and what each shares
 * with the other still opens.
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
    await expect(mark(maya, 'module.ts')).toHaveText('Unverified');
    // One mark per row, though the name and the version are both his.
    await expect(mark(maya, 'module.ts')).toHaveCount(1);
    await expect(mark(maya, 'notes.md')).toHaveCount(0);
    await mark(maya, 'module.ts').hover();
    const details = maya.locator('[data-integrity-details]');
    await expect(details).toContainText(
        `Added or last changed by Sam Okafor (${samEmail}), whom you haven’t checked yet.`,
    );
    await mark(maya, 'module.ts').click();
    await details.getByRole('button', { name: 'Check their words' }).click();
    const check = dialog(maya).filter({ hasText: 'Check it’s Sam Okafor' });
    await expect(check.locator('[data-fingerprint-words]')).toBeVisible({ timeout: 60_000 });
    await check.getByRole('button', { name: 'They match' }).click();
    await expect(check).toHaveCount(0);
    await expect(mark(maya, 'module.ts')).toHaveCount(0, { timeout: 30_000 });
});

test('after Sam replaces his sharing keys, Maya follows the signed change and shares still open both ways', async () => {
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

    // Maya's device follows the succession signed by the keys she checked, and says so.
    await maya.goto('/app/shared');
    await expect(
        maya.locator('[data-shared="From Sam"]').getByRole('link', { name: 'From Sam' }),
    ).toBeVisible({ timeout: 60_000 });
    await maya.goto('/app/people');
    const notice = maya.locator(`[data-succession="${samEmail}"]`);
    await expect(notice).toContainText(
        'Sam Okafor replaced their sharing keys; the change is signed by their previous keys.',
    );
    await expect(notice.getByRole('button', { name: 'Compare words again' })).toBeVisible();
    // His contact counts as checked: nothing to check again.
    await expect(maya.locator(`[data-contact="${samEmail}"]`)).not.toContainText('Check again');

    // What he wrote under his first keys still verifies.
    await maya.goto('/app/drive');
    await openFolder(maya, 'Together');
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await expect(mark(maya, 'module.ts')).toHaveCount(0);

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
