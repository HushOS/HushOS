import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { newContext, registerAccount, verificationLink } from './helpers';

/*
 * Families on the web (groups milestone 1c, step 5), driven as the people in
 * them: a family is created, someone is invited by email and accepts, the two
 * compare each other's twelve words and the family's, the one letting them in
 * reads a join code that the newcomer types, and only then are they in.
 *
 * 1. Two people: the newcomer signs up from the invitation and comes back to
 *    it; the code step stays shut until both word checks are done; nothing is
 *    let in before the code is checked, a reload included; a words mismatch
 *    stops the join; then the whole join, and the newcomer sees the family.
 * 2. Three people: an invitation opened by the wrong account; two admissions
 *    signed on the same member list, so the one sent second is stale and gets a
 *    new member list and a new code, which the newcomer types again; a join
 *    code typed wrong, which says it didn't match and is typed again; and an
 *    invitation that was used up.
 * 3. Families off: hidden from the sidebar, and the page says so.
 *
 * Whether families are on is this run's GROUPS_ENABLED (from the environment
 * or .env, as the dev server reads it). The server must agree: one that says
 * otherwise fails the file rather than letting it skip.
 */

const familiesOn = process.env.GROUPS_ENABLED === 'true';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
    const answer = await request.get('/api/drive/capabilities', {
        headers: { 'HushOS-Client': 'web/1' },
    });
    const capabilities = (await answer.json()) as { groups?: boolean };
    expect(
        capabilities.groups === true,
        `GROUPS_ENABLED is ${familiesOn ? 'on' : 'off'} here, and the server must say the same`,
    ).toBe(familiesOn);
});

type Person = { page: Page; email: string; name: string };

async function person(browser: Browser, name: string) {
    const page = await (await newContext(browser)).newPage();
    const { email } = await registerAccount(page, name);
    return { page, email, name } satisfies Person;
}

const words = async (scope: Locator) => (await scope.getAttribute('data-words'))!.split(' ');

