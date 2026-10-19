import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    expect,
    test,
    type Browser,
    type Locator,
    type Page,
    type Response,
    type Route,
} from '@playwright/test';
import {
    hydrated,
    newContext,
    PASSWORD,
    registerAccount,
    rotationsDone,
    saveKit,
    verificationLink,
    waitForRotation,
} from './helpers';

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
 *    admin shows the code again from Members; then "They match" joins. Then
 *    the family's folders: the newcomer uploads into "Family" and the creator
 *    sees it with no mark (her own words check of him vouches); the creator
 *    uploads, and the newcomer, who never checked her words, sees "Verified by
 *    Lindqvist family" in Info; the creator makes a second family folder, and
 *    the newcomer opens it and adds to it. Last, the newcomer rotates his
 *    account key: his self-grants for both folders are rewrapped as the
 *    family's, and a fresh device opens both without writing new ones.
 * 2. Three people: an invitation opened by the wrong account; the admin on two
 *    devices, one admission held on the wire while the other device lets
 *    someone else in, so the held one meets a stale answer, is signed again
 *    over the new member list, and the code shown is the stored one's; the
 *    newcomer compares against the other person's code first, which doesn't
 *    match and keeps nothing; and an invitation that was used up.
 * 3. Removal, leaving and key changes, with three people: a copy inside a
 *    family folder; Replace keys, with an upload into a folder the walk has
 *    not reached waiting for it and then landing; a removal (hold, finish,
 *    remove) whose walk is held on the wire while the remover sees the
 *    removed person's file as a former member's and the remaining member, on
 *    a fresh device holding only the new key, opens everything; the walk then
 *    ends; the removed person's family is gone from their device; the
 *    remaining member leaves, and the manager's device marks them left
 *    quietly, with every folder's keys replaced.
 * 4. Deleting a family folder: a manager deletes a second folder from its
 *    row's menu, it is gone for the other member too, and the removal that
 *    follows rotates only the folder that is left.
 * 5. Families off: no family row in the sidebar, no Family section in
 *    Account, and the old families address says so.
 *
 * Whether families are on is this run's GROUPS_ENABLED (from the environment
 * or .env, as the dev server reads it). The server must agree: one that says
 * otherwise fails the file rather than letting it skip.
 */

// As the server reads it: on unless set to false (an empty value is the default too).
const familiesOn = process.env.GROUPS_ENABLED !== 'false';

// Each block below is serial and makes its own people, so the blocks run side by side on
// separate workers: as one serial file it was the slowest job of a run.
test.describe.configure({ mode: 'parallel' });

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

const fileRow = (page: Page, name: string) =>
    page.locator('[data-node-id]').filter({ has: page.getByText(name, { exact: true }) });
const mark = (page: Page, name: string) => fileRow(page, name).locator('[data-integrity]');

/* Family folders, under My files in the sidebar, then one of them, open and drawn. */
async function openFamilyFolder(who: Person, _family: string, folder: string) {
    await who.page.goto('/app/drive');
    await who.page.getByRole('link', { name: 'Family folders', exact: true }).first().click();
    await expect(who.page).toHaveURL(/\/app\/s\/[0-9a-f-]+$/);
    const row = who.page.locator(`[data-area="${folder}"]`);
    // Writable once the family is checked here, the folder's key opened and its top folder listed.
    await expect(row).toHaveAttribute('data-area-write', 'writable', { timeout: 90_000 });
    await row.getByRole('link').click();
    await expect(
        who.page
            .getByRole('navigation', { name: 'Folder path' })
            .getByRole('heading', { level: 1 }),
    ).toHaveText(folder, { timeout: 60_000 });
}

async function upload(who: Person, name: string, text: string) {
    await who.page
        .locator('input[type=file]')
        .first()
        .setInputFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from(text) }]);
    await expect(fileRow(who.page, name)).toBeVisible({ timeout: 60_000 });
}

/* Selects a row by its padding, as a person does, and opens Info beside the list. */
async function info(who: Person, name: string) {
    const box = (await fileRow(who.page, name).boundingBox())!;
    await who.page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(fileRow(who.page, name)).toHaveAttribute('aria-selected', 'true');
    await who.page.keyboard.press('i');
    const panel = who.page.locator('[data-details] [data-info="details"]');
    await expect(panel).toBeVisible();
    return panel;
}

