import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grip, newPage, paintedWords, registerAccount } from './helpers';

/*
 * The code view draws a file in blocks of 256 lines beside a gutter drawn the
 * same way. A block that ends on a blank line once drew one line short, and
 * every line number after it pointed at the wrong line. This holds the two
 * columns level across block ends, coloured and plain.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });

/* 1,000 lines, blank at each block end (256, 512, 768) and at 100 and 101. */
function lines() {
    const out: string[] = [];
    for (let n = 1; n <= 1000; n++)
        out.push(n % 256 === 0 || n === 100 || n === 101 ? '' : `const line${n} = "line ${n}";`);
    return `${out.join('\n')}\n`;
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    const dir = mkdtempSync(join(tmpdir(), 'hushos-gutter-'));
    // The same lines with Windows line ends, which the highlighter splits differently.
    const files = ['gutter.ts', 'gutter.txt', 'gutter-crlf.ts'].map((name) => {
        const path = join(dir, name);
        writeFileSync(path, name.includes('crlf') ? lines().replaceAll('\n', '\r\n') : lines());
        return path;
    });
    // Past the colouring threshold (512 KB): offered Colour anyway. Dense code, about 228,000
    // tokens coloured: drawn as an element each, every later render of the page took over a
    // second on WebKit (an upload behind the viewer took minutes), so colour is painted over the
    // text near the view instead, and this file holds the page to that.
    const big = join(dir, 'big.ts');
    writeFileSync(
        big,
        Array.from(
            { length: 12_000 },
            (_, n) => `export const value${n}: number = ${n} * 2; // line ${n}`,
        ).join('\n'),
    );
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([...files, big]);
    await expect(page.locator('[data-node-id]')).toHaveCount(4, { timeout: 90_000 });
});
test.afterAll(async () => {
    await page.close();
});

/* The top of line n's first character, in the code and in the gutter. */
function tops(targets: number[]) {
    return page.evaluate((wanted) => {
        // Blocks off screen are sized from an estimate; measure them drawn.
        const style = document.createElement('style');
        style.textContent = '.rt-block{content-visibility:visible!important}';
        document.head.append(style);
        const top = (blocks: Element[], n: number) => {
            const block = blocks[Math.floor((n - 1) / 256)];
            if (!block) return null;
            const target = (n - 1) % 256;
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let line = 0;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.textContent ?? '';
                for (let i = 0; i < text.length; i++) {
                    if (line === target) {
                        const range = document.createRange();
                        range.setStart(node, i);
                        range.setEnd(node, i + 1);
                        return range.getBoundingClientRect().top;
                    }
                    if (text[i] === '\n') line++;
                }
            }
            return null;
        };
        const code = [
            ...document.querySelectorAll('[data-slot=dialog-content] .rt-source .rt-block'),
        ];
        const gutter = [
            ...document.querySelectorAll('[data-slot=dialog-content] .rt-gutter .rt-block'),
        ];
        const result = wanted.map((n) => ({ n, code: top(code, n), gutter: top(gutter, n) }));
        style.remove();
        return result;
    }, targets);
}

for (const name of ['gutter.ts', 'gutter.txt', 'gutter-crlf.ts']) {
    test(`line numbers stay level with their lines across blank block ends (${name})`, async () => {
        await row(page, name).locator('button').first().dblclick(grip);
        await expect(dialog(page)).toContainText(name);
        await expect(dialog(page).locator('.rt-source .rt-block').first()).toBeVisible({
            timeout: 60_000,
        });
        // The coloured file is checked once its colours are in, on the right words, the plain one as it is.
        if (name.endsWith('.ts')) {
            await expect(dialog(page).locator('.rt-code[data-coloured]')).toHaveCount(1);
            await expect
                .poll(async () => (await paintedWords(page)).slice(0, 2))
                .toEqual(['const', 'line1']);
            // Every line of the first run of lines is coloured, not just the first.
            const run = await dialog(page).locator('.rt-source [data-run="0"]').textContent();
            const names = (await paintedWords(page)).filter((word) => /^line\d+$/.test(word));
            expect(names).toEqual(run!.match(/\bline\d+(?= =)/g));
        }
        const measured = await tops([1, 99, 102, 255, 257, 511, 513, 767, 769, 1000]);
        for (const { n, code, gutter } of measured) {
            expect(code, `line ${n} in the code`).not.toBeNull();
            expect(gutter, `line ${n} in the gutter`).not.toBeNull();
            // The two faces sit a pixel apart on the same line; a whole line is 19px.
            expect(Math.abs(code! - gutter!), `line ${n}`).toBeLessThanOrEqual(2);
        }
        await page.keyboard.press('Escape');
        await expect(dialog(page)).toHaveCount(0);
    });
}

test('Colour anyway holds when the folder is listed again behind the viewer', async () => {
    // In My files, whose listing is what a change to the folder fetches again.
    await page.goto('/app/drive');
    await row(page, 'big.ts').locator('button').first().dblclick(grip);
    const colour = dialog(page).getByRole('button', { name: 'Colour anyway' });
    await colour.click({ timeout: 60_000 });
    await expect(dialog(page).locator('output', { hasText: 'Coloured.' })).toHaveCount(1, {
        timeout: 120_000,
    });
    // A file added to the folder while the viewer is open lists the folder again, which hands
    // the viewer a new copy of the open file. That copy once reopened the file and drew it
    // uncoloured. Added in this tab, through the folder's own picker behind the viewer: a second
    // tab and a hidden-then-shown window depend on how each engine reports visibility (WebKit
    // never refetched that way on CI), while an upload lists the folder again on any engine.
    const dir = mkdtempSync(join(tmpdir(), 'hushos-other-'));
    writeFileSync(join(dir, 'other.txt'), 'another file\n');
    await page.locator('input[type=file]').first().setInputFiles(join(dir, 'other.txt'));
    // Listed again: the new file is in the list behind the viewer.
    await expect(row(page, 'other.txt')).toBeAttached({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await expect(colour).toHaveCount(0);
    await expect(dialog(page).locator('.rt-code[data-coloured]')).toHaveCount(1);
    await expect.poll(async () => (await paintedWords(page))[0]).toMatch(/^export const\b/);
    await page.keyboard.press('Escape');
});