async function createFamily(owner: Person, name: string) {
    await owner.page.goto('/app/families');
    await owner.page.getByRole('button', { name: 'Create a family' }).click();
    const dialog = owner.page.getByRole('dialog', { name: 'Create a family' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create family' }).click();
    await expect(owner.page.getByRole('heading', { level: 1, name })).toBeVisible({
        timeout: 90_000,
    });
    // The family is a row under My files.
    await expect(owner.page.getByRole('link', { name, exact: true }).first()).toBeVisible();
}

async function invite(owner: Person, email: string) {
    await owner.page.getByRole('button', { name: 'Invite someone' }).click();
    const dialog = owner.page.getByRole('dialog', { name: 'Invite someone' });
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(owner.page.locator(`[data-invitation="${email}"]`)).toBeVisible();
}

async function invitationPath(email: string) {
    const link = new URL(await verificationLink(email, '/join'));
    return link.pathname + link.hash;
}

/* The invitation as its own account opens it: accepted, and on to the join screen. */
async function accept(newcomer: Person, family: string) {
    await newcomer.page.goto(await invitationPath(newcomer.email));
    await acceptOpened(newcomer, family);
}

async function acceptOpened(newcomer: Person, family: string) {
    await expect(
        newcomer.page.getByRole('heading', { name: new RegExp(`invited you to ${family}`) }),
    ).toBeVisible({ timeout: 60_000 });
    // The token left the address bar once the page kept it.
    await expect.poll(() => new URL(newcomer.page.url()).hash).toBe('');
    await newcomer.page.getByRole('button', { name: 'Accept' }).click();
    await expect(newcomer.page.getByRole('heading', { name: `Join ${family}` })).toBeVisible({
        timeout: 60_000,
    });
}

/*
 * The admin's dialog, checks 1 and 2: the newcomer's twelve words as the
 * admin's screen shows them are the newcomer's own, and the family's words are
 * the same on both screens. The code step stays shut until both are done.
 */
async function checkWords(admin: Person, newcomer: Person) {
    const first = newcomer.name.split(' ')[0]!;
    const own = newcomer.page.locator('[data-fingerprint-words]');
    await expect(own).toBeVisible({ timeout: 60_000 });
    const newcomerFamilyWords = newcomer.page.locator('[data-kind=family-words]');
    await expect(newcomerFamilyWords).toBeVisible({ timeout: 60_000 });

    const row = admin.page.locator(`[data-pending="${newcomer.email}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Let them in' }).click();
    const dialog = admin.page.getByRole('dialog', { name: `Let ${first} in` });
    const showCode = dialog.getByRole('button', { name: 'Show join code' });
    await expect(dialog.locator('[data-fingerprint-words]')).toHaveAttribute(
        'data-fingerprint-words',
        (await own.getAttribute('data-fingerprint-words'))!,
        { timeout: 60_000 },
    );
    await expect(showCode).toBeDisabled();
    await dialog.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(dialog.getByText(`${first} is saved as someone you checked`)).toBeVisible();
    // Check 1 alone does not open the code step.
    await expect(showCode).toBeDisabled();
    const adminFamilyWords = dialog.locator('[data-kind=family-words]');
    expect(await words(adminFamilyWords)).toEqual(await words(newcomerFamilyWords));
    await dialog.getByRole('checkbox', { name: `${first} says they match` }).check();
    await expect(showCode).toBeEnabled();
    // The newcomer's side of the same check.
    await newcomer.page.getByRole('button', { name: 'They match' }).click();
    await expect(newcomer.page.getByText(/Join code for member list \d+/)).toBeVisible({
        timeout: 60_000,
    });
    return dialog;
}

/* Check 3: the admin's join code and the member list it is for. */
async function showCode(dialog: Locator) {
    const code = dialog.locator('[data-kind=join-code]');
    if (!(await code.isVisible()))
        await dialog.getByRole('button', { name: 'Show join code' }).click();
    await expect(code).toBeVisible({ timeout: 90_000 });
    const version = Number(
        (await dialog.getByText(/^Join code for member list \d+$/).textContent())!.match(
            /\d+$/,
        )![0],
    );
    return { code: await words(code), version };
}

async function typeCode(newcomer: Person, code: string[]) {
    for (const [at, word] of code.entries())
        await newcomer.page.getByLabel(`Word ${at + 1}`, { exact: true }).fill(word);
    await newcomer.page.getByRole('button', { name: 'Save join code' }).click();
    await expect(newcomer.page.getByText(/^Waiting for .+ to let you in$/)).toBeVisible();
}

async function letIn(dialog: Locator, first: string) {
    await dialog.getByRole('checkbox', { name: `${first} typed the join code` }).check();
    await dialog.getByRole('button', { name: 'Let them in' }).click();
}

test.describe('two people', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let maya: Person;
    let sam: Person;
    const family = 'Lindqvist family';

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300_000);
        maya = await person(browser, 'Maya Lindqvist');
        sam = {
            page: await (await newContext(browser)).newPage(),
            email: `e2e-${Date.now()}-${randomBytes(3).toString('hex')}@hushos.local`,
            name: 'Sam Lindqvist',
        };
    });
    test.afterAll(async () => {
        await maya?.page.context().close();
        await sam?.page.context().close();
    });

    test('a family is created, someone is invited by email, and an invitation can be cancelled', async () => {
        test.setTimeout(180_000);
        await createFamily(maya, family);
        const members = maya.page.locator(`[data-member="${maya.email}"]`);
        await expect(members).toContainText('Organizer · Manages the family');
        await invite(maya, 'nobody-yet@hushos.local');
        await maya.page
            .locator('[data-invitation="nobody-yet@hushos.local"]')
            .getByRole('button', { name: 'Cancel invitation' })
            .click();
        await expect(maya.page.locator('[data-invitation="nobody-yet@hushos.local"]')).toHaveCount(
            0,
        );
        await invite(maya, sam.email);
    });

    test('someone without an account signs up from the invitation and comes back to it', async () => {
        test.setTimeout(300_000);
        await sam.page.goto(await invitationPath(sam.email));
        await expect(
            sam.page.getByRole('heading', { name: 'You’re invited to a family' }),
        ).toBeVisible({ timeout: 60_000 });
        await sam.page.getByRole('link', { name: 'Create an account' }).click();
        await registerAccount(sam.page, sam.name, sam.email, {
            viaCurrentPage: true,
            landsOn: /\/join/,
        });
        await acceptOpened(sam, family);
    });

    test('words that don’t match stop the join, and can be compared again', async () => {
        await sam.page.getByRole('button', { name: 'They don’t match' }).click();
        await expect(
            sam.page.getByRole('heading', { name: `Don’t join ${family} yet` }),
        ).toBeFocused();
        await sam.page.getByRole('button', { name: 'Compare again' }).click();
        await expect(sam.page.locator('[data-kind=family-words]')).toBeVisible({
            timeout: 60_000,
        });
    });

    test('the newcomer is let in only after the code is checked, and then sees the family', async () => {
        test.setTimeout(300_000);
        const dialog = await checkWords(maya, sam);
        const { code, version } = await showCode(dialog);
        await expect(sam.page.getByText(`Join code for member list ${version}`)).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Let them in' })).toBeDisabled();
        await typeCode(sam, code);

        // Nothing went on its own: a reload brings the dialog back at the same code, and Sam
        // still waits.
        await maya.page.reload();
        const row = maya.page.locator(`[data-pending="${sam.email}"]`);
        await expect(row).toBeVisible({ timeout: 60_000 });
        await expect(maya.page.locator(`[data-member="${sam.email}"]`)).toHaveCount(0);
        await row.getByRole('button', { name: 'Let them in' }).click();
        const again = maya.page.getByRole('dialog', { name: 'Let Sam in' });
        await expect(again.locator('[data-kind=join-code]')).toHaveAttribute(
            'data-words',
            code.join(' '),
            { timeout: 60_000 },
        );
        await expect(sam.page.getByText(/^Waiting for Maya to let you in$/)).toBeVisible();

        await letIn(again, 'Sam');
        await expect(maya.page.getByText(`Sam is in ${family}`)).toBeVisible({ timeout: 90_000 });
        await expect(maya.page.locator(`[data-member="${sam.email}"]`)).toContainText('Member');

        // The newcomer's screen moves on by itself, and they see the family.
        await expect(sam.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        await expect(sam.page.locator(`[data-member="${maya.email}"]`)).toContainText(
            'Organizer · Manages the family',
        );
        await sam.page.getByText('Technical details').click();
        await expect(sam.page.getByText('Member list version')).toBeVisible();
        await expect(
            sam.page.getByRole('link', { name: family, exact: true }).first(),
        ).toBeVisible();
        // A reload holds: the family is checked on this device now, not joined again.
        await sam.page.reload();
        await expect(sam.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 60_000,
        });
        await expect(sam.page.getByText(/shown differently/)).toHaveCount(0);
    });
});

test.describe('three people', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let maya: Person;
    let ana: Person;
    let ben: Person;
    const family = 'Berg family';

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(400_000);
        maya = await person(browser, 'Maya Berg');
        ana = await person(browser, 'Ana Berg');
        ben = await person(browser, 'Ben Berg');
    });
    test.afterAll(async () => {
        for (const who of [maya, ana, ben]) await who?.page.context().close();
    });

    test('an admission signed on a member list that moved gets a new code, and a typo is typed again', async () => {
        test.setTimeout(480_000);
        await createFamily(maya, family);
        await invite(maya, ana.email);
        await invite(maya, ben.email);

        // Ana's invitation opened by Ben's account: refused, and nothing accepted.
        const anaLink = await invitationPath(ana.email);
        await ben.page.goto(anaLink);
        await ben.page.getByRole('button', { name: 'Accept' }).click();
        await expect(
            ben.page.getByText(/This invitation is for another email address than/),
        ).toBeVisible({ timeout: 30_000 });

        await accept(ana, family);
        await accept(ben, family);

        // Ana's admission is signed first and left waiting at its code.
        const anaDialog = await checkWords(maya, ana);
        const anaFirst = await showCode(anaDialog);
        await typeCode(ana, anaFirst.code);
        await maya.page.keyboard.press('Escape');
        await expect(anaDialog).toHaveCount(0);

        // Ben's is signed on the same member list and sent first; Ben typed his code wrong.
        const benDialog = await checkWords(maya, ben);
        const benCode = await showCode(benDialog);
        expect(benCode.version).toBe(anaFirst.version);
        const typo = [...benCode.code];
        typo[11] = typo[11] === 'zoo' ? 'zone' : 'zoo';
        await typeCode(ben, typo);
        await letIn(benDialog, 'Ben');
        await expect(maya.page.getByText(`Ben is in ${family}`)).toBeVisible({ timeout: 90_000 });

        // Ben's device can't tell a typo from another history: it says so, and he types it again,
        // against the member list number the other screen shows.
        await expect(
            ben.page.getByText(/The join code didn’t match\. Check it with Maya again/),
        ).toBeVisible({ timeout: 90_000 });
        await expect(ben.page.getByLabel('Member list')).toHaveValue(String(benCode.version));
        await typeCode(ben, benCode.code);
        await expect(ben.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });

        // Ana's dialog comes back at the code it signed, now on a member list that moved on.
        await maya.page
            .locator(`[data-pending="${ana.email}"]`)
            .getByRole('button', { name: 'Let them in' })
            .click();
        const again = maya.page.getByRole('dialog', { name: 'Let Ana in' });
        const resumed = again.locator('[data-kind=join-code]');
        await expect(resumed).toBeVisible({ timeout: 60_000 });
        expect(await words(resumed)).toEqual(anaFirst.code);
        await letIn(again, 'Ana');
        await expect(
            again.getByText(
                'The family changed while you were checking. Read Ana the new join code.',
            ),
        ).toBeVisible({ timeout: 90_000 });
        const anaSecond = await showCode(again);
        expect(anaSecond.version).toBe(anaFirst.version + 1);
        expect(anaSecond.code).not.toEqual(anaFirst.code);

        // Ana types the new code against the new member list number.
        await ana.page.getByRole('button', { name: 'Enter the join code again' }).click();
        await expect(
            ana.page.getByText(`Join code for member list ${anaSecond.version}`),
        ).toBeVisible({ timeout: 30_000 });
        await typeCode(ana, anaSecond.code);
        await letIn(again, 'Ana');
        await expect(maya.page.getByText(`Ana is in ${family}`)).toBeVisible({ timeout: 90_000 });
        await expect(ana.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        for (const who of [ana, ben])
            await expect(maya.page.locator(`[data-member="${who.email}"]`)).toContainText('Member');

        // The invitation is used up now.
        await ben.page.goto('/app/drive');
        await ben.page.goto(anaLink);
        await expect(
            ben.page.getByRole('heading', { name: 'This invitation is no longer open' }),
        ).toBeVisible({ timeout: 60_000 });
    });
});

test.describe('families off', () => {
    test.skip(familiesOn, 'Families are on (GROUPS_ENABLED).');

    test('families stay out of sight on a server that does not serve them', async ({ browser }) => {
        test.setTimeout(180_000);
        const page = await (await newContext(browser)).newPage();
        await registerAccount(page, 'Rae Off');
        await expect(page.getByRole('link', { name: 'My files' }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: 'Families' })).toHaveCount(0);
        await page.goto('/app/families');
        await expect(page.getByText('Families aren’t available here')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await page.context().close();
    });
});
