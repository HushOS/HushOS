import { expect, test, type Page } from '@playwright/test';
import { grip, newFolder, newPage, openFolder, registerAccount, rightClick } from './helpers';

/*
 * A folder long enough that the list draws only the rows near the screen (components/drive/
 * virtual-list.tsx): the keys, a Shift-click range, the row semantics and the right-click
 * menu must reach rows that are not drawn, or were never drawn together. One account and a
 * folder of 300 files, uploaded through the page as a person would, for the whole file; each
 * test starts at the top with nothing selected. The later tests change the folder (a drag
 * moves a file into a new folder, a range goes to the Trash, items arrive and leave from a
 * second tab), so they run last and count from what is there rather than from 300.
 *
 * Everything goes through the app as it ships, so the file runs against a production build
 * as CI's does: another tab on the same account stands in for another device, and its changes
 * reach this tab as a sync does, when this tab next polls for changes.
 */

let page: Page;
const COUNT = 300;
const name = (index: number) => `row-${String(index).padStart(3, '0')}`;

const rows = (p: Page) => p.locator('[data-node-id]');
// By the name's text, not its link's role: an open menu hides the page from the role tree.
const row = (p: Page, index: number) =>
    rows(p).filter({ has: p.locator('[data-row-name]').getByText(name(index), { exact: true }) });
const nameOf = (p: Page, index: number) => row(p, index).locator('[data-row-name]');
// The selection bar, found the same way while a menu hides the page from the role tree.
const selection = (p: Page) => p.locator('[data-selection-bar]');

/* Scrolls the page's sheet so row `index` is about at the top. */
async function scrollToRow(p: Page, index: number) {
    await p.evaluate((index) => {
        const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
        const height = document.querySelector('[data-node-id]')!.getBoundingClientRect().height;
        sheet.scrollTop = height * index;
    }, index);
}

/* How many drawn items share an id with another: a row drawn twice is two elements for one item. */
const duplicates = (p: Page) =>
    p.evaluate(() => {
        const ids = [...document.querySelectorAll('[data-node-id]')].map((item) =>
            item.getAttribute('data-node-id'),
        );
        return ids.length - new Set(ids).size;
    });
const rowCount = async (p: Page) => Number(await p.locator('table').getAttribute('aria-rowcount'));
/* How many drawn items have their middle inside the sheet's visible part. */
const onScreen = (p: Page) =>
    p.evaluate(() => {
        const box = document
            .querySelector('[data-scroll-restoration-id="app-sheet"]')!
            .getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>('[data-node-id]')].filter((item) => {
            const rect = item.getBoundingClientRect();
            const middle = (rect.top + rect.bottom) / 2;
            return middle > box.top && middle < box.bottom;
        }).length;
    });

/* The item under a fixed point of the sheet, and where its top is. */
const under = (p: Page) =>
    p.evaluate(() => {
        const box = document
            .querySelector('[data-scroll-restoration-id="app-sheet"]')!
            .getBoundingClientRect();
        const item = document
            .elementFromPoint(box.left + 400, box.top + 250)
            ?.closest<HTMLElement>('[data-node-id]');
        return item
            ? {
                  name: item.querySelector('[data-row-name]')?.textContent,
                  top: Math.round(item.getBoundingClientRect().top),
              }
            : null;
    });

/* Another tab on the same account, on the folder this one shows: another device, in effect. */
async function otherTab(p: Page) {
    const other = await p.context().newPage();
    await other.goto(p.url());
    await expect(other.locator('table')).toBeVisible({ timeout: 60_000 });
    await other.keyboard.press('Escape');
    return other;
}

/* Makes a folder in the folder `p` shows, through the New folder dialog. */
async function makeFolder(p: Page, folder: string) {
    await p.keyboard.press('Shift+N');
    await p.getByPlaceholder('Reports/2026').fill(folder);
    await p.keyboard.press('Enter');
    await expect(p.getByRole('dialog')).toHaveCount(0);
}