async function createFamily(owner: Person, name: string) {
    // Account → Family, where someone in no family makes one (one family per account).
    await owner.page.goto('/app/family');
    await owner.page
        .locator('[data-no-family]')
        .getByRole('button', { name: 'Create a family' })
        .click();
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
async function signIn(
    browser: Browser,
    who: Person,
    setup?: (page: Page) => Promise<unknown>,
): Promise<Person> {
    const page = await (await newContext(browser)).newPage();
    await setup?.(page);
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

test.describe.serial('two people', () => {
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
        await expect(members.locator('[data-roles] [data-slot=badge]')).toHaveText([
            'Organizer',
            'Manages the family',
        ]);
        await invite(maya, 'nobody-yet@hushos.local');
        await maya.page
            .locator('[data-invitation="nobody-yet@hushos.local"]')
            .getByRole('button', { name: 'Cancel invitation' })
            .click();
        // Asked once: the email can't be unsent.
        const ask = maya.page.getByRole('alertdialog');
        await expect(ask).toContainText('Cancel the invitation to nobody-yet@hushos.local?');
        await ask.getByRole('button', { name: 'Cancel invitation' }).click();
        await expect(maya.page.locator('[data-invitation="nobody-yet@hushos.local"]')).toHaveCount(
            0,
        );
        // In a family: Account names it and leads to Account → Family, which offers no second
        // one; the old families addresses open it, and its name heads the sidebar.
        await maya.page.goto('/app/account');
        await expect(maya.page.locator('[data-your-family]')).toContainText(family, {
            timeout: 60_000,
        });
        for (const old of ['/app/families', `/app/families/${randomUUID()}`]) {
            await maya.page.goto(old);
            await expect(maya.page).toHaveURL(/\/app\/family$/);
            await expect(maya.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
                timeout: 60_000,
            });
        }
        await expect(maya.page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await expect(maya.page.locator('[data-family-header]')).toContainText(family);
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

        // A typo in one hidden word: said calmly, naming neither word, and nothing kept; the
        // alarm is only for "They don't match".
        const [, last] = hidden as [number, number];
        const typo = code.map((word, at) =>
            at === last - 1 ? (word === 'abandon' ? 'ability' : 'abandon') : word,
        );
        await typeHidden(sam, hidden, typo);
        await expect(sam.page.locator('[data-wrong-words]')).toHaveText(
            'One of the words doesn’t match. Ask Maya to read them again. If they still don’t match, choose They don’t match.',
            { timeout: 60_000 },
        );
        await expect(sam.page.locator('[data-mismatch]')).toHaveCount(0);
        // Both fields marked alike, so the page never says which word was wrong.
        for (const at of hidden)
            await expect(sam.page.getByLabel(`Word ${at}`, { exact: true })).toHaveAttribute(
                'aria-invalid',
                'true',
            );
        await sam.page.getByLabel(`Word ${last}`, { exact: true }).fill(code[last - 1]!);
        await expect(sam.page.locator('[data-wrong-words]')).toHaveCount(0);
        await sam.page.getByRole('button', { name: 'They match' }).click();
        await expect(sam.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        await expect(
            sam.page.locator(`[data-member="${maya.email}"] [data-roles] [data-slot=badge]`),
        ).toHaveText(['Organizer', 'Manages the family']);
        await sam.page.getByText('Technical details and leaving').click();
        await expect(sam.page.getByText('Member list version')).toBeVisible();
        // A plain member may leave: offered, under Technical details and leaving.
        await expect(sam.page.getByRole('button', { name: 'Leave family' })).toBeEnabled();
        // The organizer is never offered Leave family only to be refused: it says why up front.
        await maya.page.getByText('Technical details and leaving').click();
        await expect(maya.page.getByRole('button', { name: 'Leave family' })).toBeDisabled();
        await expect(maya.page.locator('#leave-blocked')).toHaveText(
            'Make someone else the organizer first.',
        );
        await maya.page.getByText('Technical details and leaving').click();
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

    test('family folders: each side’s uploads are checked, and the family vouches where no words were compared', async () => {
        test.setTimeout(300_000);
        // Sam's row under My files opens the family's folders, "Family" among them.
        await openFamilyFolder(sam, family, 'Family');
        await upload(sam, 'from-sam.txt', 'Written by Sam\n');
        await expect(mark(sam.page, 'from-sam.txt')).toHaveCount(0);

        // Maya sees it with no mark: she checked Sam's words herself, so her own check vouches
        // and Info says nothing more.
        await openFamilyFolder(maya, family, 'Family');
        await expect(fileRow(maya.page, 'from-sam.txt')).toBeVisible({ timeout: 60_000 });
        await expect(mark(maya.page, 'from-sam.txt')).toHaveCount(0);
        const mayaInfo = await info(maya, 'from-sam.txt');
        await expect(mayaInfo.locator('[data-verified-by]')).toHaveCount(0);
        await maya.page.keyboard.press('i');

        // Sam never compared Maya's words: what she adds is verified by the family's member list.
        await upload(maya, 'from-maya.txt', 'Written by Maya\n');
        await expect(fileRow(sam.page, 'from-maya.txt')).toBeVisible({ timeout: 60_000 });
        await expect(mark(sam.page, 'from-maya.txt')).toHaveCount(0);
        const samInfo = await info(sam, 'from-maya.txt');
        await expect(samInfo.locator('[data-verified-by]')).toHaveText(
            'Verified by Lindqvist family',
        );
        await sam.page.keyboard.press('i');
    });

    test('in a family folder: copying but no sharing or reporting; downloads byte for byte; versions read-only where the keys changed; and My files never lists it', async () => {
        test.setTimeout(300_000);
        await openFamilyFolder(sam, family, 'Family');
        // The row's menu: what a family folder offers, and what it doesn't yet.
        await sam.page.getByRole('button', { name: 'More for from-maya.txt' }).click();
        const menu = sam.page.getByRole('menu');
        // An item's name, with its shortcut after it when it has one ("Download D").
        const item = (name: string) =>
            menu.getByRole('menuitem', { name: new RegExp(`^${name}(?: \\S+)?$`) });
        for (const offered of [
            'Download',
            'Rename',
            'Move',
            'Copy',
            'Versions',
            'Info',
            'Move to Trash',
        ])
            await expect(item(offered)).toBeVisible();
        for (const absent of ['Share', 'Tags', 'Report', 'Save a copy to my files'])
            await expect(item(absent)).toHaveCount(0);
        // Download, the bytes Maya uploaded.
        const [download] = await Promise.all([
            sam.page.waitForEvent('download'),
            item('Download').click(),
        ]);
        expect(download.suggestedFilename()).toBe('from-maya.txt');
        expect(readFileSync((await download.path())!, 'utf8')).toBe('Written by Maya\n');

        // A second version of Sam's file, so Versions has an earlier one.
        await sam.page
            .locator('input[type=file]')
            .first()
            .setInputFiles([
                { name: 'from-sam.txt', mimeType: 'text/plain', buffer: Buffer.from('Again\n') },
            ]);
        const collision = sam.page.locator('[data-slot=dialog-content]');
        await expect(collision).toContainText('“from-sam.txt” is already here');
        await collision.getByRole('button', { name: 'Continue' }).click();
        await expect(collision).toHaveCount(0);
        const versions = async () => {
            await sam.page.getByRole('button', { name: 'More for from-sam.txt' }).click();
            await sam.page.getByRole('menuitem', { name: 'Versions' }).click();
            const dialog = sam.page.locator('[data-slot=dialog-content]');
            await expect(dialog.getByText('Earlier version', { exact: true })).toBeVisible({
                timeout: 60_000,
            });
            return dialog;
        };
        const writable = await versions();
        await expect(
            writable.getByRole('button', { name: 'Restore earlier version' }),
        ).toBeVisible();
        await sam.page.keyboard.press('Escape');

        // Fault-injected: the server says the folder is at a key version no member list names.
        // The folder reads "keys changed", and Versions can be seen but not changed.
        const ahead = '**/api/drive/spaces';
        await sam.page.route(ahead, async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            for (const space of body.spaces)
                if (space.space.kind === 'group')
                    for (const area of space.areas) area.workspaceKeyVersion += 1;
            await route.fulfill({ response, json: body });
        });
        // Synced in place first: the folder stays on the page (never empty rows, never a fresh
        // mount, which would lose the mark set here), and Add goes the moment it reads so.
        const kept = sam.page.getByRole('navigation', { name: 'Folder path' });
        await kept.evaluate((nav) => nav.setAttribute('data-kept', 'yes'));
        const sync = () =>
            sam.page.evaluate(() =>
                document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
            );
        const add = sam.page.getByRole('button', { name: 'Add', exact: true });
        await expect(add).toBeVisible();
        await sync();
        await expect(sam.page.locator('[data-area-state="keys-changed"]')).toBeVisible({
            timeout: 90_000,
        });
        await expect(add).toHaveCount(0);
        await expect(fileRow(sam.page, 'from-sam.txt')).toBeVisible();
        await expect(kept).toHaveAttribute('data-kept', 'yes');
        // And on a fresh load too.
        await sam.page.reload();
        await expect(sam.page.locator('[data-area-state="keys-changed"]')).toBeVisible({
            timeout: 90_000,
        });
        const readOnly = await versions();
        await expect(
            readOnly.getByRole('button', { name: 'Download earlier version' }),
        ).toBeVisible();
        await expect(readOnly.getByRole('button', { name: 'Restore earlier version' })).toHaveCount(
            0,
        );
        await expect(readOnly.getByRole('button', { name: 'Delete earlier version' })).toHaveCount(
            0,
        );
        await sam.page.keyboard.press('Escape');
        await sam.page.unroute(ahead);
        // Synced in place again, the folder is writable and Add is back, on the same mount.
        await kept.evaluate((nav) => nav.setAttribute('data-kept', 'yes'));
        await sync();
        await expect(sam.page.locator('[data-area-state="keys-changed"]')).toHaveCount(0, {
            timeout: 90_000,
        });
        await expect(add).toBeVisible();
        await expect(kept).toHaveAttribute('data-kept', 'yes');

        // My files is Sam's own: none of the family's files are listed there.
        await sam.page.goto('/app/drive');
        await expect(
            sam.page
                .getByRole('navigation', { name: 'Folder path' })
                .getByRole('heading', { level: 1 }),
        ).toHaveText('My files', { timeout: 60_000 });
        await expect(sam.page.getByText('Nothing here yet')).toBeVisible();
        for (const name of ['from-maya.txt', 'from-sam.txt'])
            await expect(fileRow(sam.page, name)).toHaveCount(0);
    });

    test('a manager makes a second family folder, and the newcomer opens it and adds to it', async () => {
        test.setTimeout(240_000);
        await maya.page.getByRole('link', { name: 'Family folders', exact: true }).first().click();
        await expect(maya.page).toHaveURL(/\/app\/s\/[0-9a-f-]+$/);
        await maya.page.getByRole('button', { name: 'New family folder' }).click();
        const dialog = maya.page.getByRole('dialog', { name: 'New family folder' });
        await dialog.getByLabel('Name').fill('Photos');
        await dialog.getByRole('button', { name: 'Create folder' }).click();
        await expect(dialog).toHaveCount(0, { timeout: 90_000 });
        await expect(maya.page.locator('[data-area="Photos"]')).toHaveAttribute(
            'data-area-write',
            'writable',
            { timeout: 90_000 },
        );

        // Sam doesn't manage the family: no button, but the folder is his to open and add to.
        await openFamilyFolder(sam, family, 'Photos');
        await upload(sam, 'beach.txt', 'Sand\n');
        await sam.page.getByRole('link', { name: 'Family folders', exact: true }).last().click();
        await expect(sam.page).toHaveURL(/\/app\/s\/[0-9a-f-]+$/);
        await expect(sam.page.locator('[data-area="Photos"]')).toBeVisible({ timeout: 60_000 });
        await expect(sam.page.getByRole('button', { name: 'New family folder' })).toHaveCount(0);
    });

    test('a member rotates their account key: their family folders’ self-grants come along, and the folders open on a fresh device', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        // Sam holds a self-grant for each folder he has opened (route 23), sealed to the family.
        // Every one must be rewrapped as the family's, or the rotation is refused outright.
        await sam.page.goto('/app/account', { waitUntil: 'networkidle' });
        await expect(sam.page.getByText(/ of .+ used$/)).toBeVisible({ timeout: 60_000 });
        const show = sam.page.getByRole('button', { name: 'Show' });
        await hydrated(show);
        await show.click();
        await sam.page.getByRole('button', { name: 'Rotate account key' }).click();
        const dialog = sam.page.getByRole('dialog');
        await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
        const challenge = sam.page.waitForResponse('**/api/auth/security/start');
        await dialog.getByRole('button', { name: 'Rotate account key' }).click();
        const served = (await (await challenge).json()) as {
            workspaces: { groupId: string | null }[];
        };
        // Not vacuous: his personal grant and a self-grant for each of the two folders.
        expect(served.workspaces.filter((grant) => grant.groupId !== null)).toHaveLength(2);
        await expect(sam.page).toHaveURL(/\/setup\/recovery-key/, { timeout: 120_000 });
        await saveKit(sam.page);
        await expect(sam.page).toHaveURL(/\/app/, { timeout: 60_000 });

        // A fresh device holds only the new root: both folders open and list what is in them.
        // A self-grant that did not open under it would be replaced from the area grant (a PUT
        // to route 23), so none may be sent: the rewrapped ones are what opened the folders.
        const replaced: string[] = [];
        const fresh = await signIn(browser, sam, async (page) =>
            page.on('request', (request) => {
                if (request.method() === 'PUT' && request.url().endsWith('/self-grant'))
                    replaced.push(request.url());
            }),
        );
        try {
            await openFamilyFolder(fresh, family, 'Family');
            await expect(fileRow(fresh.page, 'from-maya.txt')).toBeVisible({ timeout: 60_000 });
            await openFamilyFolder(fresh, family, 'Photos');
            await expect(fileRow(fresh.page, 'beach.txt')).toBeVisible({ timeout: 60_000 });
            expect(replaced).toEqual([]);
        } finally {
            await fresh.page.context().close();
        }
    });
});

/* A folder inside a family folder, opened from its row. */
async function openSubfolder(who: Person, name: string) {
    await fileRow(who.page, name).getByRole('link', { name }).click();
    await expect(
        who.page
            .getByRole('navigation', { name: 'Folder path' })
            .getByRole('heading', { level: 1 }),
    ).toHaveText(name, { timeout: 60_000 });
}

/* The family's own page (`/app/family`, Account → Family), where its members and Technical details are. */
async function openFamilyPage(who: Person, path: string, family: string) {
    await who.page.goto(path);
    await expect(who.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
        timeout: 90_000,
    });
}

