import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { close, dialog, editingAccount, editor, downloaded, openEditor, row } from './editing';
import { appModule, scriptsDuring } from './helpers';

/*
 * Editing on the web, the Markdown side and what the editor loads: the editor's code comes whole
 * with the first Edit and nothing after, a Mermaid fence is drawn as an image, Markdown shows the
 * viewer's rendering beside the source, live, scrolling with it and fetching nothing it names,
 * and a preview that can't load says so while the text still saves. The other editing specs:
 * editing-files (open, save, encodings, leaving), editing-conflicts (someone else saved first,
 * the lock) and editing-access (who may edit, signing out).
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
/* Requests for the Markdown file's image, on the app's own origin (so no policy would stop a fetch). */
let probes = 0;
/* The files beforeAll uploads. */
const NAMES = [
    'config.json',
    'settings.yaml',
    'main.rs',
    'Cargo.toml',
    'preview.md',
    'marked.md',
    'long.md',
    'scroll.md',
    'diagram.md',
];
const FILES = NAMES.length;

/* The Rust grammar's fetch: Shiki's package in development, its own chunk in a production build. */
const RUST_GRAMMAR = /shikijs[_/]langs|\/assets\/rust-[\w-]+\.js(\?|$)/;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ({ page } = await editingAccount(browser, NAMES));
    page.on('request', (request) => {
        if (request.url().includes('editing-preview-probe')) probes++;
    });
});
test.afterAll(async () => {
    await page.context().close();
});

/* A fresh load of the drive and its post-unlock preload of every viewer, with what it fetched. */
async function freshDrive(p: Page) {
    return scriptsDuring(p, async () => {
        await p.reload();
        await expect(p.locator('html[data-viewers-preloaded="true"]')).toHaveCount(1, {
            timeout: 90_000,
        });
        await expect(p.locator('[data-node-id]')).toHaveCount(FILES, { timeout: 60_000 });
        // The preload's workers (the thumbnailer's) may still be fetching their own imports once
        // its last step returned: what they fetch belongs to the preload too.
        await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });
}

/* Opens `name` in the editor and closes it again, long enough for its colouring and check to start. */
async function editAndClose(p: Page, name: string) {
    await openEditor(p, name);
    await p.waitForTimeout(1_500);
    await close(p);
}

/* The editor's own modules (production chunk names): none of them may come before an Edit. */
const EDITOR_ONLY = ['text-editor', 'editor-preview', 'text-check.worker'].map(appModule);

test('the editor’s code comes whole with the first Edit, the same for every kind of file, and nothing after', async ({
    browserName,
}) => {
    // Before any Edit: the viewers' preload has fetched nothing of the editor's.
    const preloaded = await freshDrive(page);
    for (const module of EDITOR_ONLY)
        expect(
            [...preloaded].filter((url) => module.test(url)),
            String(module),
        ).toEqual([]);
    // The first Edit, of a JSON file, fetches the editor with every grammar, parser and the
    // preview's renderer: the fixed set, whatever the file.
    const first = [...(await scriptsDuring(page, () => editAndClose(page, 'config.json')))].filter(
        (url) => !preloaded.has(url),
    );
    for (const module of EDITOR_ONLY)
        expect(first.filter((url) => module.test(url)).length, String(module)).toBeGreaterThan(0);
    // A later Edit of any other kind fetches nothing the first didn't, so what a device fetches
    // never says which kind was edited.
    const known = new Set([...preloaded, ...first]);
    for (const name of ['settings.yaml', 'main.rs', 'Cargo.toml', 'preview.md']) {
        const fetched = await scriptsDuring(page, () => editAndClose(page, name));
        expect(
            [...fetched].filter((url) => !known.has(url)),
            name,
        ).toEqual([]);
    }
    // On a fresh page, the first Edit of a Markdown file fetches what the JSON file's did. WebKit
    // answers modules it already holds from its memory cache after a reload without a request to
    // see, so there it can only be shown to fetch nothing else.
    const again = await freshDrive(page);
    const markdownFirst = [
        ...(await scriptsDuring(page, () => editAndClose(page, 'preview.md'))),
    ].filter((url) => !again.has(url));
    if (browserName === 'webkit')
        expect(markdownFirst.filter((url) => !first.includes(url))).toEqual([]);
    else expect([...markdownFirst].sort()).toEqual([...first].sort());
});

