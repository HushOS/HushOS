import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import {
    newContext,
    PASSWORD,
    registerAccount,
    rotationsDone,
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
 *    the newcomer opens it and adds to it.
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
 * 4. Families off: hidden from the sidebar, and the page says so.
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

const fileRow = (page: Page, name: string) =>
    page.locator('[data-node-id]').filter({ has: page.getByText(name, { exact: true }) });
const mark = (page: Page, name: string) => fileRow(page, name).locator('[data-integrity]');

/* The family's row under My files, then one of its folders, open and drawn. */
async function openFamilyFolder(who: Person, family: string, folder: string) {
    await who.page.goto('/app/drive');
    await who.page.getByRole('link', { name: family, exact: true }).first().click();
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
        await maya.page.getByRole('link', { name: family, exact: true }).first().click();
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
        await sam.page.getByRole('link', { name: family, exact: true }).last().click();
        await expect(sam.page.getByRole('button', { name: 'New family folder' })).toHaveCount(0);
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

/* The family's own page (`/app/families/<id>`), where its members and Technical details are. */
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

test.describe('removal, leaving and key changes', () => {
    test.skip(!familiesOn, 'Families are off (GROUPS_ENABLED).');
    let maya: Person;
    let sam: Person;
    let ana: Person;
    let groupPath = '';
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
        await maya.page.getByText('Technical details').click();
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
        await ana.page.screenshot({ path: test.info().outputPath('upload-waiting.png') });
        // Past a recheck it still waits: the walk has not reached Trips.
        await ana.page.waitForTimeout(6_000);
        await expect(row).toContainText('Finishing a key change…');
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
        test.setTimeout(600_000);
        // Sam adds a file after Replace keys, so the removal's walk is the first to re-key it.
        await openFamilyFolder(sam, family, 'Family');
        await upload(sam, 'sam-notes.txt', 'Notes by Sam\n');
        // Ana has Trips open, and her device will not hear of the key change the removal starts.
        await openFamilyFolder(ana, family, 'Family');
        await openSubfolder(ana, 'Trips');
        const unheard = await hideKeyChanges(ana.page);
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
        for (const step of ['hold', 'finish', 'remove'])
            await expect(sheet.locator(`[data-step="${step}"]`)).toHaveAttribute(
                'data-state',
                'done',
            );
        await maya.page.screenshot({ path: test.info().outputPath('removal-progress.png') });
        await sheet.getByRole('button', { name: 'Done' }).click();
        await expect(maya.page.locator(`[data-member="${sam.email}"]`)).toHaveCount(0, {
            timeout: 60_000,
        });
        await expect.poll(walk.batches, { timeout: 90_000 }).toBeGreaterThan(0);
        await expect(maya.page.locator('[data-key-change="walking"]')).toBeVisible({
            timeout: 60_000,
        });

        // Ana uploads into Trips while the walk is held there. Her device saw no key change, so
        // only the server says to wait (409 rotating): the upload waits and says so, not failed.
        const refused = ana.page.waitForResponse(
            (response) =>
                response.request().method() === 'POST' &&
                new URL(response.url()).pathname === '/api/drive/uploads' &&
                response.status() === 409,
            { timeout: 60_000 },
        );
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
        expect(((await (await refused).json()) as { code?: string }).code).toBe('rotating');
        const late = ana.page
            .locator('section[aria-label=Transfers]')
            .getByRole('listitem')
            .filter({ hasText: 'late.txt' })
            .last();
        await expect(late).toContainText('Finishing a key change…', { timeout: 60_000 });
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
        await expect(maya.page.locator('[data-details] [data-keys-replaced]')).toHaveText(
            'Keys replaced by you',
            { timeout: 60_000 },
        );
        await maya.page.screenshot({ path: test.info().outputPath('rekeyed-info.png') });
        await maya.page.keyboard.press('Escape');
        await fresh.page.goto(groupPath.replace('/families/', '/s/'));
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
        await sam.page.goto(groupPath.replace('/families/', '/s/'));
        await expect(sam.page.getByText('You’re not in this family')).toBeVisible({
            timeout: 60_000,
        });
    });

    test('leaving: the member goes, and the manager’s device marks them left with every folder’s keys replaced', async () => {
        test.setTimeout(360_000);
        await openFamilyPage(ana, groupPath, family);
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
        await maya.page.getByText('Technical details').click();
        await expect(maya.page.locator('[data-folder-keys="Family"]')).toContainText(
            'Key version 4',
            { timeout: 60_000 },
        );
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