/* Uploads small text files named `names` into the folder `p` shows, and lets the transfers go. */
async function upload(p: Page, names: string[]) {
    const count = Number(await p.locator('table').getAttribute('aria-rowcount'));
    await p
        .locator('input[type=file]')
        .first()
        .setInputFiles(
            names.map((file) => ({
                name: file,
                mimeType: 'text/plain',
                buffer: Buffer.from(`${file}\n`),
            })),
        );
    // The panel draws every upload; folded away, the page does not redraw a row per byte.
    const fold = p.getByRole('button', { name: 'Collapse transfers', exact: true });
    if (await fold.isVisible().catch(() => false)) await fold.click();
    await expect(p.locator('table')).toHaveAttribute(
        'aria-rowcount',
        String(count + names.length),
        { timeout: 240_000 },
    );
    const close = p.getByRole('button', { name: 'Close transfers', exact: true });
    await expect(close).toBeVisible({ timeout: 60_000 });
    await close.click();
}

/*
 * Selects the rows named `first` to `last` in `p` (Shift-click) and moves them to the Trash.
 * They sit at one `end` of the list, which `p` scrolls to first: the rows elsewhere are not drawn.
 */
async function trashRange(p: Page, first: string, last: string, end: 'top' | 'foot') {
    await p.evaluate((end) => {
        const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
        sheet.scrollTop = end === 'top' ? 0 : sheet.scrollHeight;
    }, end);
    const named = (label: string) =>
        p
            .locator('[data-node-id]')
            .filter({ has: p.locator('[data-row-name]').getByText(label, { exact: true }) });
    await expect(named(first)).toBeVisible();
    await named(first).click(grip);
    await expect(named(last)).toBeVisible();
    await named(last).click({ ...grip, modifiers: ['Shift'] });
    await p.keyboard.press('Delete');
    await expect(p.getByText(/moved to Trash/).first()).toBeVisible({ timeout: 60_000 });
}

/* Rows the table draws past each edge of the screen (virtual-list.tsx's overscan). */
const OVERSCAN = 8;
/* The index of the first row whose middle is on screen, from its aria-rowindex. */
const firstOnScreen = (p: Page) =>
    p.evaluate(() => {
        const box = document
            .querySelector('[data-scroll-restoration-id="app-sheet"]')!
            .getBoundingClientRect();
        const first = [...document.querySelectorAll<HTMLElement>('tbody [data-node-id]')].find(
            (item) => {
                const rect = item.getBoundingClientRect();
                return (rect.top + rect.bottom) / 2 > box.top;
            },
        );
        return Number(first?.getAttribute('aria-rowindex') ?? 2) - 2;
    });

/* The sheet's scroll position once it has stopped moving (a key's scroll is animated). */
const settledScroll = (p: Page) =>
    p.evaluate(async () => {
        const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
        let last = -1;
        while (sheet.scrollTop !== last) {
            last = sheet.scrollTop;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return last;
    });

/* Once the items drawn have finished coming in: an entering item is drawn a few pixels low. */
const settledItems = (p: Page) =>
    p.evaluate(() =>
        Promise.all(
            [...document.querySelectorAll('[data-node-id]')]
                .flatMap((item) => item.getAnimations())
                .map((animation) => animation.finished.catch(() => {})),
        ),
    );

async function reset(p: Page) {
    await p.keyboard.press('Escape');
    await p.evaluate(() => window.scrollTo(0, 0));
    await scrollToRow(p, 0);
    await expect(row(p, 0)).toBeInViewport();
    await expect(p.locator('[data-node-id][aria-selected=true]')).toHaveCount(0);
}

// The tests share one folder and change it (drags, the Trash, arrivals), so a retry must start
// the whole file again from a fresh folder rather than rerun one test on a changed one.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    await newFolder(page);
    await page.getByPlaceholder('Reports/2026').fill('Long');
    await page.keyboard.press('Enter');
    await openFolder(page, 'Long');
    // An empty folder has no table yet: its first file draws one, then the rest arrive.
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({ name: name(0), mimeType: 'text/plain', buffer: Buffer.from('0\n') });
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '2', { timeout: 60_000 });
    await upload(
        page,
        Array.from({ length: COUNT - 1 }, (_, index) => name(index + 1)),
    );
});
test.afterAll(async () => {
    await page.close();
});

