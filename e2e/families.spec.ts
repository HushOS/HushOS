import { randomBytes, randomUUID } from 'node:crypto';
import { planTierName } from '@hushos/billing/protocol';
import { readFileSync } from 'node:fs';
import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type Locator,
    type Page,
    type Response,
    type Route,
} from '@playwright/test';
import { SQL } from 'bun';
import {
    e2eDatabase,
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
            'After that, nobody can upload to the family folders, and everyone’s own files count against their own storage again. Nothing is deleted.',
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

    test('who stores what: a manager sees each person’s own files rounded up, a member only their own', async () => {
        const GIB = 1024 ** 3;
        // Maya's own id, as the family's member list names her: her row reads You.
        const detail = (await (
            await maya.page.request.get(`/api/groups/${groupId}`, {
                headers: { 'HushOS-Client': 'web/1' },
            })
        ).json()) as {
            members: { userId: string; name: string }[];
        };
        const mayaId = detail.members.find((member) => member.name === 'Maya Ekström')!.userId;
        // As the server rounds it for someone who manages the family (3.9): whole GB, rounded
        // up, largest first, "0" for anything under 1 GB. An id the member list doesn't name
        // (someone who joined since this page read it) reads as someone in the family.
        await show({
            ...live(),
            usage: {
                ownBytes: String(Math.round(0.4 * GIB)),
                foldersBytes: String(40 * GIB),
                members: [
                    { userId: 'not-on-this-list', ownBytesRounded: String(12 * GIB) },
                    { userId: mayaId, ownBytesRounded: '0' },
                ],
            },
        });
        const usage = maya.page.locator('[data-family-usage="manager"]');
        await expect(usage.locator('[data-usage-member]')).toHaveText(
            ['Someone in the family12 GB', 'YouUnder 1 GB'],
            { timeout: 60_000 },
        );
        await expect(usage.locator('[data-usage-folders]')).toHaveText('Family folders40 GB');
        // 2 TB less the 300 GB the family stores.
        await expect(usage.locator('[data-usage-free]')).toHaveText('Free1.71 TB');
        await expect(usage).toContainText(
            'How much each person’s own files take, rounded up to the whole GB. You can’t see what the files are.',
        );
        // Nothing of anyone's own exact bytes, not even the manager's, in the list.
        await expect(usage.locator('[data-usage-own]')).toHaveCount(0);

        // A member: their own files exactly, the folders and what is free; nobody else's.
        await show({
            enabled: true,
            view: 'member',
            hasPlan: true,
            planName: 'Family Pro (monthly)',
            storage: { usedBytes: String(2048 * GIB), quotaBytes: String(2048 * GIB) },
            usage: { ownBytes: String(1.5 * GIB), foldersBytes: '0', members: null },
        });
        const own = maya.page.locator('[data-family-usage="member"]');
        await expect(own.locator('[data-usage-own]')).toHaveText('Your files1.5 GB', {
            timeout: 60_000,
        });
        await expect(own.locator('[data-usage-member]')).toHaveCount(0);
        await expect(own.locator('[data-usage-folders]')).toHaveText('Family foldersNone');
        await expect(own.locator('[data-usage-free]')).toHaveText(
            'FreeThe family’s storage is full',
        );
        await expect(own).toContainText(
            `The people who manage ${family} see how much your files take, rounded up to the whole GB, never what they are.`,
        );
    });
});

/*
 * Family in the sidebar, wherever families are served: someone in no family (or only waiting to
 * join one) has a Family place leading to Account → Family, where they can create one; once in
 * a family, its name heads the sidebar instead and leads to the same page.
 */
test.describe.serial('Family in the sidebar', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('someone in no family finds Family there; in one, the family’s name leads to it instead', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const nia = await person(browser, 'Nia Okafor');
        const family = 'Okafor family';
        // Asked once the families are known, so what the sidebar shows means something.
        const listed = nia.page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/groups' && response.ok(),
        );
        await nia.page.goto('/app/drive');
        await listed;
        const place = nia.page
            .locator('[data-family-place]')
            .getByRole('link', { name: 'Family', exact: true });
        await expect(place).toBeVisible({ timeout: 60_000 });
        await expect(nia.page.locator('[data-family-header]')).toHaveCount(0);
        await place.click();
        await expect(nia.page).toHaveURL(/\/app\/family$/);
        await expect(
            nia.page.locator('[data-no-family]').getByRole('button', { name: 'Create a family' }),
        ).toBeVisible({ timeout: 60_000 });

        await createFamily(nia, family);
        await nia.page.goto('/app/drive');
        const header = nia.page
            .locator('[data-family-header]')
            .getByRole('link', { name: family, exact: true });
        await expect(header).toBeVisible({ timeout: 60_000 });
        // One way to the family, never a second Family beside its name.
        await expect(nia.page.locator('[data-family-place]')).toHaveCount(0);
        await header.click();
        await expect(nia.page).toHaveURL(/\/app\/family$/);
        await expect(nia.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 60_000,
        });
        await nia.page.context().close();
    });
});

/*
 * A family plan from the pricing page, like a personal one: each family tier has its own
 * button. Signed out, it signs up with the tier as the plan; sign-up says it's a family plan,
 * and the first visit after it (recovery kit saved, device unlocked) opens Create a family with
 * that tier and a name already filled in, so one click goes to checkout. The server then
 * forgets the tier, so the next visit goes where the person chooses. Signed in and in no
 * family, each tier opens Create a family with it; in a family, the section offers only theirs.
 * The section shows only where the server sells plans and lists a family plan, so this skips
 * with billing off, as every CI job runs; it runs against a server with a Polar catalogue
 * (verify-hushos `launch --groups --billing polar`). Nothing is paid: Create and pay is never
 * pressed, and the family made at the end is made without a plan.
 */