test('a Mermaid fence is drawn as an image in the viewer and the preview, fetching nothing it names', async ({
    browserName,
}) => {
    const named: string[] = [];
    const listen = (request: Request) => {
        if (request.url().includes('editing-diagram-probe')) named.push(request.url());
    };
    page.on('request', listen);
    // pele and its twelve types came with the viewers' preload, in the diagram worker's one file.
    const preloaded = await freshDrive(page);
    if (browserName !== 'webkit')
        expect([...preloaded].filter((url) => appModule('mermaid.worker').test(url))).toHaveLength(
            1,
        );
    const opened = await scriptsDuring(page, async () => {
        await row(page, 'diagram.md')
            .getByRole('link', { name: 'diagram.md', exact: true })
            .click();
        const diagram = dialog(page).getByRole('img', { name: 'Diagram' });
        await expect(diagram).toBeVisible({ timeout: 30_000 });
    });
    // Opening a file with a diagram fetches no code the preload didn't: nothing per type.
    expect([...opened].filter((url) => !preloaded.has(url))).toEqual([]);
    const diagram = dialog(page).getByRole('img', { name: 'Diagram' });
    // An image from a blob, never the SVG as live elements.
    expect(await diagram.getAttribute('src')).toMatch(/^blob:/);
    await expect(dialog(page).locator('.rt-markdown svg.pele')).toHaveCount(0);
    // A type outside the twelve stays code, with one sentence.
    await expect(dialog(page).getByText('This kind of diagram isn’t drawn here.')).toBeVisible();
    await expect(dialog(page).getByText('sankey-beta')).toBeVisible();
    // Drawn again in the other colours when the theme changes.
    const light = await diagram.getAttribute('src');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => diagram.getAttribute('src')).not.toBe(light);
    await page.emulateMedia({ colorScheme: 'light' });
    // The editor's preview draws it too.
    await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toBeVisible({ timeout: 60_000 });
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('img', { name: 'Diagram' })).toBeVisible({ timeout: 30_000 });
    // Long enough for anything the diagram names to have been fetched, had it been.
    await page.waitForTimeout(1_500);
    page.off('request', listen);
    expect(named).toEqual([]);
    await close(page);
});

test('a fenced block typed in the Markdown preview before the preload finishes fetches no grammar', async ({
    browser,
}) => {
    test.setTimeout(300_000);
    // The preload held at its first step (the PDF viewer), so no grammar has come yet. Held from the
    // first request of a context of its own, so the chunk never arrives before the test lets it:
    // WebKit answers a module it holds from its memory cache after a reload with no request for
    // page.route to see, even one served with no-store (two CI traces), and a hold set up after
    // the chunk once loaded let the preload through to fetch the Rust grammar itself.
    const held: Route[] = [];
    const pdfViewer = appModule('pdf-viewer');
    const { page } = await editingAccount(browser, ['config.json', 'preview.md'], {
        before: (p) =>
            p.route(pdfViewer, (route) => {
                held.push(route);
            }),
    });
    // The requests held so far belong to pages already left; the reload's comes next.
    const earlier = held.length;
    const grammars: string[] = [];
    const listen = (request: Request) => {
        if (RUST_GRAMMAR.test(request.url())) grammars.push(request.url());
    };
    page.on('request', listen);
    await page.reload();
    await expect(page.locator('[data-node-id]')).toHaveCount(2, { timeout: 60_000 });
    // The hold has the reload's request for the viewer: the preload is stopped at its first step.
    await expect.poll(() => held.length).toBeGreaterThan(earlier);
    // Every editor fetches the preview's renderer with its other assets, a JSON file's too: an Edit
    // before the preload never fetches it for Markdown only.
    const previewModule = page.waitForRequest(appModule('editor-preview'));
    await openEditor(page, 'config.json');
    await previewModule;
    await close(page);
    await openEditor(page, 'preview.md');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n```rust\nfn main() {}\n```\n');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByText('fn main() {}')).toBeVisible();
    // Long enough for a highlight to have asked for its grammar.
    await page.waitForTimeout(1_500);
    expect(grammars).toEqual([]);
    await expect(page.locator('html[data-viewers-preloaded="true"]')).toHaveCount(0);
    await expect(preview.locator('[style*="--shiki-light"]')).toHaveCount(0);
    // Once the preload has fetched every grammar, in its own order, the fence is coloured.
    page.off('request', listen);
    await page.unroute(pdfViewer);
    for (const route of held) await route.continue().catch(() => {});
    await expect(page.locator('html[data-viewers-preloaded="true"]')).toHaveCount(1, {
        timeout: 90_000,
    });
    await expect(preview.locator('[style*="--shiki-light"]').first()).toBeVisible({
        timeout: 30_000,
    });
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    await page.context().close();
});

