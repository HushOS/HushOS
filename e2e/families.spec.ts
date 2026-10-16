import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { newContext, PASSWORD, registerAccount, verificationLink } from './helpers';

/*
 * Families on the web (groups milestone 1c), driven as the people in them: a
 * family is created, someone is invited by email and accepts, reads their
 * twelve words to the one letting them in, who checks them and lets them in;
 * then both screens show a join code, and the newcomer joins only once they
 * say the two match.
 *
 * 1. Two people: the newcomer signs up from the invitation and comes back to
 *    it; "Let them in" stays shut until their words are checked; the code the
 *    newcomer's screen works out is the admin's, a reload keeps nothing, "They
 *    don't match" says not to use the family and keeps nothing either; the
 *    admin shows the code again from Members; then "They match" joins.
 * 2. Three people: an invitation opened by the wrong account; the admin on two
 *    devices, one admission held on the wire while the other device lets
 *    someone else in, so the held one meets a stale answer, is signed again
 *    over the new member list, and the code shown is the stored one's; the
 *    newcomer compares against the other person's code first, which doesn't
 *    match and keeps nothing; and an invitation that was used up.
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

/* A second device of an existing account, signed in with the password. */
async function signIn(browser: Browser, who: Person): Promise<Person> {
    const page = await (await newContext(browser)).newPage();
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: /email/i }).fill(who.email);
    const field = page.locator('input[autocomplete=current-password]');
    await field.fill(PASSWORD);
    await field.press('Enter');
    await page.waitForURL(/\/app/, { timeout: 60_000 });
    return { ...who, page };
}

/*
 * The admin's dialog, step 1: the newcomer's twelve words as the admin's
 * screen shows them are the ones on the newcomer's join screen. "Let them in"
 * stays shut until they match.
 */