test('only the rows near the screen are drawn, and each says where it sits in the whole list', async () => {
    await reset(page);
    expect(await rows(page).count()).toBeLessThan(60);
    await scrollToRow(page, 200);
    await expect(row(page, 200)).toBeVisible();
    // The header row is the first; row-200 is the 201st item.
    await expect(page.locator('thead tr')).toHaveAttribute('aria-rowindex', '1');
    await expect(row(page, 200)).toHaveAttribute('aria-rowindex', '202');
    await expect(row(page, 201)).toHaveAttribute('aria-rowindex', '203');
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(COUNT + 1));
    await expect(row(page, 0)).toHaveCount(0);
});

test('the arrows move past the drawn rows, and the row with the keys stays drawn and comes back', async () => {
    await reset(page);
    await row(page, 0).click(grip);
    await nameOf(page, 0).focus();
    for (let step = 0; step < 40; step++) await page.keyboard.press('ArrowDown');
    await expect(row(page, 40)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 40)).toBeInViewport();
    await expect(nameOf(page, 40)).toBeFocused();
    // The first row has been let go of as the list moved on.
    await expect(row(page, 0)).toHaveCount(0);

    // Scrolled far away, the row with the keys is kept: the keys stay on it.
    await scrollToRow(page, 250);
    await expect(row(page, 250)).toBeVisible();
    await expect(nameOf(page, 40)).toBeFocused();
    // And the next arrow brings the list back to the row after it.
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 41)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 41)).toBeInViewport();
    await expect(nameOf(page, 41)).toBeFocused();
});

test('a Shift-click range spans rows that were never drawn together', async () => {
    await reset(page);
    await row(page, 2).click(grip);
    await expect(selection(page)).toContainText('1 selected');
    await scrollToRow(page, 245);
    await expect(row(page, 250)).toBeVisible();
    // The rows between were never drawn with these two (row-002 stays drawn: it has the keys).
    await expect(row(page, 120)).toHaveCount(0);
    await row(page, 250).click({ ...grip, modifiers: ['Shift'] });
    await expect(selection(page)).toContainText('249 selected');
    await expect(row(page, 250)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 249)).toHaveAttribute('aria-selected', 'true');
});

test('a right-click on a row deep in the list selects it and its menu acts on it', async () => {
    await reset(page);
    await scrollToRow(page, 178);
    await expect(row(page, 180)).toBeVisible();
    await rightClick(row(page, 180), { position: { x: 600, y: 28 } });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Preview/ })).toBeVisible();
    await expect(row(page, 180)).toHaveAttribute('aria-selected', 'true');
    await expect(selection(page)).toContainText('1 selected');
    await menu.getByRole('menuitem', { name: /^Rename/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toHaveValue(name(180));
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // The menu closes behind the dialog, and the dialog hands the keys back to its Rename item
    // until it has: an Escape in that moment (the next test's) is the closing menu's, not the
    // list's, and leaves the row selected.
    await expect(page.locator('[role=menu]')).toHaveCount(0);
});