/*
 * Holds a person's key-change walk on the wire (every page of their browser):
 * every batch it sends waits until `release` is called. The walk is what
 * re-keys the rest of a folder after its top folder got new keys with the
 * member list, and every member's device walks, so a test that wants to see
 * the walk not done yet holds everyone's.
 */
async function holdWalk(page: Page) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let sent = 0;
    const pattern = '**/api/drive/nodes/*/rotation/nodes';
    await page.context().route(pattern, async (route) => {
        sent++;
        await released;
        await route.continue();
    });
    return {
        batches: () => sent,
        // Released, the handler lets every batch through (held ones included); it stays installed,
        // since unrouting would leave a held request with no handler to continue it.
        release: async () => {
            release();
        },
    };
}

/*
 * A device that has not heard of a key change yet: route 25 answers it as if
 * no walk were running, so nothing on it says to wait, and only the server's
 * refusal of an upload (409 rotating) does. This is the moment right after a
 * manager presses Remove from family or Replace keys, before the member's
 * next sync, held open for as long as the test needs.
 */
async function hideKeyChanges(page: Page) {
    const pattern = '**/api/drive/spaces';
    const handler = async (route: Route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
            spaces: { areas: { rotation: unknown }[] }[];
        };
        for (const space of body.spaces) for (const area of space.areas) area.rotation = null;
        await route.fulfill({ response, json: body });
    };
    await page.context().route(pattern, handler);
    return { restore: () => page.context().unroute(pattern, handler) };
}

/*
 * Route 25 held for a device: a sync there commits the member list it fetched
 * and then waits before it can list any family folder's top folder under the
 * new key. The gap between the two, held open for as long as the test needs.
 */
async function holdSpaces(page: Page) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.context().route('**/api/drive/spaces', async (route) => {
        held++;
        await released;
        await route.fallback();
    });
    return {
        /* Requests that reached the hold so far, released or not. */
        held: () => held,
        release: async () => release(),
    };
}

/* The member list version this device last committed for its families (its stored record). */
function committedVersion(page: Page) {
    return page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const open = indexedDB.open('hushos-groups');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const all = db.transaction('chains').objectStore('chains').getAll();
                    all.onerror = () => reject(all.error);
                    all.onsuccess = () => {
                        db.close();
                        const rows = all.result as { rosterVersion: number }[];
                        resolve(Math.max(0, ...rows.map((row) => row.rosterVersion)));
                    };
                };
            }),
    );
}

