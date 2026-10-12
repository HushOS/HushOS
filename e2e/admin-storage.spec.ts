import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { newContext, registerAccount } from './helpers';

/*
 * An operator adds storage to someone's account and takes it back. The
 * account page shows the new allowance at once, the person sees it in their
 * own sidebar, and only what an operator added can be revoked there.
 */

test.describe.configure({ mode: 'serial' });

let operator: Page;
let member: Page;
let memberEmail: string;

const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const spaceRow = (p: Page, label: string) =>
    p.locator('section[aria-labelledby=space] tbody tr').filter({ hasText: label });

test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    operator = await (await newContext(browser)).newPage();
    const operatorEmail = (await registerAccount(operator)).email;
    execFileSync('bun', ['run', 'admin:grant', operatorEmail], { stdio: 'pipe' });
    member = await (await newContext(browser)).newPage();
    memberEmail = (await registerAccount(member)).email;
});

test('an operator adds storage, the person sees it, and the operator revokes it', async () => {
    await member.goto('/app');
    const meter = member.getByText(/ of [0-9.,]+ (GB|TB) used/);
    const before = (await meter.innerText()).replace(/^.* of /, '').replace(/ used$/, '');

    await operator.goto(`/app/admin/accounts?q=${encodeURIComponent(memberEmail)}`);
    await operator.locator(`[data-account="${memberEmail}"]`).getByRole('link').click();
    await expect(operator.getByRole('heading', { name: 'Space' })).toBeVisible();

    await operator.getByRole('button', { name: 'Add storage', exact: true }).click();
    await dialog(operator).getByRole('button', { name: 'Custom', exact: true }).click();
    // Past the bound, refused before it is sent.
    await dialog(operator).getByLabel('Amount').fill('101');
    await dialog(operator).getByRole('button', { name: 'TB', exact: true }).click();
    await expect(dialog(operator).getByText('Add up to 100 TB at a time.')).toBeVisible();
    await expect(dialog(operator).getByRole('button', { name: 'Add storage' })).toBeDisabled();

    await dialog(operator).getByRole('button', { name: '100 GB', exact: true }).click();
    await dialog(operator).getByLabel('Note').fill('E2E support case');
    await dialog(operator).getByRole('button', { name: 'Add storage' }).click();
    await expect(dialog(operator)).toBeHidden();

    const granted = spaceRow(operator, 'Operator');
    await expect(granted).toContainText('100 GB');
    await expect(granted).toContainText('In force');
    await expect(spaceRow(operator, 'E2E support case')).toContainText(/Added by e2e-/);
    const allowance = operator.locator('section[aria-labelledby=space] p').first();
    await expect(allowance).not.toContainText(`of ${before}`);
    const raised = (await allowance.innerText()).replace(/^.* of /, '');

    await member.reload();
    await expect(member.getByText(`of ${raised} used`)).toBeVisible();

    await granted.getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog(operator)).toContainText(before);
    await dialog(operator).getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(dialog(operator)).toBeHidden();
    await expect(granted).toContainText('Revoked');
    await expect(granted.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await expect(allowance).toContainText(`of ${before}`);

    await member.reload();
    await expect(member.getByText(`of ${before} used`)).toBeVisible();
});

test('a member cannot add storage: the route answers as if it did not exist', async () => {
    const response = await member.request.post(
        '/api/admin/accounts/00000000-0000-4000-8000-000000000000/storage',
        {
            data: { quotaBytes: '1073741824' },
            headers: { origin: new URL(member.url()).origin },
        },
    );
    expect(response.status()).toBe(404);
});