test('the ⋯ menu of a row deep in the list acts on that row and gives the keys back', async () => {
    await reset(page);
    await scrollToRow(page, 218);
    await expect(row(page, 220)).toBeVisible();
    const more = page.getByRole('button', { name: `More for ${name(220)}`, exact: true });
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Preview/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await more.click();
    await menu.getByRole('menuitem', { name: /^Rename/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toHaveValue(name(220));
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('the keys stay on a row the selection let go of while the list scrolls on', async () => {
    await reset(page);
    // Tab's way in: the keys on a row's name, the arrows on from there.
    await nameOf(page, 5).focus();
    await page.keyboard.press('ArrowDown');
    await expect(nameOf(page, 6)).toBeFocused();
    // Escape lets go of the selection, not of the keys.
    await page.keyboard.press('Escape');
    await expect(selection(page)).toHaveCount(0);
    // Page Down until the first row on screen is past the rows drawn around row-006, whatever
    // the window's height (each press's scroll is animated: wait for it to come to rest).
    for (let press = 0; press < 30 && (await firstOnScreen(page)) <= 6 + 2 * OVERSCAN; press++) {
        await page.keyboard.press('PageDown');
        await settledScroll(page);
    }
    expect(await firstOnScreen(page)).toBeGreaterThan(6 + 2 * OVERSCAN);
    await expect(row(page, 6)).toHaveCount(1);
    await expect(row(page, 6)).not.toBeInViewport();
    await expect(nameOf(page, 6)).toBeFocused();
    // And further, by hand.
    await scrollToRow(page, 150);
    await expect(row(page, 150)).toBeVisible();
    await expect(nameOf(page, 6)).toBeFocused();

    // The same for the ⋯ button, which the selection never knows about.
    await reset(page);
    const more = page.getByRole('button', { name: `More for ${name(3)}`, exact: true });
    await more.focus();
    await scrollToRow(page, 180);
    await expect(row(page, 180)).toBeVisible();
    await expect(more).toBeFocused();
});

test('the grid draws only the tiles near the screen, each placed in the whole list', async () => {
    await reset(page);
    await page.getByRole('button', { name: 'Show as grid' }).click();
    try {
        const grid = page.getByRole('list', { name: 'Contents of Long' });
        await expect(grid).toBeVisible();
        await expect(rows(page).first()).toHaveAttribute('aria-setsize', String(COUNT));
        expect(await rows(page).count()).toBeLessThan(120);
        await page.evaluate(() => {
            const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
            sheet.scrollTop = sheet.scrollHeight / 2;
        });
        await expect(row(page, 0)).toHaveCount(0);
        // Every tile on screen is the item its position says: row-150 is item 151 of 300.
        await expect.poll(() => onScreen(page)).toBeGreaterThan(0);
        const placed = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[data-node-id]')].map((tile) => [
                tile.querySelector('[data-row-name]')?.getAttribute('aria-label'),
                tile.getAttribute('aria-posinset'),
            ]),
        );
        for (const [label, position] of placed)
            expect(Number(position)).toBe(Number(label!.slice(4)) + 1);
        expect(await duplicates(page)).toBe(0);
        // And where CSS's own columns put it: a tile sits on line (its index / columns), so a
        // list that counted columns differently from the grid would place tiles off their lines.
        const layout = await page.evaluate(() => {
            const grid = document.querySelector<HTMLElement>('ul[aria-label="Contents of Long"]')!;
            const style = getComputedStyle(grid);
            const columns = style.gridTemplateColumns.split(' ').length;
            const gap = parseFloat(style.rowGap);
            const top = grid.getBoundingClientRect().top + parseFloat(style.paddingTop);
            const tiles = [...grid.querySelectorAll<HTMLElement>('[data-node-id]')];
            const height = tiles[0]!.getBoundingClientRect().height;
            return {
                columns,
                lefts: new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().left)))
                    .size,
                off: tiles.filter((tile) => {
                    const line = Math.floor(
                        (Number(tile.getAttribute('aria-posinset')) - 1) / columns,
                    );
                    // A few pixels of rounding over many lines; a wrong count is whole lines out.
                    return (
                        Math.abs(tile.getBoundingClientRect().top - top - line * (height + gap)) >
                        (height + gap) / 4
                    );
                }).length,
            };
        });
        expect(layout.columns).toBeGreaterThan(2);
        expect(layout.lefts).toBe(layout.columns);
        expect(layout.off).toBe(0);
    } finally {
        await page.getByRole('button', { name: 'Show as list' }).click();
    }
});