test.describe.serial('removal, leaving and key changes', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let maya: Person;
    let sam: Person;
    let ana: Person;
    let groupPath = '';
    // The family's folders (/app/s/<id>), from Family folders in the sidebar.
    let spacePath = '';
    const family = 'Holm family';

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(400_000);
        maya = await person(browser, 'Maya Holm');
        sam = await person(browser, 'Sam Holm');
        ana = await person(browser, 'Ana Holm');
    });
    test.afterAll(async () => {
        for (const who of [maya, sam, ana]) await who?.page.context().close();
    });

    test('three people join, each adds a file, and a copy inside a family folder is the copier’s', async () => {
        test.setTimeout(480_000);
        await createFamily(maya, family);
        groupPath = new URL(maya.page.url()).pathname;
        spacePath = (await maya.page
            .getByRole('link', { name: 'Family folders', exact: true })
            .first()
            .getAttribute('href'))!;
        for (const newcomer of [sam, ana]) {
            await invite(maya, newcomer.email);
            await accept(newcomer, family);
            const first = newcomer.name.split(' ')[0]!;
            const dialog = await checkWords(maya, newcomer);
            const code = await letIn(dialog, first, family);
            await typeHidden(newcomer, await newcomerCode(newcomer, code), code);
            await expect(
                newcomer.page.getByRole('heading', { level: 1, name: family }),
            ).toBeVisible({ timeout: 90_000 });
            await dialog.getByRole('button', { name: 'Done' }).click();
        }
        await openFamilyFolder(sam, family, 'Family');
        await upload(sam, 'from-sam.txt', 'Written by Sam\n');
        await openFamilyFolder(maya, family, 'Family');
        // A folder inside the family folder, which a walk reaches only after the top folder.
        await maya.page.getByRole('button', { name: 'Add', exact: true }).click();
        await maya.page.getByRole('menuitem', { name: /new folder/i }).click();
        const create = maya.page.getByRole('dialog', { name: 'New folder' });
        await create.getByLabel('Name').fill('Trips');
        await create.getByRole('button', { name: /^Create/ }).click();
        await expect(fileRow(maya.page, 'Trips')).toBeVisible({ timeout: 60_000 });

        // A copy inside the family folder: judged by the family, so Sam's file, which Maya
        // checked, is copied as hers, with no mark.
        await expect(fileRow(maya.page, 'from-sam.txt')).toBeVisible({ timeout: 60_000 });
        await maya.page.getByRole('button', { name: 'More for from-sam.txt' }).click();
        await maya.page.getByRole('menuitem', { name: /^Copy(?: \S+)?$/ }).click();
        const copy = maya.page.locator('[data-slot=dialog-content]');
        await copy.getByRole('button', { name: 'Copy here' }).click();
        await expect(copy).toHaveCount(0, { timeout: 60_000 });
        await expect(fileRow(maya.page, 'from-sam (copy).txt')).toBeVisible({ timeout: 60_000 });
        await expect(mark(maya.page, 'from-sam (copy).txt')).toHaveCount(0);
        // Ana never checked anyone's words: the copy reads verified by the family.
        await openFamilyFolder(ana, family, 'Family');
        await expect(fileRow(ana.page, 'from-sam (copy).txt')).toBeVisible({ timeout: 60_000 });
        const copied = await info(ana, 'from-sam (copy).txt');
        await expect(copied.locator('[data-verified-by]')).toHaveText(`Verified by ${family}`);
        await ana.page.keyboard.press('i');
        const [download] = await Promise.all([
            ana.page.waitForEvent('download'),
            (async () => {
                await ana.page
                    .getByRole('button', { name: 'More for from-sam (copy).txt' })
                    .click();
                await ana.page.getByRole('menuitem', { name: /^Download(?: \S+)?$/ }).click();
            })(),
        ]);
        expect(readFileSync((await download.path())!, 'utf8')).toBe('Written by Sam\n');
    });

    test('Replace keys: an upload into a folder the walk has not reached waits for it, then lands', async () => {
        test.setTimeout(360_000);
        await openFamilyPage(maya, groupPath, family);
        const walk = await holdWalk(maya.page);
        const others = [await holdWalk(ana.page), await holdWalk(sam.page)];
        const before = await rotationsDone(maya.page);
        await maya.page.getByText('Technical details and leaving').click();
        const keys = maya.page.locator('[data-folder-keys="Family"]');
        await expect(keys).toContainText('Key version 1', { timeout: 60_000 });
        await keys.getByRole('button', { name: 'Replace keys' }).click();
        await expect(maya.page.getByText('Replacing the keys of “Family”')).toBeVisible({
            timeout: 90_000,
        });
        await expect(keys).toContainText('Key version 2', { timeout: 60_000 });
        // The walk has started and is held: the family page says keys are being replaced.
        await expect.poll(walk.batches, { timeout: 90_000 }).toBeGreaterThan(0);
        await expect(maya.page.locator('[data-key-change="walking"]')).toBeVisible({
            timeout: 60_000,
        });
        await maya.page.screenshot({ path: test.info().outputPath('replace-keys.png') });

        // Ana's device sees the key change: Trips is not re-keyed yet, so her upload waits.
        await openFamilyFolder(ana, family, 'Family');
        await openSubfolder(ana, 'Trips');
        await expect(ana.page.locator('[data-area-state="key-change"]')).toBeVisible({
            timeout: 90_000,
        });
        // A new folder would be wrapped under Trips' old key: not offered while it waits.
        await ana.page.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(ana.page.getByRole('menuitem', { name: /new folder/i })).toBeDisabled();
        await ana.page.keyboard.press('Escape');
        await ana.page
            .locator('input[type=file]')
            .first()
            .setInputFiles([
                { name: 'trip.txt', mimeType: 'text/plain', buffer: Buffer.from('Norway\n') },
            ]);
        // Its row in Transfers says why it waits; it is not failed, and nothing was made yet.
        const row = ana.page
            .locator('section[aria-label=Transfers]')
            .getByRole('listitem')
            .filter({ hasText: 'trip.txt' })
            .last();
        await expect(row).toContainText('Finishing a key change…', { timeout: 60_000 });
        // The panel says what it waits for, and shows nothing moving: no bar, no Pause.
        const panel = ana.page.locator('section[aria-label=Transfers]');
        await expect(panel.locator('header')).toContainText('1 file waiting for a key change');
        await expect(panel.getByRole('button', { name: 'Pause all' })).toHaveCount(0);
        await expect(row.locator('progress')).toHaveCount(0);
        await ana.page.screenshot({ path: test.info().outputPath('upload-waiting.png') });
        // Past a recheck it still waits: the walk has not reached Trips, and nothing it does
        // between checks reads as uploading.
        await ana.page.waitForTimeout(6_000);
        await expect(row).toContainText('Finishing a key change…');
        await expect(panel.locator('header')).toContainText('1 file waiting for a key change');
        await expect(fileRow(ana.page, 'trip.txt')).toHaveCount(0);

        // The walk goes on: it ends, and the waiting upload lands by itself.
        await walk.release();
        await waitForRotation(maya.page, before);
        for (const other of others) await other.release();
        await expect(fileRow(ana.page, 'trip.txt')).toBeVisible({ timeout: 90_000 });
        const [download] = await Promise.all([
            ana.page.waitForEvent('download'),
            (async () => {
                await ana.page.getByRole('button', { name: 'More for trip.txt' }).click();
                await ana.page.getByRole('menuitem', { name: /^Download(?: \S+)?$/ }).click();
            })(),
        ]);
        expect(readFileSync((await download.path())!, 'utf8')).toBe('Norway\n');
        await expect(maya.page.locator('[data-key-change="walking"]')).toHaveCount(0, {
            timeout: 60_000,
        });
    });

    test('removing someone: hold, finish, remove; their files read as a former member’s before the walk passes and after it; the rest open on a fresh device; their family is gone', async ({
        browser,
    }) => {
        // About 1.3 minutes on CI's dev server, and up to half a minute more waiting on route 2's
        // poll below: a wait that never ends fails in three, not ten.
        test.setTimeout(180_000);
        // Sam adds a file after Replace keys, so the removal's walk is the first to re-key it.
        await openFamilyFolder(sam, family, 'Family');
        await upload(sam, 'sam-notes.txt', 'Notes by Sam\n');
        // Ana has Trips open, and her device will not hear of the key change the removal starts.
        await openFamilyFolder(ana, family, 'Family');
        await openSubfolder(ana, 'Trips');
        const unheard = await hideKeyChanges(ana.page);
        // And any sync of hers from here on commits the removal's member list but cannot list the
        // top folder under its new key until released.
        const committedBefore = await committedVersion(ana.page);
        const spaces = await holdSpaces(ana.page);
        // The member list version Ana's families list (route 2) has last named. Once it names the
        // removal's, her family page keys a new sync, which the held listing keeps waiting.
        let listed = 0;
        const onFamilies = async (response: Response) => {
            if (
                response.request().method() !== 'GET' ||
                new URL(response.url()).pathname !== '/api/groups'
            )
                return;
            const body = (await response.json().catch(() => ({}))) as {
                groups?: { rosterVersion: number }[];
            };
            for (const group of body.groups ?? []) listed = Math.max(listed, group.rosterVersion);
        };
        ana.page.on('response', onFamilies);
        await openFamilyPage(maya, groupPath, family);
        const walk = await holdWalk(maya.page);
        const others = [await holdWalk(ana.page)];
        const before = await rotationsDone(maya.page);
        await maya.page.getByRole('button', { name: 'More for Sam Holm' }).click();
        await maya.page.getByRole('menuitem', { name: 'Remove from family' }).click();
        const confirm = maya.page.getByRole('alertdialog', { name: `Remove Sam from ${family}?` });
        await expect(
            confirm.getByText(
                'Sam loses the family folders straight away. HushOS replaces their keys, which can take a few minutes.',
            ),
        ).toBeVisible();
        await confirm.getByRole('button', { name: 'Remove from family' }).click();
        const sheet = maya.page.getByRole('dialog', { name: 'Remove Sam' });
        await expect(sheet.locator('[data-outcome="removed"]')).toBeVisible({ timeout: 120_000 });
        for (const step of ['hold', 'remove'])
            await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute(
                'data-state',
                'done',
            );
        // Replace keys' walk ended above, so no earlier key change was finished, and none is said.
        await expect(sheet.locator('[data-step="finish"]')).toHaveCount(0);
        await maya.page.screenshot({ path: test.info().outputPath('removal-progress.png') });
        await sheet.getByRole('button', { name: 'Done' }).click();
        await expect(maya.page.locator(`[data-member="${sam.email}"]`)).toHaveCount(0, {
            timeout: 60_000,
        });
        await expect.poll(walk.batches, { timeout: 90_000 }).toBeGreaterThan(0);
        await expect(maya.page.locator('[data-key-change="walking"]')).toBeVisible({
            timeout: 60_000,
        });

        // Ana's device syncs: it commits the removal's member list, and its listing of the top
        // folder under the new key is held. Her page still shows the folder as before.
        await ana.page.evaluate(() =>
            document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
        );
        await expect
            .poll(() => committedVersion(ana.page), { timeout: 60_000 })
            .toBeGreaterThan(committedBefore);
        // Her families list names the new version too (on that sync, or its next poll), and the
        // page still shows Trips as last synced while the new sync waits: never a blank page.
        await expect.poll(() => listed, { timeout: 45_000 }).toBeGreaterThan(committedBefore);
        ana.page.off('response', onFamilies);
        // And the sync that version starts has reached the held listing, so the page is checked
        // while that sync waits, not before it began. It queues behind the first sync's family
        // lock, which lets go when that sync's held listing times out (30 s).
        const heldBefore = spaces.held();
        await expect.poll(spaces.held, { timeout: 60_000 }).toBeGreaterThan(heldBefore);
        await expect(
            ana.page
                .getByRole('navigation', { name: 'Folder path' })
                .getByRole('heading', { level: 1 }),
        ).toHaveText('Trips');
        await expect(fileRow(ana.page, 'trip.txt')).toBeVisible();
        await expect(ana.page.locator('[data-family-checking]')).toHaveText(
            `Checking ${family}’s member list`,
        );
        await ana.page.screenshot({ path: test.info().outputPath('checking-member-list.png') });

        // Ana uploads into Trips in that gap, while the walk is held there. Her device knows the
        // keys changed and has not listed the new top folder yet: a key change on its way, so
        // the upload waits (KEY_CHANGE_PENDING), never "keys changed, reload", and nothing is
        // published until the walk has re-keyed the folder.
        const uploads: { status: number; code?: string }[] = [];
        const onUpload = async (response: Response) => {
            if (
                response.request().method() !== 'POST' ||
                new URL(response.url()).pathname !== '/api/drive/uploads'
            )
                return;
            const body = (await response.json().catch(() => ({}))) as { code?: string };
            uploads.push({ status: response.status(), code: body.code });
        };
        ana.page.on('response', onUpload);
        await ana.page
            .locator('input[type=file]')
            .first()
            .setInputFiles([
                {
                    name: 'late.txt',
                    mimeType: 'text/plain',
                    buffer: Buffer.from('Late, but here\n'),
                },
            ]);
        const late = ana.page
            .locator('section[aria-label=Transfers]')
            .getByRole('listitem')
            .filter({ hasText: 'late.txt' })
            .last();
        await expect(late).toContainText('Finishing a key change…', { timeout: 60_000 });
        // Her own device refused to seal it: nothing reached the server.
        expect(uploads).toEqual([]);
        // The listing goes through: the wait goes on, now for the walk.
        await spaces.release();
        await expect(ana.page.locator('[data-family-checking]')).toHaveCount(0, {
            timeout: 60_000,
        });
        await ana.page.waitForTimeout(6_000);
        await expect(late).toContainText('Finishing a key change…');
        // While the walk is held, no upload has been accepted: any begin the server saw was refused
        // as rotating, never published under the folder's old keys.
        expect(uploads.filter((u) => u.status < 400)).toEqual([]);
        expect(uploads.every((u) => u.status === 409 && u.code === 'rotating')).toBe(true);
        ana.page.off('response', onUpload);
        await ana.page.screenshot({ path: test.info().outputPath('upload-refused-waits.png') });

        // While the walk is held, Sam's file is still his record: a former member's.
        await openFamilyFolder(maya, family, 'Family');
        const former = mark(maya.page, 'sam-notes.txt');
        await expect(former).toHaveAttribute('data-integrity', 'former-member', {
            timeout: 90_000,
        });
        await expect(former).toHaveAttribute(
            'aria-label',
            new RegExp(`Written by Sam, who has left ${family}\\.`),
        );
        await former.click();
        await maya.page.screenshot({ path: test.info().outputPath('former-member.png') });
        await maya.page.keyboard.press('Escape');

        // Ana, on a fresh device that holds only the new key, opens the part the walk has not
        // reached through the top folder's previous key (option A), byte for byte.
        const fresh = await signIn(browser, ana, async (page) => others.push(await holdWalk(page)));
        await openFamilyFolder(fresh, family, 'Family');
        for (const [name, text] of [
            ['sam-notes.txt', 'Notes by Sam\n'],
            ['from-sam.txt', 'Written by Sam\n'],
            ['from-sam (copy).txt', 'Written by Sam\n'],
        ] as const) {
            await expect(fileRow(fresh.page, name)).toBeVisible({ timeout: 60_000 });
            const [download] = await Promise.all([
                fresh.page.waitForEvent('download'),
                (async () => {
                    await fresh.page.getByRole('button', { name: `More for ${name}` }).click();
                    await fresh.page.getByRole('menuitem', { name: /^Download(?: \S+)?$/ }).click();
                })(),
            ]);
            expect(readFileSync((await download.path())!, 'utf8')).toBe(text);
        }
        await openSubfolder(fresh, 'Trips');
        await expect(fileRow(fresh.page, 'trip.txt')).toBeVisible({ timeout: 60_000 });

        // The walk ends. It kept Sam's records as his (re-keyed, docs/integrity-design.md
        // "Re-keyed records"): after it his file still reads as a former member's, never as
        // re-locked by Maya, and Info names her only as the one who replaced the keys.
        await walk.release();
        await waitForRotation(maya.page, before);
        for (const other of others) await other.release();
        // Ana's upload goes by itself, sealed again under Trips' new key: nobody pressed Retry,
        // it never failed, and it opens byte for byte.
        await expect(fileRow(ana.page, 'late.txt')).toBeVisible({ timeout: 150_000 });
        await expect(late).toContainText('Uploaded');
        const [landed] = await Promise.all([
            ana.page.waitForEvent('download'),
            (async () => {
                await ana.page.getByRole('button', { name: 'More for late.txt' }).click();
                await ana.page.getByRole('menuitem', { name: /^Download(?: \S+)?$/ }).click();
            })(),
        ]);
        expect(readFileSync((await landed.path())!, 'utf8')).toBe('Late, but here\n');
        await expect(mark(ana.page, 'late.txt')).toHaveCount(0);
        await unheard.restore();
        await maya.page.reload();
        const after = mark(maya.page, 'sam-notes.txt');
        await expect(after).toHaveAttribute('data-integrity', 'former-member', {
            timeout: 90_000,
        });
        await expect(after).toHaveAttribute(
            'aria-label',
            new RegExp(`Written by Sam, who has left ${family}\\.`),
        );
        await fileRow(maya.page, 'sam-notes.txt')
            .locator('button')
            .first()
            .click({ position: { x: 16, y: 12 } });
        await maya.page.keyboard.press('i');
        await expect(maya.page.locator('[data-details] [data-keys-replaced]')).toHaveText('You', {
            timeout: 60_000,
        });
        await maya.page.screenshot({ path: test.info().outputPath('rekeyed-info.png') });
        await maya.page.keyboard.press('Escape');
        await fresh.page.goto(spacePath);
        await expect(fresh.page.locator('[data-area="Family"]')).toHaveAttribute(
            'data-area-write',
            'writable',
            { timeout: 90_000 },
        );
        await fresh.page.context().close();

        // Sam's family is gone from his device: no row under My files, and the space says so.
        await sam.page.goto('/app/drive');
        await expect(sam.page.getByRole('link', { name: family, exact: true })).toHaveCount(0, {
            timeout: 60_000,
        });
        await sam.page.goto(spacePath);
        await expect(sam.page.getByText('You’re not in this family')).toBeVisible({
            timeout: 60_000,
        });
    });

    test('leaving: the member goes, and the manager’s device marks them left with every folder’s keys replaced', async () => {
        test.setTimeout(360_000);
        await openFamilyPage(ana, groupPath, family);
        // Under Technical details and leaving, the quietest place on the page.
        await ana.page.getByText('Technical details and leaving').click();
        await ana.page.getByRole('button', { name: 'Leave family' }).click();
        const dialog = ana.page.getByRole('alertdialog', { name: `Leave ${family}?` });
        await expect(
            dialog.getByText('You’ll lose the family folders. Your own files stay yours.'),
        ).toBeVisible();
        await ana.page.screenshot({ path: test.info().outputPath('leave.png') });
        await dialog.getByRole('button', { name: 'Leave family' }).click();
        await expect(ana.page).toHaveURL(/\/app\/drive/, { timeout: 60_000 });
        await expect(ana.page.getByRole('link', { name: family, exact: true })).toHaveCount(0, {
            timeout: 60_000,
        });

        // Maya's family page: Ana marked left on the member list by her device, quietly.
        const before = await rotationsDone(maya.page);
        await maya.page.goto(groupPath);
        await expect(maya.page.locator(`[data-member="${ana.email}"]`)).toHaveCount(0, {
            timeout: 90_000,
        });
        await expect(maya.page.locator('[data-left-due]')).toHaveCount(0, { timeout: 90_000 });
        await waitForRotation(maya.page, before);
        await maya.page.getByText('Technical details and leaving').click();
        await expect(maya.page.locator('[data-folder-keys="Family"]')).toContainText(
            'Key version 4',
            { timeout: 60_000 },
        );
    });
});

