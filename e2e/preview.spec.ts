import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grip, newPage, registerAccount } from './helpers';

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
    const files = ['gutter.ts', 'gutter.txt'].map((name) => {
        const path = join(dir, name);
        writeFileSync(path, lines());
        return path;
    });
    // Past the colouring threshold (512 KB): offered Colour anyway.
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
    await expect(page.locator('[data-node-id]')).toHaveCount(3, { timeout: 90_000 });
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

for (const name of ['gutter.ts', 'gutter.txt']) {
    test(`line numbers stay level with their lines across blank block ends (${name})`, async () => {
        await row(page, name).locator('button').first().dblclick(grip);
        await expect(dialog(page)).toContainText(name);
        await expect(dialog(page).locator('.rt-source .rt-block').first()).toBeVisible({
            timeout: 60_000,
        });
        // The coloured file is checked once its colours are in, the plain one as it is.
        if (name.endsWith('.ts'))
            await expect(dialog(page).locator('.rt-source .line').first()).toBeVisible();
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

test('Colour anyway holds when the window comes back, which refreshes the folder', async () => {
    await row(page, 'big.ts').locator('button').first().dblclick(grip);
    const colour = dialog(page).getByRole('button', { name: 'Colour anyway' });
    await colour.click({ timeout: 60_000 });
    await expect(dialog(page).locator('output', { hasText: 'Coloured.' })).toHaveCount(1, {
        timeout: 120_000,
    });
    // The tab hidden and shown again, as switching away and back does: the listing refetches and
    // hands the viewer a new copy of the same file, which once reopened it uncoloured.
    await page.evaluate(() => {
        for (const state of ['hidden', 'visible']) {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => state,
            });
            document.dispatchEvent(new Event('visibilitychange'));
        }
        window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(3_000);
    await expect(colour).toHaveCount(0);
    await expect(dialog(page).locator('.rt-source .line').first()).toBeVisible();
    await page.keyboard.press('Escape');
});