test.describe.serial('signing up for a family plan from the pricing page', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('a tier signs up with it, and the first visit opens Create a family with it and a name', async ({
        browser,
        request,
    }) => {
        const plans = await familyCatalogue(request);
        test.skip(
            !plans.length,
            'Billing is off or sells no family plan, so the pricing page has no family section.',
        );
        test.setTimeout(300_000);
        const page = await (await newContext(browser)).newPage();
        await page.goto('/pricing', { waitUntil: 'networkidle' });
        const section = page.locator('[data-family-plan]');
        // One button per tier, none for the section as a whole.
        await expect(section.getByRole('link', { name: 'Create a family' })).toHaveCount(0);
        const tiers = section.locator('[data-family-tier]');
        await expect(tiers.getByRole('link', { name: /^Start with Family / })).toHaveCount(
            await tiers.count(),
        );
        const pro = section.locator('[data-family-tier="pro"]');
        const start = pro.getByRole('link', { name: 'Start with Family Pro', exact: true });
        const href = new URL((await start.getAttribute('href'))!, 'http://hushos.invalid');
        expect(href.pathname).toBe('/register');
        const tier = plans.find((plan) => plan.id === href.searchParams.get('plan'));
        expect(tier?.tier).toBe('pro');
        // The currency the tier is shown in rides along, so sign-up and checkout use it.
        const shownIn = href.searchParams.get('currency');
        expect(Object.keys(tier!.prices)).toContain(shownIn);
        await hydrated(start);
        await start.click();
        await expect(page).toHaveURL(/\/register\?plan=/);
        const chosen = page.locator('[data-chosen-plan="family"]');
        await expect(chosen).toContainText(`${planTierName(tier!)} · `, { timeout: 60_000 });
        await expect(chosen).toContainText(
            `A family plan with ${tier!.includedMembers} members included.`,
        );
        await expect(chosen).toContainText(
            'You name your family and pay after your account is set up.',
        );

        await registerAccount(page, 'Rosa Ekström', undefined, {
            viaCurrentPage: true,
            landsOn: /\/app\/family\?create=/,
        });
        const landed = new URL(page.url());
        expect(landed.searchParams.get('create')).toBe(tier!.id);
        expect(landed.searchParams.get('currency')).toBe(shownIn);
        const dialog = page.getByRole('dialog', { name: 'Create a family' });
        await expect(dialog).toContainText(`Then you pay for ${planTierName(tier!)}`, {
            timeout: 60_000,
        });
        await expect(dialog.getByLabel('Name')).toHaveValue('Rosa Ekström’s family');
        await expect(dialog.getByRole('button', { name: 'Create and pay' })).toBeEnabled();
        // Opened once: the server no longer offers it, so the next visit goes where they choose.
        const summary = (await (await page.request.get('/api/billing')).json()) as {
            intendedFamily?: string | null;
        };
        expect(summary.intendedFamily).toBeNull();
        await dialog.getByRole('button', { name: 'Cancel' }).click();

        // Signed in and in no family: each tier opens Create a family with it, priced as shown.
        await page.goto('/pricing', { waitUntil: 'networkidle' });
        const choose = section
            .locator('[data-family-tier="pro"]')
            .getByRole('link', { name: 'Choose Family Pro', exact: true });
        await expect(choose).toBeVisible({ timeout: 60_000 });
        const target = new URL((await choose.getAttribute('href'))!, 'http://hushos.invalid');
        expect(target.pathname).toBe('/app/family');
        expect(target.searchParams.get('create')).toBe(tier!.id);
        expect(Object.keys(tier!.prices)).toContain(target.searchParams.get('currency'));
        await expect(section.getByRole('link', { name: /^Start with / })).toHaveCount(0);

        // In a family: only theirs, never a second one.
        await createFamily({ page, email: '', name: 'Rosa Ekström' }, 'Ekström family');
        await page.goto('/pricing', { waitUntil: 'networkidle' });
        await expect(
            section.getByRole('link', { name: 'Open Ekström family', exact: true }),
        ).toHaveAttribute('href', '/app/family', { timeout: 60_000 });
        await expect(section.getByRole('link', { name: /^Choose Family / })).toHaveCount(0);
        await page.context().close();
    });
});

/*
 * Backing out of a pending join (accepted, not let in): Decline invitation, on the join screen
 * and on Family's Waiting to join row, asked once. The server's leave withdraws it; Family
 * then offers Create a family again. Real accounts and a real invitation, so it runs where
 * plans aren't sold (as CI runs): where they are, inviting needs a family with a paid plan.
 */
test.describe.serial('declining a pending join', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('someone waiting to join declines from Family: the wait is gone, and Create a family is back', async ({
        browser,
        request,
    }) => {
        test.skip(
            await sellsPlans(request),
            'Where plans are sold, inviting needs a family with a plan, which can’t be paid for here.',
        );
        test.setTimeout(300_000);
        const maya = await person(browser, 'Maya Berg');
        const sam = await person(browser, 'Sam Okafor');
        await createFamily(maya, 'Berg family');
        await invite(maya, sam.email);
        await accept(sam, 'Berg family');
        // The join screen offers it too, quietly.
        await expect(sam.page.getByRole('button', { name: 'Decline invitation' })).toBeVisible();
        await sam.page.goto('/app/family');
        const page = sam.page.locator('[data-no-family]');
        await expect(page.getByRole('link', { name: 'Continue joining Berg family' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await page.getByRole('button', { name: 'Decline invitation to Berg family' }).click();
        const ask = sam.page.getByRole('alertdialog');
        await expect(ask).toContainText('Decline the invitation to Berg family?');
        await expect(ask).toContainText('You can be invited again.');
        await ask.getByRole('button', { name: 'Decline invitation' }).click();
        await expect(ask).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByRole('link', { name: 'Continue joining Berg family' })).toHaveCount(
            0,
        );
        await expect(page.getByRole('button', { name: 'Create a family' })).toBeVisible();
        // The server says so too: the membership is gone from the account's families.
        const listed = (await (
            await sam.page.request.get('/api/groups', { headers: { 'HushOS-Client': 'web/1' } })
        ).json()) as {
            groups: { id: string; state: string }[];
        };
        expect(listed.groups.filter((group) => group.state === 'accepted')).toEqual([]);
        for (const who of [maya, sam]) await who.page.context().close();
    });
});

test.describe.serial('Family for someone waiting to join one', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('offers to finish joining, never Create a family, which would be refused once let in', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const ines = await person(browser, 'Inês Ortega');
        // Accepted and not let in, as route 2 lists it (an invitation needs a family with a plan
        // where plans are sold, so the list is answered here).
        const groupId = randomUUID();
        await ines.page.route(
            (url) => url.pathname === '/api/groups',
            (route: Route) =>
                route.request().method() === 'GET'
                    ? route.fulfill({
                          json: {
                              groups: [
                                  {
                                      id: groupId,
                                      kind: 'family',
                                      name: 'Ortega family',
                                      state: 'accepted',
                                  },
                              ],
                          },
                      })
                    : route.continue(),
        );
        await ines.page.goto('/app/family');
        const page = ines.page.locator('[data-no-family]');
        await expect(
            page.getByRole('link', { name: 'Continue joining Ortega family' }),
        ).toHaveAttribute('href', `/app/families/${groupId}/join`, { timeout: 60_000 });
        await expect(page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await ines.page.context().close();
    });
});

