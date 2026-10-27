import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { SQL } from 'bun';
import {
    e2eDatabase,
    grip,
    newContext,
    openWaiting,
    registerAccount,
    sampleFiles,
} from './helpers';

/*
 * Sharing on first use (docs/optional-verification.md, PR 3), as two people:
 * Maya shares with Sam by typing his address (added and shared in one step),
 * and Sam opens it though he never added her, with no words compared
 * anywhere. Then the server serves Sam brand-new keys with no signed chain
 * (written straight into the test database, as a server swapping keys
 * would): Maya's share sheet says his account changed, nothing new is sealed
 * to him until she reviews it, and Continue seals what she shared again, to
 * the keys he has now.
 */

test.describe.configure({ mode: 'serial' });

let maya: Page;
let sam: Page;
let mayaEmail: string;
let samEmail: string;
let samples: ReturnType<typeof sampleFiles>;

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

/* The shares Maya made with Sam, by a digest of each envelope: it changes when it is sealed again. */
async function sealedForSam() {
    const database = new SQL(e2eDatabase().url);
    try {
        const rows = await database`
            select encode(sha256(s.share_envelope), 'hex') as digest
            from drive_shares s
            join users granter on granter.id = s.granter_user_id
            join users grantee on grantee.id = s.grantee_user_id
            where granter.normalized_email = ${mayaEmail.toLowerCase()}
              and grantee.normalized_email = ${samEmail.toLowerCase()}
            order by s.id`;
        return rows.map((each: { digest: string }) => each.digest);
    } finally {
        await database.close();
    }
}

async function openShare(p: Page, name: string) {
    await row(p, name).locator('button').first().click(grip);
    await p.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(p)).toContainText('Who can open this?');
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