test('when Info narrows the grid, the tiles at the top of the screen stay there', async () => {
    await reset(page);
    await page.getByRole('button', { name: 'Show as grid' }).click();
    try {
        await expect(rows(page).first()).toBeVisible();
        await page.evaluate(() => {
            const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
            sheet.scrollTop = sheet.scrollHeight / 2;
        });
        await settledScroll(page);
        // The first tile wholly on screen, selected.
        const picked = await page.evaluate(() => {
            const box = document
                .querySelector('[data-scroll-restoration-id="app-sheet"]')!
                .getBoundingClientRect();
            return [...document.querySelectorAll<HTMLElement>('[data-node-id]')]
                .find((tile) => tile.getBoundingClientRect().top >= box.top)!
                .querySelector('[data-row-name]')!
                .getAttribute('aria-label')!;
        });
        const tile = row(page, Number(picked.slice(4)));
        await tile.locator('[data-row-name]').click();
        await expect(tile).toHaveAttribute('data-selected', 'true');
        const columns = () =>
            page.evaluate(
                () =>
                    getComputedStyle(
                        document.querySelector('ul[aria-label="Contents of Long"]')!,
                    ).gridTemplateColumns.split(' ').length,
            );
        const wide = await columns();
        await page.keyboard.press('i');
        await expect.poll(columns).toBeLessThan(wide);
        await settledScroll(page);
        await expect(tile).toBeInViewport();
        await page.keyboard.press('i');
        await expect.poll(columns).toBe(wide);
        await settledScroll(page);
        await expect(tile).toBeInViewport();
    } finally {
        await page.getByRole('button', { name: 'Show as list' }).click();
    }
});

test('when the window narrows deep in the grid, the tile at the top of the screen stays there', async () => {
    await reset(page);
    const size = page.viewportSize()!;
    await page.getByRole('button', { name: 'Show as grid' }).click();
    try {
        await expect(rows(page).first()).toBeVisible();
        await page.evaluate(() => {
            const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
            sheet.scrollTop = sheet.scrollHeight / 2;
        });
        await settledScroll(page);
        await settledItems(page);
        // The first tile wholly on screen, scrolled to the very top of it.
        const picked = await page.evaluate(() => {
            const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
            const box = sheet.getBoundingClientRect();
            const tile = [...document.querySelectorAll<HTMLElement>('[data-node-id]')].find(
                (item) => item.getBoundingClientRect().top >= box.top,
            )!;
            sheet.scrollTop += tile.getBoundingClientRect().top - box.top;
            return tile.querySelector('[data-row-name]')!.getAttribute('aria-label')!;
        });
        await settledScroll(page);
        await settledItems(page);
        const tile = row(page, Number(picked.slice(4)));
        const top = () =>
            tile.evaluate(
                (item) =>
                    item.getBoundingClientRect().top -
                    document
                        .querySelector('[data-scroll-restoration-id="app-sheet"]')!
                        .getBoundingClientRect().top,
            );
        const columns = () =>
            page.evaluate(
                () =>
                    getComputedStyle(
                        document.querySelector('ul[aria-label="Contents of Long"]')!,
                    ).gridTemplateColumns.split(' ').length,
            );
        const was = await top();
        const wide = await columns();
        // Within a quarter of a tile: the page's header above the list changes height with the
        // window too, which Chrome's own scroll anchoring makes up for and WebKit's does not.
        // A list that lost its place would be a line of tiles or more out.
        const near = (await tile.evaluate((item) => item.getBoundingClientRect().height)) / 4;
        // The grid takes fewer columns as the window narrows, with no change of its own to
        // see it coming; the tile stays where it was, and again as the window widens.
        await page.setViewportSize({ width: 900, height: size.height });
        await expect.poll(columns).toBeLessThan(wide);
        await settledScroll(page);
        await settledItems(page);
        expect(Math.abs((await top()) - was)).toBeLessThan(near);
        await page.setViewportSize(size);
        await expect.poll(columns).toBe(wide);
        await settledScroll(page);
        await settledItems(page);
        expect(Math.abs((await top()) - was)).toBeLessThan(near);
    } finally {
        await page.setViewportSize(size);
        await page.getByRole('button', { name: 'Show as list' }).click();
    }
});