test.describe.serial('three people', () => {
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
        // Ben's code read to her by mistake, its two words typed: refused calmly the first time,
        // and nothing is kept.
        await typeHidden(ana, anaHidden, benCode);
        await expect(ana.page.locator('[data-wrong-words]')).toBeVisible({ timeout: 60_000 });
        await expect(ana.page.locator('[data-mismatch]')).toHaveCount(0);
        // Read out again, still wrong for the same code: the warning, not another calm retry.
        await ana.page.getByRole('button', { name: 'They match' }).click();
        await expect(
            ana.page.getByRole('heading', { name: `Don’t use ${family} yet` }),
        ).toBeVisible({ timeout: 60_000 });
        await expect(ana.page.locator('[data-mismatch]')).toBeVisible();
        // A reload asks the same two words (held in this tab), and a second miss is still the
        // warning; Ana's own code, read out at last, joins.
        await ana.page.reload();
        const asked = await newcomerCode(ana, anaCode);
        expect(asked).toEqual(anaHidden);
        await typeHidden(ana, asked, benCode);
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

/*
 * Family plans. A real Polar checkout can't run here (verification and CI run with
 * BILLING_PROVIDER=none, and nothing may call Polar), so the family's billing summary is
 * stubbed with page.route, the shapes the server answers: no plan, a live one the person
 * pays for, one set to end, one that ended, and the view of a member who sees only the
 * plan's name. What the page offers and hides is real; checkout, the portal and the
 * places routes are not exercised.
 */
test.describe.serial('family plans, with the billing summary stubbed', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    const DAY = 24 * 60 * 60 * 1000;
    const family = 'Ekström family';
    // The three tiers as seed.ts makes them: four included, then 1.50 a member (ten months of it
    // a year); a year's base is a round total that splits into twelve, 96, 192 and 288.
    const tier = (key: string, label: string, gib: number, usd: number, interval: string) => {
        const times = interval === 'year' ? 10 : 1;
        const base = interval === 'year' ? (usd / 1000) * 9600 : usd;
        return {
            id: `${key}-${interval}`,
            name: `Family ${label} (${interval === 'year' ? 'yearly' : 'monthly'})`,
            description: null,
            interval,
            tier: key,
            recommended: key === 'pro',
            prices: { usd: { base, perMember: 150 * times } },
            includedMembers: 4,
            maxMembers: 20,
            quotaBytes: String(gib * 1024 ** 3),
        };
    };
    const plans = [
        tier('plus', 'Plus', 800, 1000, 'month'),
        tier('plus', 'Plus', 800, 1000, 'year'),
        tier('pro', 'Pro', 2048, 2000, 'month'),
        tier('pro', 'Pro', 2048, 2000, 'year'),
        tier('max', 'Max', 4096, 3000, 'month'),
        tier('max', 'Max', 4096, 3000, 'year'),
    ];
    const none = {
        enabled: true,
        view: 'manage',
        plans,
        payer: null,
        subscription: null,
        lastPlan: null,
        storage: { usedBytes: '0', quotaBytes: '0' },
        seats: { used: 1, limit: 1 },
        nextPlace: null,
    };
    // Twenty of thirty-one days left: a raise of two is 193.55, charged 193 (twice 96 is 192).
    const live = (overrides: Record<string, unknown> = {}, usedGib = 300) => ({
        ...none,
        payer: { userId: 'payer', you: true },
        subscription: {
            id: 'sub',
            productId: 'pro-month',
            productName: 'Family Pro (monthly)',
            status: 'active',
            recurringInterval: 'month',
            amount: 2600,
            currency: 'usd',
            units: 8,
            paidUnits: 8,
            pendingUnits: null,
            pendingProductId: null,
            paidProductId: 'pro-month',
            includedMembers: 4,
            quotaBytes: String(2 * 1024 ** 4),
            currentPeriodStart: new Date(Date.now() - 11 * DAY).toISOString(),
            currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
            cancelAtPeriodEnd: false,
            ...overrides,
        },
        storage: { usedBytes: String(usedGib * 1024 ** 3), quotaBytes: String(2 * 1024 ** 4) },
        seats: { used: 1, limit: 8 },
        nextPlace: { amount: 96, currency: 'usd' },
    });
    let maya: Person;
    let groupId: string;
    let answer: unknown = none;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300_000);
        maya = await person(browser, 'Maya Ekström');
        await createFamily(maya, family);
        // The family's id, from Family folders in the sidebar (its page is /app/family).
        const folders = await maya.page
            .getByRole('link', { name: 'Family folders', exact: true })
            .first()
            .getAttribute('href');
        groupId = folders!.split('/').at(-1)!;
        await maya.page.route(
            (url) => url.pathname === `/api/billing/groups/${groupId}`,
            (route: Route) =>
                route.request().method() === 'GET'
                    ? route.fulfill({ json: answer, headers: { 'cache-control': 'no-store' } })
                    : route.continue(),
        );
    });
    test.afterAll(async () => {
        await maya?.page.context().close();
    });

    async function show(summary: unknown, path = '/app/family') {
        answer = summary;
        await maya.page.goto(path);
    }

    /* The folder row's menu still offers Delete family folder; nothing is deleted here. */
    async function canStillDelete() {
        await maya.page
            .getByRole('button', { name: /^More for / })
            .first()
            .click({ timeout: 60_000 });
        await expect(
            maya.page.getByRole('menuitem', { name: 'Delete family folder' }),
        ).toBeVisible();
        await maya.page.keyboard.press('Escape');
    }

    test('before a plan: Choose a plan comes first, priced monthly and yearly, and nobody can be invited or a folder made', async () => {
        await show(none);
        const choose = maya.page.locator('[data-choose-plan]');
        await expect(choose.getByRole('heading', { name: 'Choose a plan' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(choose).toContainText(
            `${family} needs a plan before you can invite anyone or make family folders.`,
        );
        // The three tiers, smallest first, the toggle above them.
        const cards = choose.locator('[data-plan]');
        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('$10 a month');
        await expect(cards.nth(1)).toContainText('$20 a month');
        await expect(cards.nth(2)).toContainText('$30 a month');
        await expect(choose).toContainText('Plus tax where it applies; Polar adds it at checkout.');
        await expect(cards.nth(0)).toContainText('For up to 4 members, sharing 800 GB.');
        await expect(cards.nth(1)).toContainText('For up to 4 members, sharing 2 TB.');
        await expect(cards.nth(2)).toContainText('For up to 4 members, sharing 4 TB.');
        await expect(cards.nth(1)).toContainText(
            'Then $1.50 a month for each member after that, up to 20.',
        );
        await choose.getByRole('button', { name: /^Yearly/ }).click();
        await expect(cards.nth(1)).toContainText('$192 a year');
        await expect(cards.nth(1)).toContainText(
            'Then $15 a year for each member after that, up to 20.',
        );
        for (const name of ['Choose Family Plus', 'Choose Family Pro', 'Choose Family Max'])
            await expect(choose.getByRole('button', { name, exact: true })).toBeEnabled();
        await expect(maya.page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);
        await expect(maya.page.locator('[data-family-plan]')).toHaveCount(0);

        await show(none, `/app/s/${groupId}`);
        await expect(maya.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 60_000,
        });
        await expect(maya.page.getByRole('button', { name: 'New family folder' })).toHaveCount(0);
        // Deleting adds no storage: a folder can still be deleted without a plan.
        await canStillDelete();
    });

    test('a live plan the person pays for: the facts, places quoted as Polar charges them, and every control', async () => {
        await show(live());
        const billing = maya.page.locator('[data-family-plan="billing"]');
        await expect(billing).toContainText('Family Pro · 2 TB', { timeout: 60_000 });
        await expect(billing).toContainText('$26 a month · renews');
        await expect(billing).toContainText('1 of 8 taken · 4 included');
        // The header reads the same paid limit, not the family row's default.
        await expect(maya.page.getByText('1 of 8 places taken.')).toBeVisible();
        await expect(billing).toContainText('300 GB of 2 TB used');
        await expect(billing).toContainText('Paid by');
        await expect(maya.page.locator('[data-choose-plan]')).toHaveCount(0);
        await expect(maya.page.getByRole('button', { name: 'Invite someone' })).toBeVisible();
        for (const name of [
            'Manage payment and invoices',
            'Change plan',
            'Remove places at renewal',
            'Cancel plan',
        ])
            await expect(billing.getByRole('button', { name })).toBeVisible();

        await billing.getByRole('button', { name: 'Add places' }).click();
        const dialog = maya.page.getByRole('dialog', { name: 'Add places' });
        await expect(dialog).toContainText('Each place past the 4 included is $1.50 a month.');
        await expect(dialog).toContainText('Charged now$0.96');
        await dialog.getByRole('button', { name: 'More' }).click();
        // Truncated once over the raise, not per place.
        await expect(dialog).toContainText('Charged now$1.93');
        await expect(dialog).toContainText('Then$29 a month');
        await expect(dialog.getByRole('button', { name: 'Add 2 places' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();

        // Change plan: the other monthly tiers, a bigger one now, a smaller one at the renewal.
        await billing.getByRole('button', { name: 'Change plan' }).click();
        const change = maya.page.getByRole('dialog', { name: 'Change plan' });
        await expect(change.locator('[data-tier-option]')).toHaveText([
            /Family Plus · 800 GB\$16 a month/,
            /Family Pro · 2 TB\s*Your plan/,
            /Family Max · 4 TB\$36 a month/,
        ]);
        // Twenty of thirty-one days of the 10.00 difference: 6.4516, about 6.45.
        await expect(change).toContainText('Charged nowAbout $6.45');
        await expect(change).toContainText('Then$36 a month from');
        await expect(change.getByRole('button', { name: 'Change to Family Max' })).toBeEnabled();
        await change.getByText('Family Plus · 800 GB').click();
        await expect(change).toContainText('Until thenFamily Pro · 2 TB');
        await expect(change.getByRole('button', { name: /^Change on / })).toBeEnabled();
        await change.getByRole('button', { name: 'Cancel' }).click();
        // Folders holding more than Family Plus's 800 GB: how much to free, and no button.
        await show(live({}, 900));
        await billing.getByRole('button', { name: 'Change plan' }).click({ timeout: 60_000 });
        await change.getByText('Family Plus · 800 GB').click();
        await expect(change.locator('[data-tier-over]')).toContainText(
            'Your family stores 900 GB, more than Family Plus’s 800 GB. Free at least 100 GB before changing to it.',
        );
        await expect(change.getByRole('button', { name: /^Change on / })).toBeDisabled();
        await change.getByRole('button', { name: 'Cancel' }).click();
        // A move to a smaller tier waiting for the renewal: said on the card, and it can be kept.
        await show(live({ pendingProductId: 'plus-month' }));
        await expect(billing).toContainText('Changes to Family Plus · 800 GB on', {
            timeout: 60_000,
        });
        await expect(billing.getByRole('button', { name: 'Keep Family Pro' })).toBeVisible();

        await show(live(), `/app/s/${groupId}`);
        await expect(maya.page.getByRole('button', { name: 'New family folder' })).toBeVisible({
            timeout: 60_000,
        });
    });

    test('a plan set to end, one that ended, and a member’s view each say only what is true', async () => {
        await show(live({ cancelAtPeriodEnd: true }));
        const ending = maya.page.locator('[data-plan-notice="ending"]');
        await expect(ending).toContainText(`${family}’s plan ends on`, { timeout: 60_000 });
        await expect(ending).toContainText(
            'After that, nobody can upload to the family folders. Nothing is deleted.',
        );
        const billing = maya.page.locator('[data-family-plan="billing"]');
        await expect(
            billing.getByRole('button', { name: 'Manage payment and invoices' }),
        ).toBeVisible();
        for (const name of ['Add places', 'Change plan', 'Remove places at renewal', 'Cancel plan'])
            await expect(billing.getByRole('button', { name })).toHaveCount(0);

        await show({
            ...none,
            payer: { userId: 'payer', you: true },
            lastPlan: {
                productName: 'Family (monthly)',
                endedAt: new Date(Date.now() - 3 * DAY).toISOString(),
            },
        });
        const lapsed = maya.page.locator('[data-plan-notice="lapsed"]');
        await expect(lapsed).toContainText(`${family}’s plan ended on`, { timeout: 60_000 });
        await expect(lapsed).toContainText('Nothing has been deleted.');
        await expect(maya.page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
        await expect(maya.page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);
        // And a family whose plan ended can delete a folder to free space.
        await show(
            {
                ...none,
                payer: { userId: 'payer', you: true },
                lastPlan: {
                    productName: 'Family (monthly)',
                    endedAt: new Date(Date.now() - 3 * DAY).toISOString(),
                },
            },
            `/app/s/${groupId}`,
        );
        await expect(maya.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 60_000,
        });
        await canStillDelete();

        // A member who doesn't hold billing: the plan's name and the storage, no money, no controls.
        // The real member payload: the plan's name, the pool and whether a plan is live; nothing else.
        await show({
            enabled: true,
            view: 'member',
            hasPlan: true,
            planName: 'Family Pro (monthly)',
            storage: { usedBytes: String(300 * 1024 ** 3), quotaBytes: String(2 * 1024 ** 4) },
        });
        const glance = maya.page.locator('[data-family-plan="glance"]');
        await expect(glance).toContainText('Family Pro · 2 TB', { timeout: 60_000 });
        await expect(glance).toContainText('300 GB of 2 TB used');
        await expect(maya.page.getByText('Next charge')).toHaveCount(0);
        await expect(maya.page.getByRole('button', { name: 'Add places' })).toHaveCount(0);
        await expect(
            maya.page.getByRole('button', { name: 'Manage payment and invoices' }),
        ).toHaveCount(0);
    });
});

/*
 * The pricing page's Create a family, pressed signed out: it signs up first and lands on
 * Account → Family, through the return it keeps in this browser (rememberReturn, for an hour). The
 * section shows only where the server sells plans and lists a family plan, so this skips
 * with billing off, as every CI job runs; it runs against a server with a Polar catalogue
 * (verify-hushos `launch --billing polar`).
 */
test.describe('creating a family from the pricing page', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('someone without an account signs up from Create a family and lands on Account → Family', async ({
        browser,
        request,
    }) => {
        const catalogue = (await (await request.get('/api/billing/catalogue')).json()) as {
            enabled?: boolean;
            families?: unknown[];
        };
        test.skip(
            !catalogue.enabled || !catalogue.families?.length,
            'Billing is off or sells no family plan, so the pricing page has no family section.',
        );
        test.setTimeout(300_000);
        const page = await (await newContext(browser)).newPage();
        await page.goto('/pricing', { waitUntil: 'networkidle' });
        const create = page
            .locator('[data-family-plan]')
            .getByRole('link', { name: 'Create a family', exact: true });
        // A press before hydration follows the link without keeping the return.
        await hydrated(create);
        await create.click();
        await expect(page).toHaveURL(/\/register$/);
        await registerAccount(page, 'Rosa Ekström', undefined, {
            viaCurrentPage: true,
            landsOn: /\/app\/family$/,
        });
        await expect(
            page.locator('[data-no-family]').getByRole('button', { name: 'Create a family' }),
        ).toBeVisible({ timeout: 60_000 });
    });
});

test.describe.serial('deleting a family folder', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let ida: Person;
    let leo: Person;
    let mia: Person;
    let groupPath: string;
    const family = 'Berg family';

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300_000);
        ida = await person(browser, 'Ida Berg');
        leo = await person(browser, 'Leo Berg');
        mia = await person(browser, 'Mia Berg');
    });
    test.afterAll(async () => {
        for (const who of [ida, leo, mia]) await who?.page.context().close();
    });

    test('a manager deletes a folder: it is gone for everyone, and a later removal does not rotate it', async () => {
        test.setTimeout(600_000);
        await createFamily(ida, family);
        groupPath = new URL(ida.page.url()).pathname;
        await invite(ida, leo.email);
        await accept(leo, family);
        const dialog = await checkWords(ida, leo);
        const code = await letIn(dialog, 'Leo', family);
        await typeHidden(leo, await newcomerCode(leo, code), code);
        await expect(leo.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        await dialog.getByRole('button', { name: 'Done' }).click();

        // A second folder, which Leo opens and adds to.
        await ida.page.getByRole('link', { name: 'Family folders', exact: true }).first().click();
        await expect(ida.page).toHaveURL(/\/app\/s\/[0-9a-f-]+$/);
        const spacePath = new URL(ida.page.url()).pathname;
        await ida.page.getByRole('button', { name: 'New family folder' }).click();
        const create = ida.page.getByRole('dialog', { name: 'New family folder' });
        await create.getByLabel('Name').fill('Photos');
        await create.getByRole('button', { name: 'Create folder' }).click();
        await expect(create).toHaveCount(0, { timeout: 90_000 });
        await openFamilyFolder(leo, family, 'Photos');
        await upload(leo, 'beach.txt', 'Sand\n');

        // Leo doesn't manage the family: his rows have no menu.
        await leo.page.goto(spacePath);
        await expect(leo.page.locator('[data-area="Photos"]')).toBeVisible({ timeout: 90_000 });
        await expect(leo.page.getByRole('button', { name: 'More for Photos' })).toHaveCount(0);

        // Ida deletes it from its row's menu, and the dialog says what happens to its files.
        await ida.page.goto(spacePath);
        await expect(ida.page.locator('[data-area="Photos"]')).toHaveAttribute(
            'data-area-write',
            'writable',
            { timeout: 90_000 },
        );
        await ida.page.getByRole('button', { name: 'More for Photos' }).click();
        await ida.page.getByRole('menuitem', { name: 'Delete family folder' }).click();
        const confirm = ida.page.getByRole('alertdialog', { name: 'Delete “Photos”?' });
        await expect(confirm).toContainText(
            'deleted from the server, normally after 30 days, and their space is freed when they are',
        );
        await expect(confirm).toContainText('Anyone who kept copies or keys keeps them');
        const deleted = ida.page.waitForResponse(
            (response) =>
                response.request().method() === 'POST' &&
                /\/api\/groups\/[0-9a-f-]+\/areas\/[0-9a-f-]+\/delete$/.test(
                    new URL(response.url()).pathname,
                ),
            { timeout: 90_000 },
        );
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        expect((await deleted).status()).toBe(200);
        await expect(confirm).toHaveCount(0, { timeout: 60_000 });
        await expect(ida.page.locator('[data-area="Photos"]')).toHaveCount(0, { timeout: 60_000 });
        await expect(ida.page.locator('[data-area="Family"]')).toBeVisible();

        // Gone for Leo too: on a fresh load the server lists only "Family".
        const spaces = leo.page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/drive/spaces',
            { timeout: 90_000 },
        );
        await leo.page.goto(spacePath);
        const listed = (await (await spaces).json()) as {
            spaces: { space: { kind: string }; areas: unknown[] }[];
        };
        expect(listed.spaces.find((at) => at.space.kind === 'group')?.areas).toHaveLength(1);
        await expect(leo.page.locator('[data-area="Family"]')).toBeVisible({ timeout: 90_000 });
        await expect(leo.page.locator('[data-area="Photos"]')).toHaveCount(0);

        // Leo's removal rotates the family's one live folder; the deleted one is not in the call.
        await openFamilyPage(ida, groupPath, family);
        const removal = ida.page.waitForRequest(
            (request) =>
                request.method() === 'POST' &&
                /\/api\/groups\/[0-9a-f-]+\/members\/[0-9a-f-]+\/remove$/.test(
                    new URL(request.url()).pathname,
                ),
            { timeout: 120_000 },
        );
        await ida.page.getByRole('button', { name: 'More for Leo Berg' }).click();
        await ida.page.getByRole('menuitem', { name: 'Remove from family' }).click();
        await ida.page
            .getByRole('alertdialog', { name: `Remove Leo from ${family}?` })
            .getByRole('button', { name: 'Remove from family' })
            .click();
        const sheet = ida.page.getByRole('dialog', { name: 'Remove Leo' });
        const body = (await removal).postDataJSON() as {
            rotations?: { workspaceId: string }[];
        };
        expect(body.rotations).toHaveLength(1);
        await expect(sheet.locator('[data-outcome="removed"]')).toBeVisible({ timeout: 120_000 });
        await sheet.getByRole('button', { name: 'Done' }).click();
        await expect(ida.page.locator(`[data-member="${leo.email}"]`)).toHaveCount(0, {
            timeout: 60_000,
        });
    });

    test('let someone in after a folder was deleted', async () => {
        test.setTimeout(600_000);
        await openFamilyPage(ida, groupPath, family);
        await invite(ida, mia.email);
        await accept(mia, family);
        const dialog = await checkWords(ida, mia);
        // The admission grants the one live folder: the deleted one's key is asked for by nobody.
        const admission = ida.page.waitForRequest(
            (request) =>
                request.method() === 'POST' &&
                /\/api\/groups\/[0-9a-f-]+\/members\/[0-9a-f-]+\/admit$/.test(
                    new URL(request.url()).pathname,
                ),
            { timeout: 120_000 },
        );
        const code = await letIn(dialog, 'Mia', family);
        const body = (await admission).postDataJSON() as { grants?: { workspaceId: string }[] };
        expect(body.grants).toHaveLength(1);
        await typeHidden(mia, await newcomerCode(mia, code), code);
        // Exactly the family's page: "Join Berg family" is the join screen still.
        await expect(
            mia.page.getByRole('heading', { level: 1, name: family, exact: true }),
        ).toBeVisible({ timeout: 90_000 });
        await dialog.getByRole('button', { name: 'Done' }).click();
        // Mia opens the family's live folder, and the deleted one is listed for nobody.
        await openFamilyFolder(mia, family, 'Family');
        await upload(mia, 'list.txt', 'Milk\n');
    });
});

test.describe('families off', () => {
    test.skip(familiesOn, 'Families are on (GROUPS_ENABLED).');

    test('families stay out of sight on a server that does not serve them', async ({ browser }) => {
        test.setTimeout(180_000);
        const page = await (await newContext(browser)).newPage();
        await registerAccount(page, 'Rae Off');
        await expect(page.getByRole('link', { name: 'My files' }).first()).toBeVisible();
        // Asked only once the server has said families are off, so the absence means something.
        const capabilities = page.waitForResponse(
            (response) => response.url().endsWith('/api/drive/capabilities') && response.ok(),
        );
        await page.goto('/app/account');
        expect(((await (await capabilities).json()) as { groups?: boolean }).groups).not.toBe(true);
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.locator('[data-your-family]')).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 2, name: 'Family' })).toHaveCount(0);
        await expect(page.locator('[data-family-header]')).toHaveCount(0);
        await page.goto('/app/families');
        await expect(page.getByText('Families aren’t available here')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await page.context().close();
    });
});