test('Maya shares with Sam by typing his address, and he opens it, with no words anywhere', async () => {
    await maya.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(maya, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await openShare(maya, 'notes.md');
    // Someone not in her contacts yet: added and shared with in one step.
    const field = dialog(maya).getByRole('combobox', { name: 'Add people' });
    await field.click();
    await field.fill(samEmail);
    await maya.getByRole('option', { name: `Share with ${samEmail}` }).click();
    await expect(maya.getByText('Shared with Sam', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await expect(dialog(maya).locator(`[data-share="${samEmail}"]`)).toBeVisible();
    await expect(dialog(maya).locator('[data-fingerprint-words]')).toHaveCount(0);
    await maya.keyboard.press('Escape');
    expect(await sealedForSam()).toHaveLength(1);
    await maya.goto('/app/contacts');
    await expect(maya.locator(`[data-contact="${samEmail}"]`)).toHaveAttribute(
        'data-standing',
        'seen',
        { timeout: 60_000 },
    );
    await expect(maya.locator(`[data-contact="${samEmail}"]`)).toContainText('Not verified');

    // Sam has never added Maya: her share opens as it is listed, and she is a contact of his.
    await sam.goto('/app/shared');
    const shared = sam.locator('[data-shared="notes.md"]');
    await expect(shared).toBeVisible({ timeout: 60_000 });
    await expect(sam.locator('[data-waiting]')).toHaveCount(0);
    await shared.getByRole('button', { name: 'notes.md', exact: true }).click();
    await expect(dialog(sam).locator('.rt-markdown')).toContainText('Notes', { timeout: 60_000 });
    await sam.keyboard.press('Escape');
    await sam.goto('/app/contacts');
    await expect(sam.locator(`[data-contact="${mayaEmail}"]`)).toHaveAttribute(
        'data-standing',
        'seen',
        { timeout: 60_000 },
    );
});

test('someone Sam removed is not added back when they share again, until he opens it', async () => {
    await sam.goto('/app/contacts');
    await sam
        .locator(`[data-contact="${mayaEmail}"]`)
        .getByRole('button', { name: /^More for/ })
        .click();
    await sam.getByRole('menuitem', { name: 'Remove' }).click();
    await sam.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(sam.locator(`[data-contact="${mayaEmail}"]`)).toHaveCount(0);

    // Maya shares something else with him, picking him from her contacts.
    await maya.goto('/app/drive');
    await maya.locator('input[type=file]').first().setInputFiles([samples.files.code]);
    await expect(row(maya, 'module.ts')).toBeVisible({ timeout: 60_000 });
    await openShare(maya, 'module.ts');
    const field = dialog(maya).getByRole('combobox', { name: 'Add people' });
    await field.click();
    await field.fill('Sam');
    await maya.getByRole('option', { name: /Sam Okafor/ }).click();
    await dialog(maya).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog(maya).locator(`[data-share="${samEmail}"]`)).toBeVisible({
        timeout: 60_000,
    });
    await maya.keyboard.press('Escape');

    // Both of her shares wait on Sam's list, with their size left empty, until he opens one.
    await sam.goto('/app/shared');
    const waiting = sam.locator('[data-waiting="open"]');
    await expect(waiting).toHaveCount(2, { timeout: 60_000 });
    await expect(waiting.first()).toContainText(
        'You removed Maya from your contacts. Open this to add them again.',
    );
    await openWaiting(sam, 'You removed Maya');
    // Added back on purpose: the rest of what she shared opens too.
    await expect(sam.locator('[data-shared="module.ts"]')).toBeVisible({ timeout: 60_000 });
    await expect(sam.locator('[data-shared="notes.md"]')).toBeVisible();
    await expect(waiting).toHaveCount(0);
    await sam.goto('/app/contacts');
    await expect(sam.locator(`[data-contact="${mayaEmail}"]`)).toHaveAttribute(
        'data-standing',
        'seen',
        { timeout: 60_000 },
    );
});

test('a key change with no chain is one calm notice; Continue seals the share again to the new keys', async () => {
    const before = await sealedForSam();
    execFileSync('bun', ['e2e/fixtures/start-over.ts', samEmail], {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: e2eDatabase().url },
    });

    // The share sheet looks Sam up as it opens: his row says so, and his role waits.
    await maya.goto('/app/drive');
    await expect(row(maya, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await openShare(maya, 'notes.md');
    const samRow = dialog(maya).locator(`[data-share="${samEmail}"]`);
    await expect(samRow).toHaveAttribute('data-standing', 'changed', { timeout: 60_000 });
    await expect(samRow).toContainText('Sam’s account changed');
    // Nothing was sealed to the new keys meanwhile.
    expect(await sealedForSam()).toEqual(before);

    await samRow.getByRole('button', { name: 'Review' }).click();
    const notice = maya.getByRole('dialog', { name: 'Sam’s account changed' });
    await expect(notice).toContainText(
        'This happens when someone starts their HushOS account over',
    );
    await expect(notice).toContainText('You can keep sharing with Sam as before.', {
        timeout: 60_000,
    });
    // Not checked before, so Continue is the blue button; the words are a choice beside it.
    await expect(notice.getByRole('button', { name: 'Continue' })).toHaveAttribute(
        'data-variant',
        'default',
    );
    await expect(notice.getByRole('button', { name: 'Check it’s Sam' })).toHaveAttribute(
        'data-variant',
        'outline',
    );
    await notice.getByRole('button', { name: 'Continue' }).click();
    await expect(maya.getByText('You’re sharing with Sam again')).toBeVisible({ timeout: 60_000 });

    // What waited runs: both shares are sealed again, to the keys the server serves now.
    await expect
        .poll(async () => (await sealedForSam()).filter((each: string) => before.includes(each)), {
            timeout: 60_000,
        })
        .toEqual([]);
    await maya.goto('/app/contacts');
    const contact = maya.locator(`[data-contact="${samEmail}"]`);
    await expect(contact).toHaveAttribute('data-standing', 'seen', { timeout: 60_000 });
    await expect(contact).not.toContainText('Account changed');
});