test('across the width where the window takes over the scroll, the rows on screen stay on screen', async () => {
    await reset(page);
    const size = page.viewportSize()!;
    await scrollToRow(page, 120);
    await settledScroll(page);
    await settledItems(page);
    // A row a little way down the screen, and where it is on screen.
    const picked = await page.evaluate(() => {
        const box = document
            .querySelector('[data-scroll-restoration-id="app-sheet"]')!
            .getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>('tbody [data-node-id]')]
            .find((item) => item.getBoundingClientRect().top >= box.top + 100)!
            .querySelector('[data-row-name]')!.textContent!;
    });
    const held = row(page, Number(picked.slice(4)));
    const top = () => held.evaluate((item) => item.getBoundingClientRect().top);
    const height = await held.evaluate((item) => item.getBoundingClientRect().height);
    const was = await top();
    try {
        // Below md the window scrolls rather than the app's sheet, and starts at its own top.
        await page.setViewportSize({ width: 700, height: size.height });
        await expect(held).toBeInViewport();
        await settledItems(page);
        expect(Math.abs((await top()) - was)).toBeLessThan(height);
        await page.setViewportSize(size);
        await expect(held).toBeInViewport();
        await settledItems(page);
        expect(Math.abs((await top()) - was)).toBeLessThan(height);
    } finally {
        await page.setViewportSize(size);
    }
});

test('at a phone’s width the window scrolls and the rows drawn follow it', async () => {
    await reset(page);
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    try {
        await expect(row(page, 0)).toBeVisible();
        await page.evaluate(() => {
            const height = document.querySelector('[data-node-id]')!.getBoundingClientRect().height;
            const top = document.querySelector('tbody')!.getBoundingClientRect().top + scrollY;
            window.scrollTo(0, top + height * 200);
        });
        await expect(row(page, 200)).toBeInViewport();
        await expect(row(page, 200)).toHaveAttribute('aria-rowindex', '202');
        expect(await rows(page).count()).toBeLessThan(60);
        await expect(row(page, 0)).toHaveCount(0);
    } finally {
        await page.setViewportSize(size);
    }
});

test('a row dragged up past the drawn rows into a folder is drawn once, and leaves', async () => {
    await reset(page);
    // The folder it goes into, at the top of the list (folders come first).
    await makeFolder(page, 'box');
    const box = rows(page).filter({
        has: page.locator('[data-row-name]').getByText('box', { exact: true }),
    });
    await expect(box).toBeVisible();
    const before = await rowCount(page);
    await scrollToRow(page, 198);
    const source = row(page, 200);
    await expect(source).toBeVisible();
    const id = (await source.getAttribute('data-node-id'))!;
    await source.hover({ position: { x: 600, y: 28 } });
    await page.mouse.down();
    await page.mouse.move(700, 400, { steps: 4 });
    const card = page.locator('[data-drag-card]');
    await expect(card).toContainText(name(200));
    // The list scrolls up under the drag to its top, far past the rows drawn around the one
    // picked up.
    await scrollToRow(page, 0);
    await expect(box).toBeVisible();
    expect(await duplicates(page)).toBe(0);
    expect(await page.locator(`[data-node-id="${id}"]`).count()).toBe(1);
    const target = (await box.boundingBox())!;
    const x = target.x + 300;
    const y = target.y + target.height / 2;
    await page.mouse.move(x, y, { steps: 4 });
    let nudge = 0;
    await expect(async () => {
        nudge = 1 - nudge;
        await page.mouse.move(x + nudge, y);
        await expect(card.getByText('Move to “box”')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.mouse.up();
    await expect(page.getByText(`“${name(200)}” moved to “box”`)).toBeVisible();
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before - 1));
    await expect(page.locator(`[data-node-id="${id}"]`)).toHaveCount(0);
    expect(await duplicates(page)).toBe(0);
});

test('a range that was never drawn together goes to the Trash whole', async () => {
    await reset(page);
    const before = await rowCount(page);
    await row(page, 2).click(grip);
    await scrollToRow(page, 245);
    await expect(row(page, 250)).toBeVisible();
    await row(page, 250).click({ ...grip, modifiers: ['Shift'] });
    const label = (await selection(page).innerText()).match(/(\d+) selected/)!;
    const picked = Number(label[1]);
    // From row-002 to row-250, less the row the drag moved away.
    expect(picked).toBe(249 - 1);
    await page.keyboard.press('Delete');
    await expect(page.getByText(`${picked} items moved to Trash`)).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before - picked));
    await scrollToRow(page, 0);
    await expect(row(page, 1)).toBeVisible();
    await expect(row(page, 2)).toHaveCount(0);
    await expect(row(page, 120)).toHaveCount(0);
    // box, row-000, row-001, then row-251.
    await expect(rows(page).nth(3)).toContainText(name(251));
    expect(await duplicates(page)).toBe(0);
});