test.describe.serial('Pricing for someone waiting to join a family', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');

    test('offers to finish joining, never a tier that would make a second family', async ({
        browser,
        request,
    }) => {
        test.skip(
            !(await familyCatalogue(request)).length,
            'Billing is off or sells no family plan, so the pricing page has no family section.',
        );
        test.setTimeout(300_000);
        const ines = await person(browser, 'Inês Ortega');
        // Accepted an invitation and not let in yet, as route 2 lists it: the invitation flow
        // needs a family with a plan, which can't be paid for here, so the list is answered.
        const groupId = randomUUID();
        await ines.page.route(
            (url) => url.pathname === '/api/groups',
            (route: Route) =>
                route.request().method() === 'GET'
                    ? route.fulfill({
                          json: {
                              groups: [
                                  {
                                      id: groupId,
                                      kind: 'family',
                                      name: 'Ortega family',
                                      state: 'accepted',
                                  },
                              ],
                          },
                      })
                    : route.continue(),
        );
        await ines.page.goto('/pricing', { waitUntil: 'networkidle' });
        const section = ines.page.locator('[data-family-plan]');
        await expect(
            section.getByRole('link', { name: 'Continue joining Ortega family', exact: true }),
        ).toHaveAttribute('href', `/app/families/${groupId}/join`, { timeout: 60_000 });
        await expect(
            section.getByRole('link', { name: /^(Choose|Start with) Family / }),
        ).toHaveCount(0);
        await ines.page.context().close();
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

/*
 * Moving between My files and a family folder (docs/families-shared-pool.md 3.8). The move
 * dialog reaches the family's folders under Places and says what a move loses before it
 * starts; the file is decrypted on the device and uploaded again under the folder's keys,
 * and the server deletes the original in the same transaction as the copy lands. Where the
 * family's plan pools a member's own files (billing on, a live plan) nothing is counted
 * twice, even in a full pool: the meter doesn't change. A live plan needs Polar, which CI never
 * calls, so that test writes the family's plan row as billing's write would (the server's own
 * database, as operator roles are written) and runs only against a server that sells plans
 * (verify-hushos `launch --groups --billing polar`). With billing off nothing is pooled, the
 * two are separate allowances, and the copy is charged to the folder: that test runs in CI.
 */
test.describe.serial('moving between My files and a family folder', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    const family = 'Okafor family';
    let ada: Person;
    let billing = false;

    test.beforeAll(async ({ browser, request }) => {
        test.setTimeout(300_000);
        const catalogue = (await (await request.get('/api/billing/catalogue')).json()) as {
            enabled?: boolean;
        };
        billing = catalogue.enabled === true;
        ada = await person(browser, 'Ada Okafor');
        await createFamily(ada, family);
        // The family's folder open and writable on this device before anything moves into it.
        await openFamilyFolder(ada, family, 'Family');
    });
    test.afterAll(async () => {
        await ada?.page.context().close();
    });

    /* Opens Move for `name` in the folder on screen, goes to Places, then the family's folder. */
    async function moveToFamilyFolder(name: string) {
        await ada.page.getByRole('button', { name: `More for ${name}` }).click();
        await ada.page.getByRole('menuitem', { name: /^Move(?: \S+)?$/ }).click();
        const dialog = ada.page.locator('[data-slot=dialog-content]');
        const location = dialog.getByRole('navigation', { name: 'Location' });
        await location.getByRole('button', { name: 'Places' }).click({ timeout: 60_000 });
        await dialog.getByRole('button', { name: 'Family', exact: true }).click();
        await expect(location.locator('[aria-current=location]')).toHaveText('Family');
        // Said before it starts: what a move to another place loses, and what it costs.
        const notice = dialog.locator('[data-move-across]');
        await expect(notice).toContainText(
            'Only the current version of each file moves; earlier versions are deleted.',
        );
        return { dialog, notice };
    }

    async function storage() {
        const answer = await ada.page.request.get('/api/auth/storage');
        return (
            (await answer.json()) as {
                storage: { usedBytes: string; pool: { name: string } | null };
            }
        ).storage;
    }

    /* `name` is gone from My files, read from the server: past `stays`, or an empty folder. */
    async function gone(name: string, stays?: string) {
        await ada.page.goto('/app/drive');
        await expect(
            stays ? fileRow(ada.page, stays) : ada.page.getByText('Nothing here yet'),
        ).toBeVisible({ timeout: 60_000 });
        await expect(fileRow(ada.page, name)).toHaveCount(0);
        // Deleted, not left in the Trash, where it would still count.
        await ada.page.goto('/app/trash', { waitUntil: 'networkidle' });
        // Not left in the Trash either, where it would still count: nothing of hers is there.
        await expect(ada.page.getByText('Trash is empty')).toBeVisible({ timeout: 60_000 });
    }

    test('without one pool (billing off) the copy is charged to the folder: the file lands there byte for byte, and the original is gone', async () => {
        test.skip(
            billing,
            'This server pools a member’s files; the next test moves within the pool.',
        );
        test.setTimeout(300_000);
        await ada.page.goto('/app/drive');
        await upload(ada, 'stays.txt', 'Not moving\n');
        await upload(ada, 'recipe.txt', 'Jollof, for eight\n');
        const { dialog, notice } = await moveToFamilyFolder('recipe.txt');
        await expect(notice).toContainText('It needs free space in Family for the copy');
        await dialog.getByRole('button', { name: 'Move here' }).click();
        await expect(dialog).toHaveCount(0, { timeout: 60_000 });
        // Done when it leaves My files, as the person sees it, and nothing more is on its way.
        await expect(fileRow(ada.page, 'recipe.txt')).toHaveCount(0, { timeout: 90_000 });
        await ada.page.waitForLoadState('networkidle');
        await openFamilyFolder(ada, family, 'Family');
        await expect(fileRow(ada.page, 'recipe.txt')).toBeVisible({ timeout: 90_000 });
        await ada.page.getByRole('button', { name: 'More for recipe.txt' }).click();
        const [download] = await Promise.all([
            ada.page.waitForEvent('download'),
            ada.page.getByRole('menuitem', { name: /^Download(?: \S+)?$/ }).click(),
        ]);
        expect(readFileSync((await download.path())!, 'utf8')).toBe('Jollof, for eight\n');
        await gone('recipe.txt', 'stays.txt');
    });

    test('a member moves a file from My files into a family folder and the meter doesn’t change', async () => {
        test.skip(
            !billing,
            'Billing is off: nothing is pooled, so the two are separate allowances.',
        );
        test.setTimeout(300_000);
        // The family's plan goes live as billing writes it, until next month, with a pool of
        // 1 GB: her file fills it (each part counts in whole GB), so the move must go as one,
        // charged nothing. A copy charged in full would be refused for room.
        const groupId = (await ada.page
            .getByRole('link', { name: 'Family folders', exact: true })
            .first()
            .getAttribute('href'))!
            .split('/')
            .at(-1)!;
        const database = new SQL(e2eDatabase().url);
        try {
            await database`
                insert into group_storage (group_id, quota_bytes, expires_at)
                values (${groupId}, ${String(1024n ** 3n)}, now() + interval '30 days')
                on conflict (group_id) do update
                    set quota_bytes = excluded.quota_bytes, expires_at = excluded.expires_at`;
        } finally {
            await database.close();
        }
        await expect
            .poll(async () => (await storage()).pool?.name, { timeout: 30_000 })
            .toBe(family);
        await ada.page.goto('/app/drive');
        await upload(ada, 'budget.txt', 'Rent, food, school\n');
        const meter = ada.page.getByText(/ of .+ used$/);
        await expect.poll(async () => (await storage()).usedBytes).not.toBe('0');
        await ada.page.reload();
        const before = { api: (await storage()).usedBytes, shown: await meter.innerText() };
        const { dialog, notice } = await moveToFamilyFolder('budget.txt');
        await expect(notice).toContainText(`It uses no more of ${family}’s storage.`);
        await dialog.getByRole('button', { name: 'Move here' }).click();
        await expect(dialog).toHaveCount(0, { timeout: 60_000 });
        // Done when it leaves My files, as the person sees it, and nothing more is on its way.
        await expect(fileRow(ada.page, 'budget.txt')).toHaveCount(0, { timeout: 90_000 });
        await ada.page.waitForLoadState('networkidle');
        await openFamilyFolder(ada, family, 'Family');
        await expect(fileRow(ada.page, 'budget.txt')).toBeVisible({ timeout: 90_000 });
        await gone('budget.txt');
        // One pool: the copy took the original's place, so neither the pool's figure nor the
        // meter moved. The pool counts each part in whole GB (her own files, the folders), so
        // My files held only this file: a copy left beside it, or in the Trash, would read a
        // second part, 2 GB.
        await ada.page.goto('/app/drive');
        await expect(meter).toHaveText(before.shown, { timeout: 60_000 });
        expect((await storage()).usedBytes).toBe(before.api);
    });
});

/* A family plan as the public catalogue lists it, for a plan written as billing writes it. */
type CatalogueFamily = {
    id: string;
    name: string;
    interval: 'month' | 'year';
    tier: string | null;
    quotaBytes: string;
    includedMembers: number;
    prices: Record<string, unknown>;
};

/* Whether this server sells family plans, and which: only then is anyone's storage pooled. */
async function familyCatalogue(request: APIRequestContext) {
    const catalogue = (await (await request.get('/api/billing/catalogue')).json()) as {
        enabled?: boolean;
        families?: CatalogueFamily[];
    };
    return catalogue.enabled ? (catalogue.families ?? []) : [];
}

async function sellsPlans(request: APIRequestContext) {
    const catalogue = (await (await request.get('/api/billing/catalogue')).json()) as {
        enabled?: boolean;
    };
    return catalogue.enabled === true;
}

/* The family's id, from Family folders in the sidebar (its page is /app/family). */
async function familyIdOf(who: Person) {
    const href = await who.page
        .getByRole('link', { name: 'Family folders', exact: true })
        .first()
        .getAttribute('href');
    return href!.split('/').at(-1)!;
}

/*
 * The family's plan goes live as billing writes it from Polar's webhook: the subscription's
 * row, the family's places and the pool's, for a month. A real checkout can't be paid here (nothing may call
 * Polar), so the rows are written in the server's own database, as the move test writes the
 * pool. No customer row: the daily reconcile lists families by customer, so it never asks
 * Polar about this one. Places: what the plan includes, so letting someone in buys nothing.
 */
async function makePlanLive(groupId: string, plan: CatalogueFamily) {
    const database = new SQL(e2eDatabase().url);
    try {
        await database`
            insert into group_billing_subscriptions (
                id, group_id, provider, product_id, product_name, status, recurring_interval,
                amount, currency, units, paid_units, paid_product_id, paid_quota_bytes,
                included_members, quota_bytes, current_period_start, current_period_end
            ) values (
                ${`e2e-${randomUUID()}`}, ${groupId}, 'polar', ${plan.id}, ${plan.name}, 'active',
                ${plan.interval}, 1000, 'usd', ${plan.includedMembers}, ${plan.includedMembers},
                ${plan.id}, ${plan.quotaBytes}, ${plan.includedMembers}, ${plan.quotaBytes},
                now(), now() + interval '30 days'
            )`;
        await database`
            update groups set seat_limit = ${plan.includedMembers}, updated_at = now()
            where id = ${groupId}`;
        await database`
            insert into group_storage (group_id, quota_bytes, expires_at)
            values (${groupId}, ${plan.quotaBytes}, now() + interval '30 days')
            on conflict (group_id) do update
                set quota_bytes = excluded.quota_bytes, expires_at = excluded.expires_at`;
    } finally {
        await database.close();
    }
}

async function storageOf(who: Person) {
    const answer = await who.page.request.get('/api/auth/storage');
    return (
        (await answer.json()) as {
            storage: {
                usedBytes: string;
                quotaBytes: string;
                pool: { groupId: string; name: string } | null;
                own: { usedBytes: string; allowanceBytes: string } | null;
            };
        }
    ).storage;
}

/*
 * One view for a family member (docs/families-shared-pool.md 7.1-7.4, step 6), driven as the
 * people in it. A personal account has no family in its sidebar. Where plans are sold, Plans
 * shows the family tiers beside the personal ones; one creates a family and goes to its
 * checkout, which is answered here with the family's own page (Polar can't be paid in a test),
 * and the plan then goes live as billing writes it. From then on the organizer's meter is the
 * family's pool on every page, and Plans says their storage comes from the family's plan. A
 * newcomer is told before accepting that their files will use the family's storage, with their
 * own figure; once in, the manager sees each person's own files rounded up to the whole GB and
 * the member only their own, which no answer to the member gives away for anyone else. The
 * member's leave dialog says what leaving does to their storage, and Trash shows My files'
 * and the family folders' as two sections. The pooled tests run only against a server that
 * sells family plans (verify-hushos `launch --groups --billing polar`); CI runs the first.
 */
test.describe.serial('one view for a family member, with one pool', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    const family = 'Lindgren family';
    let rosa: Person;
    let theo: Person;
    let plans: CatalogueFamily[] = [];
    let groupId: string;

    test.beforeAll(async ({ browser, request }) => {
        test.setTimeout(300_000);
        plans = await familyCatalogue(request);
        rosa = await person(browser, 'Rosa Lindgren');
    });
    test.afterAll(async () => {
        await rosa?.page.context().close();
        await theo?.page.context().close();
    });

    const sellsFamilies = () => plans.some((plan) => plan.interval === 'month');

    test('a personal account has no family of its own in the sidebar, and its storage is its own', async () => {
        // Asked once the families are known, so the absence means something.
        const listed = rosa.page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/groups' && response.ok(),
        );
        await rosa.page.goto('/app/drive');
        await listed;
        await expect(rosa.page.getByRole('link', { name: 'My files' }).first()).toBeVisible({
            timeout: 60_000,
        });
        await expect(rosa.page.locator('[data-family-header]')).toHaveCount(0);
        await expect(rosa.page.getByRole('link', { name: 'Family folders' })).toHaveCount(0);
        const meter = rosa.page.locator('[data-storage-meter="own"]');
        await expect(meter).toContainText(/ of .+ used/);
        // Not labelled: there is no family's storage it could be mistaken for.
        await expect(meter).not.toContainText('My files');
        await expect(rosa.page.locator('[data-storage-meter="pool"]')).toHaveCount(0);
    });

    test('Plans shows the family tiers beside the personal ones; one creates a family and goes to its checkout, and the meter then shows the pool', async () => {
        test.skip(!sellsFamilies(), 'This server sells no family plans: nothing is pooled.');
        test.setTimeout(300_000);
        const plus =
            plans.find((plan) => plan.interval === 'month' && plan.tier === 'plus') ??
            plans.find((plan) => plan.interval === 'month')!;
        const tier = planTierName({ name: plus.name });
        await rosa.page.goto('/app/billing');
        const section = rosa.page.locator('[data-family-plans]');
        await expect(section.locator('[data-plan]')).toHaveCount(
            plans.filter((plan) => plan.interval === 'month').length,
            { timeout: 60_000 },
        );
        // Beside the personal plans, not instead of them.
        await expect(rosa.page.locator('[data-plan="Free"]')).toBeVisible();
        // Polar's checkout can't be paid here: the checkout answers with the family's page.
        let asked: { productId?: string } | null = null;
        const checkout = /\/api\/billing\/groups\/[0-9a-f-]+\/checkout$/;
        await rosa.page.route(checkout, async (route: Route) => {
            asked = route.request().postDataJSON() as { productId?: string };
            await route.fulfill({ json: { url: '/app/family#from-checkout' } });
        });
        await section.getByRole('button', { name: `Create a family with ${tier}` }).click();
        const dialog = rosa.page.getByRole('dialog', { name: 'Create a family' });
        const gib = Number(plus.quotaBytes) / 1024 ** 3;
        await expect(dialog).toContainText(
            `Then you pay for ${tier}, ${gib >= 1024 ? `${gib / 1024} TB` : `${gib} GB`} for everyone’s own files and the family folders`,
        );
        await dialog.getByLabel('Name').fill(family);
        await dialog.getByRole('button', { name: 'Create and pay' }).click();
        // Where the checkout sent it, not the page a checkout that didn't open falls back to.
        await expect(rosa.page).toHaveURL(/\/app\/family#from-checkout$/, { timeout: 90_000 });
        await expect(rosa.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        expect(asked).toMatchObject({ productId: plus.id });
        await rosa.page.unroute(checkout);
        groupId = await familyIdOf(rosa);

        // Before the plan is live nothing is pooled: her meter is her own, labelled My files.
        expect((await storageOf(rosa)).pool).toBeNull();
        await expect(rosa.page.locator('[data-storage-meter="own"]')).toContainText('My files');

        await makePlanLive(groupId, plus);
        await expect.poll(async () => (await storageOf(rosa)).pool?.name).toBe(family);
        await rosa.page.goto('/app/drive');
        const meter = rosa.page.locator('[data-storage-meter="pool"]');
        await expect(meter).toContainText(family, { timeout: 60_000 });
        const quota = (await storageOf(rosa)).quotaBytes;
        expect(quota).toBe(plus.quotaBytes);
        await expect(meter).toContainText(/ of .+ used/);
        await expect(meter).toContainText(/\d \S+ free/);
        await expect(meter).not.toContainText('The family’s storage is full');
        // The same pool in the family folders: one meter for both.
        await rosa.page.getByRole('link', { name: 'Family folders', exact: true }).first().click();
        await expect(rosa.page).toHaveURL(/\/app\/s\/[0-9a-f-]+$/);
        await expect(meter).toContainText(family);

        // Plans: her storage comes from the family's plan, and no personal plan is offered.
        await rosa.page.goto('/app/billing');
        await expect(rosa.page.locator('[data-pooled-plan]')).toContainText(
            `Your storage comes from ${family}’s plan.`,
            { timeout: 60_000 },
        );
        await expect(rosa.page.locator('[data-plan="Free"]')).toHaveCount(0);
        await expect(rosa.page.locator('[data-family-plans]')).toHaveCount(0);
        await expect(rosa.page.locator('[data-pool-line]')).toContainText(
            `${family}’s storage, for everyone’s own files and the family folders.`,
        );
    });

    test('a member joins: the manager sees each person’s own files rounded up, the member only their own, and leaving says what it does to their storage', async ({
        browser,
    }) => {
        test.skip(!sellsFamilies(), 'This server sells no family plans: nothing is pooled.');
        test.setTimeout(420_000);
        theo = await person(browser, 'Theo Lindgren');
        await theo.page.goto('/app/drive');
        await upload(theo, 'theo-notes.txt', 'Theo’s own notes\n');
        await expect.poll(async () => (await storageOf(theo)).usedBytes).not.toBe('0');
        const theoBytes = (await storageOf(theo)).usedBytes;

        await rosa.page.goto('/app/family');
        await invite(rosa, theo.email);
        // Before accepting: his files will use the family's storage, with his own figure.
        await theo.page.goto(await invitationPath(theo.email));
        await expect(theo.page.locator('[data-join-storage]')).toHaveText(
            new RegExp(
                `^Once you’re let in, your files use ${family}’s storage\\. They take \\S+ \\S+ now\\.$`,
            ),
            { timeout: 60_000 },
        );
        await acceptOpened(theo, family);
        const dialog = await checkWords(rosa, theo);
        const code = await letIn(dialog, 'Theo', family);
        await typeHidden(theo, await newcomerCode(theo, code), code);
        await expect(theo.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 90_000,
        });
        await dialog.getByRole('button', { name: 'Done' }).click();

        // His own files now draw from the pool: the figures are the family's, his own beside them.
        await expect.poll(async () => (await storageOf(theo)).pool?.name).toBe(family);
        const pooled = await storageOf(theo);
        expect(pooled.quotaBytes).not.toBe(theoBytes);
        expect(BigInt(pooled.own!.usedBytes)).toBeGreaterThanOrEqual(BigInt(theoBytes));

        // The family folders hold something too.
        await openFamilyFolder(rosa, family, 'Family');
        await upload(rosa, 'household.txt', 'Bins on Tuesday\n');

        // The manager: one row each, rounded up to the whole GB, largest first; then the folders.
        await rosa.page.goto('/app/family');
        const managed = rosa.page.locator('[data-family-usage="manager"]');
        await expect(managed.locator('[data-usage-member]')).toHaveCount(2, { timeout: 60_000 });
        await expect(managed.locator('[data-usage-member]').filter({ hasText: 'You' })).toHaveText(
            'YouUnder 1 GB',
        );
        await expect(
            managed.locator('[data-usage-member]').filter({ hasText: 'Theo Lindgren' }),
        ).toHaveText('Theo LindgrenUnder 1 GB');
        await expect(managed.locator('[data-usage-folders]')).toHaveText('Family folders1 GB');

        // The member: his own files exactly, the folders, what is free; nobody else's.
        await theo.page.goto('/app/family');
        const own = theo.page.locator('[data-family-usage="member"]');
        await expect(own.locator('[data-usage-own]')).toContainText('Your files', {
            timeout: 60_000,
        });
        await expect(own.locator('[data-usage-member]')).toHaveCount(0);
        await expect(own.locator('[data-usage-folders]')).toHaveText('Family folders1 GB');
        // And no answer to him carries anyone else's usage: the family's summary names his own.
        const summary = (await (
            await theo.page.request.get(`/api/billing/groups/${groupId}`, {
                headers: { 'HushOS-Client': 'web/1' },
            })
        ).json()) as { view: string; usage: { ownBytes: string; members: unknown } };
        expect(summary.view).toBe('member');
        expect(summary.usage).toEqual({
            ownBytes: (await storageOf(theo)).own!.usedBytes,
            foldersBytes: String(1024 ** 3),
            members: null,
        });
        await expect(theo.page.locator('[data-storage-meter="pool"]')).toContainText(family);

        // Leaving says what it does to his files: back on his own allowance, which they fit.
        await theo.page.getByText('Technical details and leaving').click();
        await theo.page.getByRole('button', { name: 'Leave family' }).click();
        const leave = theo.page.getByRole('alertdialog', { name: `Leave ${family}?` });
        await expect(leave.locator('[data-leave-storage="fits"]')).toHaveText(
            /^Your files take \S+ \S+\. After you leave they count against the \S+ \S+ you have of your own\.$/,
        );
        await leave.getByRole('button', { name: 'Cancel' }).click();

        // Trash: My files' and the family folders', two sections of one page.
        await theo.page.goto('/app/trash');
        await expect(theo.page.getByRole('heading', { level: 2, name: 'My files' })).toBeVisible({
            timeout: 60_000,
        });
        await expect(
            theo.page.getByRole('heading', { level: 2, name: 'Family folders' }),
        ).toBeVisible();
        await expect(theo.page.locator('[data-family-trash]')).toBeVisible({ timeout: 90_000 });
    });
});

/*
 * Creating a family from Plans, where it can stop: a tier smaller than the person's own files
 * is refused before any family is made (the server would refuse its checkout and leave a
 * family with no plan); a locked device goes to Account → Family, which unlocks first, with the
 * tier it chose (a family's keys are made on the device); and a checkout that doesn't open
 * leaves the family made, on its page, where Choose a plan offers the tiers again. Polar is never
 * asked: the person's own figures and the checkout's refusal are answered on the wire. Runs only
 * against a server that sells family plans (verify-hushos `launch --groups --billing polar`).
 */
test.describe.serial('creating a family from Plans: where it stops', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    const GIB = 1024 ** 3;
    let nora: Person;
    let plans: CatalogueFamily[] = [];
    const monthly = (tier: string) =>
        plans.find((plan) => plan.interval === 'month' && plan.tier === tier)!;
    const tierOf = (plan: CatalogueFamily) => planTierName({ name: plan.name });

    test.beforeAll(async ({ browser, request }) => {
        test.setTimeout(300_000);
        plans = await familyCatalogue(request);
        test.skip(
            !plans.some((plan) => plan.tier === 'plus' && plan.interval === 'month') ||
                !plans.some((plan) => plan.tier === 'pro' && plan.interval === 'month'),
            'This server sells no Family Plus and Pro plans.',
        );
        nora = await person(browser, 'Nora Berg');
    });
    test.afterAll(async () => {
        await nora?.page.context().close();
    });

    test('a tier smaller than their own files can’t be chosen, and nothing is made', async () => {
        const plus = monthly('plus');
        const pro = monthly('pro');
        const room = BigInt(plus.quotaBytes);
        // Her own files, as the server answers them while she's in no family: 1 GB past Plus.
        const storage = async (route: Route) =>
            route.fulfill({
                json: {
                    storage: {
                        workspaceId: randomUUID(),
                        quotaBytes: String(4096n * BigInt(GIB)),
                        usedBytes: String(room + 1n),
                        reservedBytes: '0',
                        availableBytes: String(4096n * BigInt(GIB) - room - 1n),
                        pool: null,
                        own: null,
                    },
                },
            });
        await nora.page.route('**/api/auth/storage', storage);
        const created: string[] = [];
        nora.page.on('request', (request) => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/groups')
                created.push(request.url());
        });
        await nora.page.goto('/app/billing');
        const section = nora.page.locator('[data-family-plans]');
        const card = section.locator(`[data-plan="${tierOf(plus)}"]`);
        const why = `Your files take ${Number(room) / GIB + 1} GB, more than ${tierOf(plus)}’s ${Number(room) / GIB} GB. Choose a bigger plan or free at least 1 GB.`;
        await expect(card.locator('[data-tier-too-small]')).toHaveText(why, { timeout: 60_000 });
        await expect(
            card.getByRole('button', { name: `Create a family with ${tierOf(plus)}` }),
        ).toBeDisabled();
        // A tier that holds them is offered as before.
        await expect(
            section.getByRole('button', { name: `Create a family with ${tierOf(pro)}` }),
        ).toBeEnabled();
        await expect(
            section.locator(`[data-plan="${tierOf(pro)}"] [data-tier-too-small]`),
        ).toHaveCount(0);
        // Asked for by address too (a locked device's way in): the dialog says why and makes nothing.
        await nora.page.goto(`/app/family?create=${plus.id}&currency=usd`);
        const dialog = nora.page.getByRole('dialog', { name: 'Create a family' });
        await expect(dialog).toContainText(why, { timeout: 60_000 });
        await expect(dialog.getByRole('button', { name: 'Create and pay' })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        expect(created).toEqual([]);
        await nora.page.unroute('**/api/auth/storage', storage);
    });

    test('the dialog reads her figures again as it opens: files added since Plans loaded count', async () => {
        const plus = monthly('plus');
        const room = BigInt(plus.quotaBytes);
        // Her own files as the server answers them: none when Plans loads, then 1 GB past Plus
        // (added from another device), within the 30 s the figures are kept.
        let used = 0n;
        const storage = async (route: Route) =>
            route.fulfill({
                json: {
                    storage: {
                        workspaceId: randomUUID(),
                        quotaBytes: String(4096n * BigInt(GIB)),
                        usedBytes: String(used),
                        reservedBytes: '0',
                        availableBytes: String(4096n * BigInt(GIB) - used),
                        pool: null,
                        own: null,
                    },
                },
            });
        await nora.page.route('**/api/auth/storage', storage);
        await nora.page.goto('/app/billing');
        const button = nora.page
            .locator('[data-family-plans]')
            .getByRole('button', { name: `Create a family with ${tierOf(plus)}` });
        await expect(button).toBeEnabled({ timeout: 60_000 });
        used = room + 1n;
        await button.click();
        const dialog = nora.page.getByRole('dialog', { name: 'Create a family' });
        await expect(dialog).toContainText(
            `Your files take ${Number(room) / GIB + 1} GB, more than ${tierOf(plus)}’s`,
            { timeout: 30_000 },
        );
        await expect(dialog.getByRole('button', { name: 'Create and pay' })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await nora.page.unroute('**/api/auth/storage', storage);
    });

    test('on a locked device, Create a family unlocks first and carries the tier', async () => {
        const plus = monthly('plus');
        await nora.page.goto('/app/account', { waitUntil: 'networkidle' });
        await nora.page
            .getByRole('button', { name: 'Lock on this browser' })
            .click({ timeout: 60_000 });
        await nora.page
            .getByRole('alertdialog')
            .getByRole('button', { name: 'Lock', exact: true })
            .click();
        await expect(nora.page.getByRole('button', { name: 'Unlock on this browser' })).toBeVisible(
            { timeout: 60_000 },
        );
        // Plans is outside the drive and opens locked; a family's keys can't be made there now.
        await nora.page.goto('/app/billing');
        await nora.page
            .locator('[data-family-plans]')
            .getByRole('button', { name: `Create a family with ${tierOf(plus)}` })
            .click({ timeout: 60_000 });
        await expect(nora.page).toHaveURL(
            new RegExp(`/app/family\\?create=${plus.id}&currency=[a-z]{3}$`),
        );
        await expect(
            nora.page.getByRole('heading', { level: 1, name: 'HushOS is locked here' }),
        ).toBeVisible({ timeout: 60_000 });
        await nora.page.locator('input[autocomplete=current-password]').fill(PASSWORD);
        await nora.page.locator('input[autocomplete=current-password]').press('Enter');
        // Unlocked, the dialog opens with the tier chosen on Plans.
        const dialog = nora.page.getByRole('dialog', { name: 'Create a family' });
        await expect(dialog).toContainText(`Then you pay for ${tierOf(plus)},`, {
            timeout: 60_000,
        });
        await expect(dialog.getByRole('button', { name: 'Create and pay' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(nora.page.locator('[data-no-family]')).toBeVisible();
    });

    test('a checkout that doesn’t open leaves the family made, on its page, with Choose a plan', async () => {
        const plus = monthly('plus');
        const family = 'Berg family';
        const checkout = /\/api\/billing\/groups\/[0-9a-f-]+\/checkout$/;
        await nora.page.route(checkout, (route: Route) =>
            route.fulfill({ status: 503, json: { error: 'Payments are unavailable just now.' } }),
        );
        await nora.page.goto('/app/billing');
        await nora.page
            .locator('[data-family-plans]')
            .getByRole('button', { name: `Create a family with ${tierOf(plus)}` })
            .click({ timeout: 60_000 });
        const dialog = nora.page.getByRole('dialog', { name: 'Create a family' });
        await dialog.getByLabel('Name').fill(family);
        await dialog.getByRole('button', { name: 'Create and pay' }).click();
        await expect(
            nora.page.getByText(`${family} created, but the checkout didn’t open`),
        ).toBeVisible({ timeout: 90_000 });
        await expect(nora.page).toHaveURL(/\/app\/family$/);
        await expect(nora.page.getByRole('heading', { level: 1, name: family })).toBeVisible({
            timeout: 60_000,
        });
        await expect(nora.page.locator('[data-choose-plan]')).toBeVisible({ timeout: 60_000 });
        await nora.page.unroute(checkout);
        // And Plans no longer offers a second family to someone who has one.
        await nora.page.goto('/app/billing');
        await expect(nora.page.locator('[data-plan="Free"]')).toBeVisible({ timeout: 60_000 });
        await expect(nora.page.locator('[data-family-plans]')).toHaveCount(0);
    });
});

/*
 * While Polar's checkout opens, after the family was made: the page under the dialog stays as it
 * was (Plans keeps its tiers, Account → Family stays "no family" with the dialog over it) even
 * when the families are read again (a focus), the dialog stays on "Creating…" until the browser
 * has left, and the address isn't touched before then. Back from Polar goes on to the family's
 * page, where Choose a plan is, both ways a browser goes back:
 * - restored from the back-forward cache: Playwright's browsers don't keep one, so the checkout's
 *   address changes only the fragment (the page never leaves) and the restore is the `pageshow`
 *   event (persisted) dispatched here;
 * - loaded again: the checkout's address is another document (about:blank), and Back is the
 *   browser's own.
 * Polar is never asked: the checkout is answered on the wire. Runs only against a server that
 * sells family plans.
 */
test.describe.serial('creating a family from Plans: while the checkout opens, and back', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let plans: CatalogueFamily[] = [];
    const people: Person[] = [];
    const checkoutPath = /\/api\/billing\/groups\/[0-9a-f-]+\/checkout$/;

    test.beforeAll(async ({ request }) => {
        plans = await familyCatalogue(request);
        test.skip(
            !plans.some((plan) => plan.interval === 'month' && plan.tier === 'plus'),
            'This server sells no Family Plus plan.',
        );
    });
    test.afterAll(async () => {
        for (const who of people) await who.page.context().close();
    });

    /* Holds the checkout until `answer` is called with where it sends the browser. */
    async function holdCheckout(page: Page) {
        let answer!: (url: string) => void;
        const url = new Promise<string>((resolve) => (answer = resolve));
        await page.route(checkoutPath, async (route) =>
            route.fulfill({ json: { url: await url } }),
        );
        return answer;
    }

    /* What the browser does when Back restores the page from its back-forward cache. */
    const restored = (page: Page) =>
        page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
        );

    /* Someone new names a family with Family Plus from `from` and presses Create and pay. */
    async function createAndPay(
        browser: Browser,
        from: 'Plans' | 'Account → Family',
        who: { name: string; family: string },
    ) {
        const plus = plans.find((plan) => plan.interval === 'month' && plan.tier === 'plus')!;
        const tier = planTierName({ name: plus.name });
        const person_ = await person(browser, who.name);
        people.push(person_);
        const { page } = person_;
        const answer = await holdCheckout(page);
        const path =
            from === 'Plans' ? '/app/billing' : `/app/family?create=${plus.id}&currency=usd`;
        await page.goto(path);
        if (from === 'Plans')
            await page
                .locator('[data-family-plans]')
                .getByRole('button', { name: `Create a family with ${tier}` })
                .click({ timeout: 60_000 });
        const dialog = page.getByRole('dialog', { name: 'Create a family' });
        await dialog.getByLabel('Name').fill(who.family, { timeout: 60_000 });
        const made = page.waitForResponse(
            (response) =>
                response.request().method() === 'POST' &&
                new URL(response.url()).pathname === '/api/groups' &&
                response.ok(),
        );
        const asked = page.waitForRequest(checkoutPath);
        await dialog.getByRole('button', { name: 'Create and pay' }).click();
        await made;
        await asked;
        return { page, dialog, answer, path };
    }

    /* The page under the dialog, as it was before the family existed. */
    const under = (page: Page, from: 'Plans' | 'Account → Family') =>
        page.locator(from === 'Plans' ? '[data-family-plans]' : '[data-no-family]');

    for (const from of ['Plans', 'Account → Family'] as const) {
        test(`from ${from}: the page stays while the checkout opens, even read again, and Back from the cache goes to the family`, async ({
            browser,
        }) => {
            test.setTimeout(240_000);
            const family = from === 'Plans' ? 'Lund family' : 'Moen family';
            const { page, dialog, answer, path } = await createAndPay(browser, from, {
                name: from === 'Plans' ? 'Pia Lund' : 'Olga Moen',
                family,
            });
            // The families are read again while the checkout opens (the tab regains focus), and
            // they now list the new family: the page under the dialog doesn't move for it.
            const listed = page.waitForResponse(
                async (response) =>
                    response.request().method() === 'GET' &&
                    new URL(response.url()).pathname === '/api/groups' &&
                    (await response.text()).includes(family),
            );
            await page.evaluate(() =>
                document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
            );
            await listed;
            await page.waitForTimeout(1_000);
            await expect(dialog.getByRole('button', { name: 'Creating…' })).toBeVisible();
            await expect(under(page, from)).toBeVisible();
            await expect(page).toHaveURL(new URL(path, page.url()).href);
            // The checkout answers; its address changes only the fragment, so the page stays,
            // and the dialog with it, still busy, until the browser has left.
            answer(`${path}#checkout`);
            await expect(page).toHaveURL(/#checkout$/);
            await page.waitForTimeout(1_000);
            await expect(dialog.getByRole('button', { name: 'Creating…' })).toBeVisible();
            await expect(under(page, from)).toBeVisible();
            // Back from Polar, restored as it was: it goes on to the family's page.
            await restored(page);
            await expect(page).toHaveURL(/\/app\/family$/, { timeout: 60_000 });
            await expect(dialog).toHaveCount(0);
            await expect(page.getByRole('heading', { level: 1, name: family })).toBeVisible({
                timeout: 60_000,
            });
            await expect(page.locator('[data-choose-plan]')).toBeVisible({ timeout: 60_000 });
        });

        test(`from ${from}: Back that loads the page again goes to the family`, async ({
            browser,
        }) => {
            test.setTimeout(240_000);
            const family = from === 'Plans' ? 'Ek family' : 'Dahl family';
            const { page, answer } = await createAndPay(browser, from, {
                name: from === 'Plans' ? 'Ivo Ek' : 'Ada Dahl',
                family,
            });
            answer('about:blank');
            await page.waitForURL('about:blank', { timeout: 60_000 });
            await page.goBack();
            await expect(page).toHaveURL(/\/app\/family$/, { timeout: 60_000 });
            await expect(page.getByRole('heading', { level: 1, name: family })).toBeVisible({
                timeout: 60_000,
            });
            await expect(page.locator('[data-choose-plan]')).toBeVisible({ timeout: 60_000 });
            await expect(page.getByRole('dialog')).toHaveCount(0);
        });
    }

    test('Back while it is still creating: the family is made, and nothing moves the page after', async ({
        browser,
    }) => {
        test.setTimeout(240_000);
        const plus = plans.find((plan) => plan.interval === 'month' && plan.tier === 'plus')!;
        const tier = planTierName({ name: plus.name });
        const family = 'Holm family';
        const who = await person(browser, 'Tove Holm');
        people.push(who);
        const { page } = who;
        const answer = await holdCheckout(page);
        // Into Plans within the app, so Back stays in it.
        await page.goto('/app/account');
        await page.getByRole('link', { name: 'Plan and storage' }).first().click();
        await expect(page).toHaveURL(/\/app\/billing$/);
        await page
            .locator('[data-family-plans]')
            .getByRole('button', { name: `Create a family with ${tier}` })
            .click({ timeout: 60_000 });
        const dialog = page.getByRole('dialog', { name: 'Create a family' });
        await dialog.getByLabel('Name').fill(family, { timeout: 60_000 });
        const asked = page.waitForRequest(checkoutPath);
        await dialog.getByRole('button', { name: 'Create and pay' }).click();
        await asked;
        await page.goBack();
        await expect(page).toHaveURL(/\/app\/account$/);
        // The checkout answers after they've gone: no checkout opens, their page stays.
        answer('/app/billing#checkout');
        await expect(page.getByText(`${family} created`)).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_000);
        await expect(page).toHaveURL(/\/app\/account$/);
        // Nothing is left to send Plans to the family's page later.
        await page.getByRole('link', { name: 'Plan and storage' }).first().click();
        await expect(page).toHaveURL(/\/app\/billing$/);
        await page.waitForTimeout(2_000);
        await expect(page).toHaveURL(/\/app\/billing$/);
    });

    test('Back while it is still creating, from Account → Family: nothing moves the page after', async ({
        browser,
    }) => {
        test.setTimeout(240_000);
        const plus = plans.find((plan) => plan.interval === 'month' && plan.tier === 'plus')!;
        const tier = planTierName({ name: plus.name });
        const family = 'Lind family';
        const who = await person(browser, 'Saga Lind');
        people.push(who);
        const { page } = who;
        const answer = await holdCheckout(page);
        // Locked, Plans sends Create a family to Account → Family (?create=), within the app.
        await page.goto('/app/account', { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Lock on this browser' }).click({ timeout: 60_000 });
        await page
            .getByRole('alertdialog')
            .getByRole('button', { name: 'Lock', exact: true })
            .click();
        await expect(page.getByRole('button', { name: 'Unlock on this browser' })).toBeVisible({
            timeout: 60_000,
        });
        await page.goto('/app/billing');
        await page
            .locator('[data-family-plans]')
            .getByRole('button', { name: `Create a family with ${tier}` })
            .click({ timeout: 60_000 });
        await expect(page).toHaveURL(new RegExp(`/app/family\\?create=${plus.id}&`));
        await page.locator('input[autocomplete=current-password]').fill(PASSWORD, {
            timeout: 60_000,
        });
        await page.locator('input[autocomplete=current-password]').press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Create a family' });
        await dialog.getByLabel('Name').fill(family, { timeout: 60_000 });
        const asked = page.waitForRequest(checkoutPath);
        await dialog.getByRole('button', { name: 'Create and pay' }).click();
        await asked;
        await page.goBack();
        await expect(page).toHaveURL(/\/app\/billing$/);
        // The checkout answers after they've gone: no checkout opens, their page stays.
        answer('/app/family#checkout');
        await expect(page.getByText(`${family} created`)).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(2_000);
        await expect(page).toHaveURL(/\/app\/billing$/);
    });
});

/*
 * Someone already in a family opens an invitation to another (3.2): the page says to leave
 * theirs first and offers no way to accept; the invitation stays open. Where plans are sold,
 * the inviting family needs a live plan to invite anyone, written as billing writes it.
 */
test.describe
    .serial('an invitation to someone already in a family, and the family folders’ Trash', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let ivy: Person;
    let ben: Person;
    let benFamily: string;

    test.afterAll(async () => {
        await ivy?.page.context().close();
        await ben?.page.context().close();
    });

    test('an invitee in another family sees the leave-first notice and can’t accept', async ({
        browser,
        request,
    }) => {
        test.setTimeout(300_000);
        const plans = await familyCatalogue(request);
        const monthly = plans.find((plan) => plan.interval === 'month');
        test.skip(
            (await sellsPlans(request)) && !monthly,
            'This server sells plans but no family plan: nobody can be invited.',
        );
        ivy = await person(browser, 'Ivy Strand');
        ben = await person(browser, 'Ben Aalto');
        await createFamily(ben, 'Aalto family');
        benFamily = await familyIdOf(ben);
        await createFamily(ivy, 'Strand family');
        if (monthly) {
            // Ben's own family's folders hold files only with a plan (the next test adds one).
            await makePlanLive(benFamily, monthly);
            await makePlanLive(await familyIdOf(ivy), monthly);
            await ivy.page.reload();
        }
        await invite(ivy, ben.email);
        await ben.page.goto(await invitationPath(ben.email));
        await expect(
            ben.page.getByRole('heading', { name: /invited you to Strand family/ }),
        ).toBeVisible({ timeout: 60_000 });
        await expect(
            ben.page.getByText(
                'You’re in Aalto family. To join Strand family, leave yours first, from its page.',
                { exact: false },
            ),
        ).toBeVisible();
        await expect(ben.page.getByRole('button', { name: 'Accept' })).toBeDisabled();
        // Nothing about storage for someone who can't join yet.
        await expect(ben.page.locator('[data-join-storage]')).toHaveCount(0);
    });

    test('Trash: the family folders’ Trash is a section of Trash, beside My files’, and restores', async () => {
        test.setTimeout(300_000);
        await openFamilyFolder(ben, 'Aalto family', 'Family');
        await upload(ben, 'shopping.txt', 'Milk, bread\n');
        await ben.page.getByRole('button', { name: 'More for shopping.txt' }).click();
        await ben.page.getByRole('menuitem', { name: /^Move to Trash/ }).click();
        await expect(fileRow(ben.page, 'shopping.txt')).toHaveCount(0, { timeout: 60_000 });
        // Its old address leads to the section.
        await ben.page.goto(`/app/s/${benFamily}/trash`);
        await expect(ben.page).toHaveURL(/\/app\/trash#family$/, { timeout: 60_000 });
        await expect(ben.page.getByRole('heading', { level: 2, name: 'My files' })).toBeVisible();
        await expect(
            ben.page.getByRole('heading', { level: 2, name: 'Family folders' }),
        ).toBeVisible();
        // My files' Trash holds nothing of it; the family folders' does.
        await expect(ben.page.getByText('Trash is empty')).toBeVisible({ timeout: 60_000 });
        const section = ben.page.locator('[data-family-trash]');
        const row = section.locator('[data-node-id]').filter({ hasText: 'shopping.txt' });
        await expect(row).toBeVisible({ timeout: 90_000 });
        await expect(row).toContainText('Family');
        await row.getByRole('button', { name: 'Restore' }).click();
        await expect(row).toHaveCount(0, { timeout: 60_000 });
        await openFamilyFolder(ben, 'Aalto family', 'Family');
        await expect(fileRow(ben.page, 'shopping.txt')).toBeVisible({ timeout: 60_000 });
    });
});

test.describe.serial('families off', () => {
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
        await expect(page.locator('[data-family-place]')).toHaveCount(0);
        await page.goto('/app/families');
        await expect(page.getByText('Families aren’t available here')).toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Create a family' })).toHaveCount(0);
        await page.context().close();
    });
});
