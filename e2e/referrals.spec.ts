import { expect, test, type Page } from '@playwright/test';
import { registerAccount } from './helpers';

/*
 * An invite between people: the inviter's page shows a link, someone who
 * signs up through it sees the inviter's name, and once their account is set
 * up both sides hold the extra storage. Whatever the instance's base
 * allowance is, each side ends one bonus above it, and the inviter's page
 * counts the person who joined.
 */

test.describe.configure({ mode: 'serial' });

let inviter: Page;
let code: string;
let baseGiB: number;

const storageMeter = (p: Page) =>
    p.locator('aside, [data-slot=sidebar]').getByText(/\/ \d+(\.\d+)? GiB/);

async function quotaOf(p: Page) {
    const text = await storageMeter(p).first().textContent();
    return Number(/\/ ([\d.]+) GiB/.exec(text ?? '')?.[1]);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    inviter = await (await browser.newContext()).newPage();
    await registerAccount(inviter, 'Ines Inviter');
    await expect(storageMeter(inviter).first()).toBeVisible({ timeout: 60_000 });
    baseGiB = await quotaOf(inviter);
});
test.afterAll(async () => {
    await inviter.context().close();
});

test('the invite page shows a link and a code, and nobody has joined yet', async () => {
    await inviter.goto('/app/referrals', { waitUntil: 'networkidle' });
    await expect(inviter.getByRole('heading', { name: /Give .* get/ })).toBeVisible();
    const link = await inviter.getByRole('button', { name: 'Copy invite link' }).textContent();
    expect(link).toMatch(/\/r\/[a-z2-9]{8}$/);
    code = /\/r\/([a-z2-9]{8})$/.exec(link!.trim())![1]!;
    await expect(inviter.getByText('Joined through you').locator('..')).toContainText('0');
});

test('someone who joins through the link gives both sides the bonus', async ({ browser }) => {
    test.setTimeout(300_000);
    const joiner = await (await browser.newContext()).newPage();
    await joiner.goto(`/r/${code}`, { waitUntil: 'networkidle' });
    await expect(
        joiner.getByRole('heading', { name: 'Ines Inviter invited you to HushOS.' }),
    ).toBeVisible();
    // The control is a link that presents as a button; its href carries the code.
    const href = await joiner
        .getByRole('button', { name: /Create your account/ })
        .getAttribute('href');
    expect(href).toBe(`/register?ref=${code}`);
    await joiner.goto(href!, { waitUntil: 'networkidle' });
    // The sign-up flow from here is the ordinary one; the code rides along.
    await registerAccount(joiner, 'Jo Joiner', undefined, { viaCurrentPage: true });
    await expect(storageMeter(joiner).first()).toBeVisible({ timeout: 60_000 });
    expect(await quotaOf(joiner)).toBe(baseGiB + 1);
    await joiner.context().close();

    await inviter.goto('/app/referrals', { waitUntil: 'networkidle' });
    await expect(inviter.getByText('Joined through you').locator('..')).toContainText('1');
    await expect(inviter.getByText('Extra space').locator('..')).toContainText('1 GiB');
    await inviter.goto('/app', { waitUntil: 'networkidle' });
    await expect(storageMeter(inviter).first()).toBeVisible({ timeout: 60_000 });
    expect(await quotaOf(inviter)).toBe(baseGiB + 1);
});

test('an invite link that resolves to nobody says so and still offers sign-up', async ({
    browser,
}) => {
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto('/r/zzzzzzzz', { waitUntil: 'networkidle' });
    await expect(
        visitor.getByRole('heading', { name: 'This invite link is not valid any more.' }),
    ).toBeVisible();
    await expect(visitor.getByRole('button', { name: /Create your account/ })).toBeVisible();
    await visitor.context().close();
});