test('rows that arrive above the screen leave the rows on it where they were', async () => {
    await reset(page);
    const before = await rowCount(page);
    // Deep enough that the list's top, and the rows about to arrive there, are well off screen.
    await scrollToRow(page, before - 1 - 20);
    await settledScroll(page);
    expect(await firstOnScreen(page)).toBeGreaterThan(2 * OVERSCAN);
    const still = await under(page);
    expect(still).not.toBeNull();
    // Three folders that sort above everything on screen, made in another tab: this one hears
    // of them when it next polls for changes, as with any sync.
    const other = await otherTab(page);
    for (const folder of ['aa-0', 'aa-1', 'aa-2']) await makeFolder(other, folder);
    await other.close();
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before + 3), {
        timeout: 90_000,
    });
    await settledScroll(page);
    const after = await under(page);
    expect(after?.name).toBe(still!.name);
    // Scroll offsets snap to whole device pixels.
    expect(Math.abs(after!.top - still!.top)).toBeLessThanOrEqual(1);
    expect(await duplicates(page)).toBe(0);
});

test('rows that leave above the screen at the foot of the list leave the last rows on it', async () => {
    await reset(page);
    const before = await rowCount(page);
    await page.evaluate(() => {
        const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
        sheet.scrollTop = sheet.scrollHeight;
    });
    await settledScroll(page);
    const last = page.locator(`tbody [aria-rowindex="${before}"]`);
    await expect(last).toBeInViewport();
    const name = await last.locator('[data-row-name]').innerText();
    const still = await under(page);
    expect(still).not.toBeNull();
    // Three rows at the top of the list leave by sync: the browser pulls the scroll in by as
    // much, as the list got shorter, and the list must not pull it in again.
    const other = await otherTab(page);
    await trashRange(other, 'aa-0', 'aa-2', 'top');
    await other.close();
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before - 3), {
        timeout: 90_000,
    });
    await settledScroll(page);
    await expect(row(page, Number(name.slice(4)))).toBeInViewport();
    const after = await under(page);
    expect(after?.name).toBe(still!.name);
    expect(Math.abs(after!.top - still!.top)).toBeLessThanOrEqual(1);
    expect(await duplicates(page)).toBe(0);
});

