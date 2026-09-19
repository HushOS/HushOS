import { expect, test, type Page } from '@playwright/test';
import { newContext, registerAccount } from './helpers';

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
    p.locator('aside, [data-slot=sidebar]').getByText(/of \d+(\.\d+)? GiB used/);

async function quotaOf(p: Page) {
    const text = await storageMeter(p).first().textContent();
    return Number(/of ([\d.]+) GiB used/.exec(text ?? '')?.[1]);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    inviter = await (await newContext(browser)).newPage();
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
    const joiner = await (await newContext(browser)).newPage();
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
    await inviter.goto('/app/drive', { waitUntil: 'networkidle' });
    await expect(storageMeter(inviter).first()).toBeVisible({ timeout: 60_000 });
    expect(await quotaOf(inviter)).toBe(baseGiB + 1);
});

test('someone who types the code at sign-up gets the bonus the same way', async ({ browser }) => {
    test.setTimeout(300_000);
    const typer = await (await newContext(browser)).newPage();
    await typer.goto('/register', { waitUntil: 'networkidle' });
    // A code nobody issued is refused before any email goes out.
    await typer.getByLabel('Code', { exact: true }).fill('nobody-has-this');
    await typer.getByRole('textbox', { name: /^email/i }).fill('typo@hushos.local');
    await typer.getByRole('checkbox').click();
    await typer.locator('form button[type=submit]').click();
    await expect(typer.getByText(/not one we know/)).toBeVisible();
    // The helper ticks the consent box itself; hand it the form as it found it.
    await typer.getByRole('checkbox').click();
    await typer.getByLabel('Code', { exact: true }).fill(code);
    await registerAccount(typer, 'Ty Typer', undefined, { viaCurrentPage: true });
    await expect(storageMeter(typer).first()).toBeVisible({ timeout: 60_000 });
    expect(await quotaOf(typer)).toBe(baseGiB + 1);
    await typer.context().close();
    await inviter.goto('/app/referrals', { waitUntil: 'networkidle' });
    await expect(inviter.getByText('Joined through you').locator('..')).toContainText('2');
});

test('an invite link that resolves to nobody says so and still offers sign-up', async ({
    browser,
}) => {
    const visitor = await (await newContext(browser)).newPage();
    await visitor.goto('/r/zzzzzzzz', { waitUntil: 'networkidle' });
    await expect(
        visitor.getByRole('heading', { name: 'This invite link is not valid any more.' }),
    ).toBeVisible();
    await expect(visitor.getByRole('button', { name: /Create your account/ })).toBeVisible();
    await visitor.context().close();
});
