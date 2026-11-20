import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { grip, newContext, registerAccount } from './helpers';

/*
 * What the editing specs share (editing-files, editing-preview, editing-conflicts and
 * editing-access): the steps a person takes in the editor, and the files they edit. Each spec
 * makes its own account and uploads only the files its tests use, so the four run on workers
 * of their own and CI's shards can balance them; one serial file of them all was the longest
 * file of the suite.
 */

export const dialog = (p: Page) => p.locator('[data-slot=dialog-content]').first();
export const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
export const editor = (p: Page) => p.getByRole('textbox', { name: /^Contents of / });

const files = mkdtempSync(join(tmpdir(), 'hushos-editing-'));
export const write = (name: string, bytes: string | Uint8Array) => {
    const path = join(files, name);
    writeFileSync(path, bytes);
    return path;
};

export async function openEditor(p: Page, name: string) {
    await row(p, name).getByRole('link', { name, exact: true }).click();
    await dialog(p).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(p)).toBeVisible({ timeout: 60_000 });
}

/* Replaces the whole text, as a person selecting everything and typing would. */
export async function retype(p: Page, text: string) {
    await editor(p).click();
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.insertText(text);
    // Taken in by the editor (its document, not only the page), before the test goes on.
    await expect(editor(p)).toContainText(text);
}

/* Holds every folder listing back for `ms` while armed: a slow server between a click and its answer. */
export async function slowListings(p: Page, ms: number) {
    await p.route('**/nodes/*/children*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue().catch(() => {});
    });
    return () => p.unroute('**/nodes/*/children*');
}

/* How many earlier versions a file has, from its Versions dialog. */
export async function earlierVersions(p: Page, name: string) {
    await row(p, name)
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await p.getByRole('menuitem', { name: 'Versions' }).click();
    await expect(dialog(p)).toContainText(`Versions of “${name}”`);
    // Counted once the list has come.
    await expect(dialog(p).getByText('Current version', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    const count = await dialog(p).getByRole('button', { name: 'Download earlier version' }).count();
    await p.keyboard.press('Escape');
    await expect(p.locator('[data-slot=dialog-content]')).toHaveCount(0);
    return count;
}

export async function close(p: Page) {
    await dialog(p).getByRole('button', { name: 'Close preview' }).click();
    await expect(p.locator('[data-slot=dialog-content]')).toHaveCount(0);
}

/* UTF-16 little endian with its byte order mark. */
export const utf16le = (text: string) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/* The file's current bytes, as Download gives them. */
export async function downloaded(p: Page, name: string) {
    await row(p, name).locator('button').first().click(grip);
    const [download] = await Promise.all([
        p.waitForEvent('download'),
        p.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    return readFileSync((await download.path())!);
}

/*
 * A long Markdown file for scrolling: parts of different lengths (a long paragraph wraps over many
 * lines in the preview but is one line in the source), then 400 blank lines with nothing to render,
 * so the source can be scrolled well past the preview's end.
 */
const scrollText = () => {
    let text = '# Scrolling\n\n';
    // Under the 16K characters the preview follows as it is typed.
    for (let part = 1; part <= 60; part++)
        text += `## Part ${part}\n\n${'Words go here. '.repeat(3 + (part % 5) * 6)}\n\n`;
    return `${text}${'\n'.repeat(400)}`;
};

/*
 * Every file the editing specs edit, by name. Two name addresses on the app's own origin (so no
 * policy would stop a fetch), which a test counts requests for: the Markdown file's image and
 * link (`editing-preview-probe`), and the diagram's links (`editing-diagram-probe`).
 */
const FIXTURES: Record<string, (origin: string) => string | Uint8Array> = {
    'notes.txt': () => 'Grüße\nline two\nno final newline',
    // CRLF with no final newline.
    'windows.txt': () => 'first\r\nsecond',
    'utf16.txt': () => utf16le('Grüße\r\nzwei\r\n'),
    // Two CRLF to one LF: saved in CRLF once edited.
    'mixed.txt': () => 'a\r\nb\r\nc\n',
    // Old Mac line endings: a lone CR.
    'classic.txt': () => 'one\rtwo\r',
    'preview.md': (origin) => {
        const probe = `${origin}/editing-preview-probe.png`;
        return `# Notes\n\nAn image: ![tracking pixel](${probe})\n\n[A link](${probe}?link)\n`;
    },
    'marked.md': () => Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('# Title\n')]),
    // Past the 16K characters the preview follows as it is typed.
    'long.md': () => `# Long notes\n\n${'A paragraph of text that repeats.\n\n'.repeat(1200)}`,
    'latin.txt': () => Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    'config.json': () => '{\n  "a": 1\n}\n',
    // No extension and no type: the viewer reads it to find it is text.
    README: () => 'Read me first\n',
    // One of each language and parser the preload brings, for its test.
    'settings.yaml': () => 'name: hushos\nitems:\n  - a\n',
    'main.rs': () => 'fn main() {\n    println!("hi");\n}\n',
    'Cargo.toml': () => '[package]\nname = "hushos"\n',
    'scroll.md': () => scrollText(),
    // A flowchart whose node links to the app's own origin, and a type outside the twelve pele
    // is fetched with.
    'diagram.md': (origin) => {
        const probe = `${origin}/editing-diagram-probe`;
        return `# Diagram\n\n\`\`\`mermaid\nflowchart LR\n  A[Start] --> B{Choice}\n  click A href "${probe}"\n  click B "${probe}?b"\n\`\`\`\n\n\`\`\`mermaid\nsankey-beta\nA,B,1\n\`\`\`\n`;
    },
};

/*
 * A new person, signed up through the real flow, with `names` from the fixtures above uploaded
 * into their Drive root as a person would; the page is left on that folder with every row drawn.
 * `before` runs on the new page before anything loads (a route that must see the first request).
 */
export async function editingAccount(
    browser: Browser,
    names: string[],
    options: { person?: string; before?: (page: Page) => Promise<unknown> } = {},
) {
    const page = await (await newContext(browser)).newPage();
    await options.before?.(page);
    const { email } = await registerAccount(page, options.person ?? 'Maya Lindqvist');
    const origin = new URL(page.url()).origin;
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles(names.map((name) => write(name, FIXTURES[name]!(origin))));
    await expect(page.locator('[data-node-id]')).toHaveCount(names.length, { timeout: 90_000 });
    return { page, email };
}