test('as many rows arriving above the screen as leave below it, in one sync, leave the rows on it in place', async () => {
    await reset(page);
    const before = await rowCount(page);
    // Three rows at the foot of the list, to leave below the screen.
    const other = await otherTab(page);
    await upload(other, ['zz-0', 'zz-1', 'zz-2']);
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before + 3), {
        timeout: 90_000,
    });
    // The middle of the list: the top, where three arrive, and the foot, where three leave,
    // both well off screen.
    await scrollToRow(page, Math.floor((before + 3 - 1) / 2) - 5);
    await settledScroll(page);
    expect(await firstOnScreen(page)).toBeGreaterThan(2 * OVERSCAN);
    const still = await under(page);
    expect(still).not.toBeNull();
    const held = page.locator('tbody [data-node-id]').filter({
        has: page.locator('[data-row-name]').getByText(still!.name!, { exact: true }),
    });
    const index = Number(await held.getAttribute('aria-rowindex'));
    // Both in one sync: this tab's change polling waits while it is hidden, so while the other
    // tab makes three folders and moves three files to the Trash, this one is made to say it is
    // hidden, and its next poll brings both at once.
    await page.evaluate(() =>
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        }),
    );
    try {
        // A poll already on its way lands before anything changes.
        await page.waitForTimeout(1_500);
        for (const folder of ['aa-3', 'aa-4', 'aa-5']) await makeFolder(other, folder);
        await trashRange(other, 'zz-0', 'zz-2', 'foot');
    } finally {
        await page.evaluate(
            () => delete (document as { visibilityState?: unknown }).visibilityState,
        );
        await other.close();
    }
    // The count is the same; the row that was under the point is three further down the list.
    await expect(held).toHaveAttribute('aria-rowindex', String(index + 3), { timeout: 90_000 });
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(before + 3));
    await settledScroll(page);
    const after = await under(page);
    expect(after?.name).toBe(still!.name);
    expect(Math.abs(after!.top - still!.top)).toBeLessThanOrEqual(1);
    expect(await duplicates(page)).toBe(0);
});

test('when every row drawn leaves at once, the first row after them takes the place of the first one on screen', async () => {
    await reset(page);
    const before = await rowCount(page);
    await scrollToRow(page, 2 * OVERSCAN);
    await settledScroll(page);
    const shown = await firstOnScreen(page);
    // Every row drawn around the screen, on it and past each edge, leaves by sync: none of
    // them is left to hold the place, and the rows after them must not be skipped. (A row
    // kept drawn elsewhere, the one with the keys, is not part of the run.)
    const drawn = await page.evaluate((shown) => {
        const all = [...document.querySelectorAll<HTMLElement>('tbody [data-node-id]')].map(
            (item) =>
                [
                    Number(item.getAttribute('aria-rowindex')) - 2,
                    item.querySelector('[data-row-name]')!.textContent!,
                ] as [number, string],
        );
        const at = all.findIndex(([index]) => index === shown);
        let start = at;
        let end = at;
        while (start > 0 && all[start - 1]![0] === all[start]![0] - 1) start--;
        while (end + 1 < all.length && all[end + 1]![0] === all[end]![0] + 1) end++;
        return all.slice(start, end + 1);
    }, shown);
    const [first, firstName] = drawn[0]!;
    const [last, lastName] = drawn.at(-1)!;
    expect(first).toBeLessThan(shown);
    expect(last).toBeGreaterThan(shown);
    const other = await otherTab(page);
    const named = (label: string) =>
        other
            .locator('[data-node-id]')
            .filter({ has: other.locator('[data-row-name]').getByText(label, { exact: true }) });
    await scrollToRow(other, first);
    await named(firstName).click(grip);
    await scrollToRow(other, last - 4);
    await named(lastName).click({ ...grip, modifiers: ['Shift'] });
    await other.keyboard.press('Delete');
    await expect(other.getByText(/moved to Trash/).first()).toBeVisible({ timeout: 60_000 });
    await other.close();
    await expect(page.locator('table')).toHaveAttribute(
        'aria-rowcount',
        String(before - drawn.length),
        { timeout: 90_000 },
    );
    await settledScroll(page);
    // The first row after the ones that left now sits where they began, and is first on screen.
    expect(await firstOnScreen(page)).toBe(first);
    expect(await duplicates(page)).toBe(0);
});
