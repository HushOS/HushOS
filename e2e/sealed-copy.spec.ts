import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { newPage, registerAccount, sampleFiles } from './helpers';

/*
 * A sealed copy is the item as the service holds it: the manifest names every
 * record with its envelopes and no key, and the objects are the ciphertext at
 * the size the record states, so the plaintext is nowhere in the zip.
 */

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });

async function sealedCopyOf(page: Page, name: string) {
    const target = row(page, name);
    const box = (await target.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(target).toHaveAttribute('aria-selected', 'true');
    // Info is a panel beside the list on a screen this wide; the copy sits in a section of it.
    await page.keyboard.press('i');
    const details = page.locator('[data-details]');
    await expect(details).toContainText(name);
    await details.getByText('Keep your own copy').click();
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        details.getByRole('button', { name: 'Download sealed copy' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${name}.hushos.zip`);
    const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!)) as {
        format: string;
        root: string;
        nodes: {
            id: string;
            kind: string;
            keyEnvelope: string;
            metadataEnvelope: string;
            version: { object: string; ciphertextSize: string } | null;
        }[];
    };
    await details.getByRole('button', { name: 'Close details' }).click();
    await expect(details).toHaveCount(0);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForTimeout(600);
    return { files, manifest };
}

test('a sealed copy of a file and of a folder carries the records and the ciphertext, and nothing readable', async ({
    browser,
}) => {
    test.setTimeout(240_000);
    const page = await newPage(browser);
    await registerAccount(page);
    const samples = sampleFiles();
    await page
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await page.getByPlaceholder('Reports/2026').fill('Project');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Project')).toBeVisible();
    await page.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(page, 'notes.md')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Uploading/)).toHaveCount(0, { timeout: 60_000 });
    const clear = page.getByRole('button', { name: 'Clear finished' });
    if (await clear.count()) await clear.click();

    const file = await sealedCopyOf(page, 'notes.md');
    expect(file.manifest.format).toBe('hushos-sealed');
    expect(file.manifest.nodes).toHaveLength(1);
    const [note] = file.manifest.nodes;
    expect(note!.id).toBe(file.manifest.root);
    expect(note!.keyEnvelope.length).toBeGreaterThan(40);
    expect(note!.version).not.toBeNull();
    const object = file.files[note!.version!.object]!;
    expect(object.byteLength).toBe(Number(note!.version!.ciphertextSize));
    // The words of the note are not in the zip: not in the object, not in the manifest.
    const plaintext = readFileSync(samples.files.markdown, 'utf8').slice(0, 12);
    const whole = new TextDecoder('latin1').decode(
        Buffer.concat(Object.values(file.files).map((bytes) => Buffer.from(bytes))),
    );
    expect(whole).not.toContain(plaintext);
    expect(whole).not.toContain('notes.md');
    expect(JSON.stringify(file.manifest)).not.toMatch(/"key":/);

    // The folder: itself first, then what is in it. Move the note in to give it a child.
    await row(page, 'notes.md').locator('button').first().dragTo(row(page, 'Project'));
    await expect(row(page, 'notes.md')).toHaveCount(0, { timeout: 30_000 });
    const folder = await sealedCopyOf(page, 'Project');
    expect(folder.manifest.nodes.map((node) => node.kind)).toEqual(['folder', 'file']);
    expect(folder.manifest.nodes[0]!.id).toBe(folder.manifest.root);
    expect(folder.manifest.nodes[1]!.id).toBe(note!.id);
    expect(Object.keys(folder.files).sort()).toEqual(
        ['manifest.json', note!.version!.object].sort(),
    );
});