async function checkWords(admin: Person, newcomer: Person) {
    const first = newcomer.name.split(' ')[0]!;
    const own = newcomer.page.locator('[data-fingerprint-words]');
    await expect(own).toBeVisible({ timeout: 60_000 });
    await expect(newcomer.page.getByText(/^Waiting for .+ to let you in$/)).toBeVisible();

    const row = admin.page.locator(`[data-pending="${newcomer.email}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Let them in' }).click();
    const dialog = admin.page.getByRole('dialog', { name: `Let ${first} in` });
    const letInButton = dialog.getByRole('button', { name: 'Let them in' });
    await expect(dialog.locator('[data-fingerprint-words]')).toHaveAttribute(
        'data-fingerprint-words',
        (await own.getAttribute('data-fingerprint-words'))!,
        { timeout: 60_000 },
    );
    await expect(letInButton).toBeDisabled();
    // No code before they're in.
    await expect(dialog.locator('[data-kind=join-code]')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(dialog.getByText(`${first} is saved as someone you checked`)).toBeVisible();
    await expect(letInButton).toBeEnabled();
    return dialog;
}

/* Step 2, "Let them in": sent, and once it landed the dialog shows the join code. */
async function letIn(dialog: Locator, first: string, family: string) {
    await dialog.getByRole('button', { name: 'Let them in' }).click();
    return shownCode(dialog, first, family);
}

async function shownCode(dialog: Locator, first: string, family: string) {
    await expect(dialog.getByText(`${first} is in ${family}.`)).toBeVisible({ timeout: 90_000 });
    const code = dialog.locator('[data-kind=join-code]');
    await expect(code).toBeVisible();
    return words(code);
}

/*
 * The code on the newcomer's screen, once they're in: ten words shown and two
 * hidden (`?`), at positions the newcomer's device picked for this showing.
 * It must be the admin's code at every shown word.
 */
async function newcomerCode(newcomer: Person, admin: string[]) {
    await expect(newcomer.page.getByRole('heading', { name: 'Compare the join code' })).toBeVisible(
        { timeout: 90_000 },
    );
    const list = newcomer.page.locator('[data-kind=join-code]');
    const shown = await words(list);
    const hidden = (await list.getAttribute('data-hidden'))!.split(' ').map(Number);
    expect(hidden).toHaveLength(2);
    expect(shown).toEqual(admin.map((word, at) => (hidden.includes(at + 1) ? '?' : word)));
    // Each hidden word is an empty field to type it into.
    for (const at of hidden)
        await expect(newcomer.page.getByLabel(`Word ${at}`, { exact: true })).toHaveValue('');
    // And is nowhere on the page: not in the list beyond shown cells that happen to hold the same
    // word, and in no words or code attribute anywhere (where a code would sit if it leaked).
    const leaks = await newcomer.page.evaluate(
        ({ words: secret }) => {
            const count = (text: string, word: string) =>
                (text.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;
            const list = document.querySelector('[data-kind=join-code]')!;
            const shownTimes = (word: string) =>
                (list.getAttribute('data-words') ?? '').split(' ').filter((at) => at === word)
                    .length;
            const data = [...document.body.querySelectorAll('*')]
                .flatMap((element) =>
                    // Attributes that carry words or codes (data-slot and the like carry UI names).
                    [...element.attributes].filter((attribute) =>
                        /^data-.*(words|code|fingerprint|hidden)/.test(attribute.name),
                    ),
                )
                .map((attribute) => attribute.value)
                .join(' ');
            const cells = [...list.querySelectorAll('li')].map((cell) =>
                (cell.textContent ?? '').replace(/^\d+/, '').trim(),
            );
            return secret.filter(
                (word) =>
                    cells.filter((text) => text === word).length !== shownTimes(word) ||
                    count(data, word) !== shownTimes(word),
            );
        },
        { words: hidden.map((at) => admin[at - 1]!) },
    );
    expect(leaks).toEqual([]);
    return hidden;
}

/* The two hidden words typed as the admin reads `read` out, then "They match". */
async function typeHidden(newcomer: Person, hidden: number[], read: string[]) {
    const match = newcomer.page.getByRole('button', { name: 'They match' });
    await expect(match).toBeDisabled();
    for (const at of hidden)
        await newcomer.page.getByLabel(`Word ${at}`, { exact: true }).fill(read[at - 1]!);
    await match.click();
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

    test('the newcomer is let in once their words are checked, then compares the join code, and joins only on a match', async () => {
        test.setTimeout(300_000);
        const dialog = await checkWords(maya, sam);
        const code = await letIn(dialog, 'Sam', family);
        await expect(
            dialog.getByText(
                'Read all twelve words to Sam. Two are hidden on Sam’s screen; Sam types those.',
            ),
        ).toBeVisible();
        await expect(maya.page.locator(`[data-member="${sam.email}"]`)).toContainText('Member');

        // Sam's screen moves on by itself, to the same code with two words hidden.
        const first = await newcomerCode(sam, code);
        // Shown, not kept: a reload works the same code out again, hiding two words afresh.
        await sam.page.reload();
        await newcomerCode(sam, code);
        expect(first).toHaveLength(2);

        // "They don't match": the warning, and nothing kept.
        await sam.page.getByRole('button', { name: 'They don’t match' }).click();
        await expect(
            sam.page.getByRole('heading', { name: `Don’t use ${family} yet` }),
        ).toBeFocused();
        await expect(
            sam.page.getByText(
                'The join code doesn’t match what Maya sees. HushOS may be showing you a different member list. Don’t use this family until you’ve sorted it out together.',
            ),
        ).toBeVisible();
        // The family page has nothing checked to show: it sends Sam back to compare.
        await sam.page.goto(new URL(sam.page.url()).pathname.replace(/\/join$/, ''));
        const hidden = await newcomerCode(sam, code);

        // Maya closed the dialog: the code again from Members, over the stored member list.
        await dialog.getByRole('button', { name: 'Done' }).click();
        await maya.page.getByRole('button', { name: 'More for Sam Lindqvist' }).click();
        await maya.page.getByRole('menuitem', { name: 'Show Sam’s join code' }).click();
        const again = maya.page.getByRole('dialog', { name: 'Sam’s join code' });
        await expect(again.locator('[data-kind=join-code]')).toHaveAttribute(
            'data-words',
            code.join(' '),
            { timeout: 60_000 },
        );
        await maya.page.keyboard.press('Escape');

        await typeHidden(sam, hidden, code);
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

    test('an admission that meets a stale answer is signed again, its code is the stored one, and comparing the wrong code keeps nothing', async ({
        browser,
    }) => {
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

        // Maya on a second device, on the same family page.
        const familyPath = new URL(maya.page.url()).pathname;
        const other = await signIn(browser, maya);
        await other.page.goto(familyPath);
        await expect(other.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });

        // This device's admission of Ana is held on the wire after it was signed.
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let arrived!: () => void;
        const held = new Promise<void>((resolve) => (arrived = resolve));
        let holding = true;
        await maya.page.route('**/members/*/admit', async (route) => {
            if (holding) {
                holding = false;
                arrived();
                await released;
            }
            await route.continue();
        });
        const anaDialog = await checkWords(maya, ana);
        await anaDialog.getByRole('button', { name: 'Let them in' }).click();
        await held;

        // Meanwhile the other device lets Ben in, on the same member list.
        const benDialog = await checkWords(other, ben);
        const benCode = await letIn(benDialog, 'Ben', family);
        await typeHidden(ben, await newcomerCode(ben, benCode), benCode);
        await expect(ben.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });

        // The held admission now meets a stale answer: signed again over the new member list.
        release();
        const anaCode = await shownCode(anaDialog, 'Ana', family);
        await expect(
            anaDialog.getByText(
                `${family} changed while you were letting Ana in, so HushOS signed it again.`,
            ),
        ).toBeVisible();
        expect(anaCode).not.toEqual(benCode);
        await maya.page.unroute('**/members/*/admit');

        // Ana's screen works out the same code from the stored member list.
        const anaHidden = await newcomerCode(ana, anaCode);
        // Ben's code read to her by mistake, its two words typed: refused, and nothing is kept.
        await typeHidden(ana, anaHidden, benCode);
        await expect(ana.page.locator('[data-mismatch]')).toBeVisible({ timeout: 60_000 });
        await ana.page.reload();
        await typeHidden(ana, await newcomerCode(ana, anaCode), anaCode);
        await expect(ana.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        await anaDialog.getByRole('button', { name: 'Done' }).click();
        for (const who of [ana, ben])
            await expect(maya.page.locator(`[data-member="${who.email}"]`)).toContainText(
                'Member',
                {
                    timeout: 60_000,
                },
            );
        await other.page.context().close();

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