test('Markdown shows the viewer’s rendering beside the source, live, and fetches nothing it names', async () => {
    const seen = probes;
    await openEditor(page, 'preview.md');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    // Side by side on a wide screen, with no switch between them.
    await expect(preview.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Preview', exact: true })).toBeHidden();
    // The image is named, never drawn: no <img> at all, the link an anchor only.
    await expect(preview.getByText('tracking pixel')).toBeVisible();
    await expect(preview.locator('img')).toHaveCount(0);
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n## Added while typing\n');
    await expect(preview.getByRole('heading', { name: 'Added while typing' })).toBeVisible();
    // A narrow screen shows one at a time, Source first.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(preview).toBeHidden();
    await expect(editor(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(preview.getByRole('heading', { name: 'Added while typing' })).toBeVisible();
    await expect(editor(page)).toBeHidden();
    await dialog(page).getByRole('button', { name: 'Source', exact: true }).click();
    await expect(editor(page)).toBeVisible();
    await page.setViewportSize(size);
    // Long enough for anything the page would have fetched to be on its way.
    await page.waitForTimeout(1_500);
    expect(probes - seen).toBe(0);
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
});

test('the preview follows typing as it goes, without waiting for a pause', async () => {
    await openEditor(page, 'preview.md');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n## ');
    const typedHeading = preview.locator('h2').last();
    const word = 'abcdefghijklmnopqrstuvwxyz';
    // A key every 50 ms: never a pause a debounce would wait for.
    let typing = true;
    const typed = (async () => {
        for (const key of word) {
            await page.keyboard.type(key);
            await page.waitForTimeout(50);
        }
        typing = false;
    })();
    const seen = new Set<string>();
    while (typing) seen.add((await typedHeading.textContent().catch(() => null)) ?? '');
    await typed;
    // Many different texts shown while the keys were still coming, each a part of the word.
    const partial = [...seen].filter((text) => text && text.length < word.length);
    expect(partial.length).toBeGreaterThan(5);
    for (const text of partial) expect(word.startsWith(text)).toBe(true);
    await expect(typedHeading).toHaveText(word);
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
});

/* The source's scroller (CodeMirror's) and the preview's, inside the open editor. */
const sourceScroller = (p: Page) => dialog(p).locator('[data-text-editor] .cm-scroller');
const previewScroller = (p: Page) => dialog(p).locator('[data-markdown-preview]');

/* The line number at the top of the source's view, from its gutter. */
const sourceTopLine = (p: Page) =>
    sourceScroller(p).evaluate((scroller) => {
        const top = scroller.getBoundingClientRect().top + 1;
        for (const element of scroller.querySelectorAll('.cm-lineNumbers .cm-gutterElement')) {
            const box = element.getBoundingClientRect();
            if (box.height && box.bottom > top && /^\d+$/.test(element.textContent ?? ''))
                return Number(element.textContent);
        }
        return null;
    });

/*
 * The preview's blocks with their source lines, and where the preview's view begins, in the
 * preview's own coordinates.
 */
const previewLayout = (p: Page) =>
    previewScroller(p).evaluate((scroller) => {
        const base = scroller.getBoundingClientRect().top;
        return {
            blocks: [...scroller.querySelectorAll<HTMLElement>('[data-source-line]')].map(
                (element) => {
                    const box = element.getBoundingClientRect();
                    return {
                        start: Number(element.dataset.sourceLine),
                        end: Number(element.dataset.sourceEnd),
                        top: box.top - base,
                        bottom: box.bottom - base,
                    };
                },
            ),
        };
    });

/*
 * Whether the preview's view begins on the block holding source line `line` (the innermost block
 * starting at or before it), or between that block and the next: false while either is unknown.
 */
async function previewAtLine(p: Page, line: number | null) {
    if (line === null) return false;
    const { blocks } = await previewLayout(p);
    const holding = blocks.filter((block) => block.start <= line).at(-1);
    if (!holding) return false;
    const next = blocks.find((block) => block.start > line);
    return holding.top <= 1 && (next ? next.top : holding.bottom) >= -1;
}

/*
 * Whether the source's top line is that of the preview block at the top of its view, or one before
 * the next block. A block whose top is within 2px of the view's top is on the boundary: the source
 * may show its first line or the blank line before it (the link maps the gap above a block to the
 * line before it, and a pixel either way is the same place), so either side of it counts.
 */
async function sourceAtPreview(p: Page) {
    const line = await sourceTopLine(p);
    const { blocks } = await previewLayout(p);
    const above = blocks.filter((block) => block.top < -2).at(-1);
    const boundary = blocks.find((block) => Math.abs(block.top) <= 2);
    const from = above ?? boundary;
    if (line === null || !from) return false;
    const next = blocks.find((block) => block.top > 2);
    return line >= from.start && line <= (next ? next.start : from.end + 1);
}

/* Sets a scroller's position as a person's scroll would: the page sees an ordinary scroll event. */
const scrollTo = (scroller: ReturnType<Page['locator']>, top: number) =>
    scroller.evaluate((element, value) => {
        element.scrollTop = value;
        // Where it landed, as the person left it.
        return element.scrollTop;
    }, top);

test('the source and the preview scroll together, both ways', async () => {
    await openEditor(page, 'scroll.md');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('heading', { name: 'Part 60' })).toBeAttached();
    const source = sourceScroller(page);
    const shown = previewScroller(page);

    // The source scrolled: the block holding its top line comes to the top of the preview.
    await scrollTo(source, 5_000);
    await expect.poll(async () => previewAtLine(page, await sourceTopLine(page))).toBe(true);
    expect(await shown.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);

    // The preview scrolled with the wheel: the source follows to the block now at its top.
    const previewBefore = await shown.evaluate((element) => element.scrollTop);
    const sourceBefore = await source.evaluate((element) => element.scrollTop);
    const box = (await shown.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1_500);
    // The wheel's scroll has moved the preview and finished (smooth or not): two reads a moment
    // apart agree. Only then is the source compared, never against where both started.
    await expect
        .poll(async () => {
            const before = await shown.evaluate((element) => element.scrollTop);
            await page.waitForTimeout(200);
            const after = await shown.evaluate((element) => element.scrollTop);
            return after === before && after > previewBefore + 500;
        })
        .toBe(true);
    await expect.poll(() => sourceAtPreview(page)).toBe(true);
    expect(await source.evaluate((element) => element.scrollTop)).toBeGreaterThan(
        sourceBefore + 500,
    );

    // Scrolled into the blank lines past the last block, the preview stops at its end. Its own
    // scroll coming back must not move the source (to the line at the preview's end, or anywhere).
    // The source's end first, so CodeMirror has measured it, then back to the middle.
    await scrollTo(source, 1_000_000);
    await page.waitForTimeout(300);
    const end = await source.evaluate((element) => element.scrollHeight - element.clientHeight);
    await scrollTo(source, 3_000);
    await expect
        .poll(() =>
            shown.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
        )
        .toBeGreaterThan(500);
    const kept = await scrollTo(source, end - 1_500);
    await expect
        .poll(() =>
            shown.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
        )
        .toBeLessThan(2);
    await page.waitForTimeout(500);
    expect(await source.evaluate((element) => element.scrollTop)).toBe(kept);
    const lastBlock = Math.max(...(await previewLayout(page)).blocks.map((block) => block.end));
    expect(await sourceTopLine(page)).toBeGreaterThan(lastBlock);

    // Typing keeps the preview near the cursor: a heading typed mid-file appears in its view.
    await scrollTo(source, 3_000);
    await page.waitForTimeout(300);
    await dialog(page).locator('[data-text-editor] .cm-line').nth(8).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('\n\n## Typed in the middle\n\n');
    const typedHeading = preview.getByRole('heading', { name: 'Typed in the middle' });
    await expect(typedHeading).toBeInViewport();

    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
});

test('on a narrow screen, switching between Source and Preview keeps the place', async () => {
    const size = page.viewportSize()!;
    await openEditor(page, 'scroll.md');
    await page.setViewportSize({ width: 390, height: 800 });
    const source = sourceScroller(page);
    await expect(dialog(page).getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await scrollTo(source, 6_000);
    await page.waitForTimeout(300);
    const line = (await sourceTopLine(page))!;
    await dialog(page).getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('heading', { name: 'Part 1', exact: true })).toBeAttached();
    // The block holding that line is at the top of the preview.
    await expect.poll(() => previewAtLine(page, line)).toBe(true);
    // And back: the source shows about the same line at its top.
    await dialog(page).getByRole('button', { name: 'Source', exact: true }).click();
    await expect
        .poll(async () => Math.abs((await sourceTopLine(page))! - line))
        .toBeLessThanOrEqual(2);
    await close(page);
    await page.setViewportSize(size);
});

test('past 16K characters the preview follows typing only on Refresh preview', async () => {
    await openEditor(page, 'long.md');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    const refresh = preview.getByRole('button', { name: 'Refresh preview' });
    await expect(preview.getByRole('heading', { name: 'Long notes' })).toBeVisible();
    // Just opened, it shows the text as it is: nothing to refresh.
    await page.waitForTimeout(1_000);
    await expect(refresh).toHaveCount(0);
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.insertText('## Typed at the top\n\n');
    await expect(refresh).toBeVisible();
    // Long enough for a live render to have come, had there been one.
    await page.waitForTimeout(1_000);
    await expect(preview.getByRole('heading', { name: 'Typed at the top' })).toHaveCount(0);
    await refresh.click();
    await expect(preview.getByRole('heading', { name: 'Typed at the top' })).toBeVisible();
    await expect(refresh).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
});

test('a preview whose renderer can’t load says so, and the text typed beside it still saves', async ({
    browserName,
}) => {
    // WebKit answers an immutable module it already holds from its memory cache after a reload,
    // so page.route never sees the request it is meant to fail. The error boundary is the same
    // React code in every browser; Chromium proves it.
    test.skip(browserName === 'webkit', 'WebKit serves the cached module past page.route');
    // Only the editor's preview module fails to load: the viewer, which renders the same file with
    // the same renderer before Edit is pressed, is untouched, so the failure is met in the editor.
    const editorPreview = appModule('editor-preview');
    await page.route(editorPreview, (route) => route.fulfill({ status: 500, body: '' }));
    await page.reload();
    await expect(page.locator('[data-node-id]')).toHaveCount(FILES, { timeout: 60_000 });
    await openEditor(page, 'preview.md');
    const preview = dialog(page).getByRole('region', { name: 'Preview' });
    await expect(preview.getByText('The preview couldn’t be shown.')).toBeVisible();
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\nTyped beside a failed preview\n');
    await expect(editor(page)).toContainText('Typed beside a failed preview');
    await expect(preview.getByText('The preview couldn’t be shown.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await close(page);
    const saved = (await downloaded(page, 'preview.md')).toString();
    expect(saved.startsWith('# Notes\n')).toBe(true);
    expect(saved).toContain('\nTyped beside a failed preview\n');
    // A fresh page for the tests after: nothing failing.
    await page.unroute(editorPreview);
    await page.reload();
    await expect(page.locator('html[data-viewers-preloaded="true"]')).toHaveCount(1, {
        timeout: 90_000,
    });
});
