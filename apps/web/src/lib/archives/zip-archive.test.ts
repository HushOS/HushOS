// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import table from '../../../../../e2e/fixtures/archives/expected.json';
import { crc32, FIXTURE_DIR, FIXTURES, writeZip } from '../../../../../e2e/fixtures/archives/make';
import { ZipArchive } from './zip-archive';
import { readListing } from './session';
import {
    asksFirst,
    LIST_DEPTH_MAX,
    pathParts,
    ZipError,
    type Folders,
    type Listed,
} from './zip-format';

/*
 * Every fixture of e2e/fixtures/archives against the outcomes in its expected.json, the table
 * the Rust core is held to as well (crates/hushos-core/src/archive.rs): what lists, what each
 * entry is, and what reading it meets, with zip.js doing the inflating as it does in the worker.
 */

type Expected = {
    generated?: boolean;
    listing: string;
    hidden?: number;
    unlock?: { right: boolean; wrong: boolean };
    unlockWith?: { password: string; anywhere: boolean; at: Record<string, boolean> };
    unlockSkips?: string;
    unproven?: { password: string; entry: string };
    damagedTwice?: string;
    parts?: Record<string, string[]>;
    partsLength?: Record<string, number>;
    count?: number;
    saveNames?: Record<string, string>;
    entries?: {
        path: string;
        directory?: boolean;
        hidden?: boolean;
        lock?: string;
        support?: string;
        link?: boolean;
        nested?: boolean;
        stored?: boolean;
        size?: number;
        asksFirst?: boolean;
        downloadSha256?: string;
        check: string;
        download: string;
        withoutPassword?: string;
        wrongPassword?: string;
    }[];
};

const fixtures = table.fixtures as Record<string, Expected>;
const cache = new Map<string, Uint8Array>();

function bytesOf(name: string) {
    let bytes = cache.get(name);
    if (!bytes) {
        const fixture = FIXTURES.find((item) => item.name === name)!;
        bytes = fixture.large
            ? fixture.build()
            : new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
        cache.set(name, bytes);
    }
    return bytes;
}

function open(name: string) {
    const bytes = bytesOf(name);
    return ZipArchive.open({
        size: bytes.length,
        read: async (offset, length) => bytes.subarray(offset, offset + length),
    });
}

async function outcome(work: () => Promise<unknown>) {
    try {
        await work();
        return 'ok';
    } catch (error) {
        if (error instanceof ZipError) return error.code;
        throw error;
    }
}

/* Each folder's parent and name (folder 0, the top, has none). */
function folderTable({ parents, names }: Folders) {
    const split = names.split('/');
    expect(split.pop()).toBe('');
    expect(split.length + 1).toBe(parents.length);
    return [...parents].map((parent, k) => ({ parent, name: k === 0 ? '' : split[k - 1]! }));
}

type FolderTable = ReturnType<typeof folderTable>;

/* An entry's folders and name, from the top, as the list shows them. */
function partsOf(table: FolderTable, item: Listed) {
    const parts = [item.name];
    for (let at = item.folder; at !== 0; at = table[at]!.parent) parts.unshift(table[at]!.name);
    return parts;
}

function expectListedWhereItsPathSays(listed: Listed[], table: FolderTable, name: string) {
    const seen = new Set<string>();
    table.forEach((folder, k) => {
        if (k === 0) return;
        expect(folder.parent, `${name}: folder ${k} after its parent`).toBeLessThan(k);
        expect(folder.name === '' || folder.name === '.' || /[\\/]/.test(folder.name)).toBe(false);
        expect(
            seen.has(`${folder.parent}/${folder.name}`),
            `${name}: one ${folder.name} a folder`,
        ).toBe(false);
        seen.add(`${folder.parent}/${folder.name}`);
    });
    for (const item of listed) {
        const parts = pathParts(item.path);
        if (item.hidden && parts[0] === '__MACOSX') {
            expect(item.folder, `${name}: ${item.path} in no folder`).toBe(0);
            continue;
        }
        const want =
            parts.length === 0 || parts.length > LIST_DEPTH_MAX ? [item.path || '_'] : parts;
        expect(partsOf(table, item), `${name}: where ${item.path.slice(0, 40)} is listed`).toEqual(
            want,
        );
    }
}

describe('every fixture, as expected.json says', () => {
    it('covers every fixture make.ts writes, and nothing else', () => {
        expect(Object.keys(fixtures).sort()).toEqual(FIXTURES.map((item) => item.name).sort());
    });

    for (const [name, expected] of Object.entries(fixtures))
        it(
            name,
            async () => {
                const listing = await outcome(() => open(name));
                expect(listing).toBe(expected.listing);
                if (expected.listing !== 'ok') return;
                const archive = await open(name);
                const folders = archive.takeFolders();
                const tree = folderTable(folders);
                // Every entry sits where its path puts it, or flat at the top, through one folder per name.
                expectListedWhereItsPathSays(archive.listed, tree, name);
                if (expected.count !== undefined) {
                    expect(archive.listed).toHaveLength(expected.count);
                    expect(
                        archive.listed.every(
                            (item) => partsOf(tree, item).length === LIST_DEPTH_MAX,
                        ),
                        'none flat',
                    ).toBe(true);
                    expect(
                        readListing(
                            {
                                entries: archive.listed.map(
                                    ({
                                        index,
                                        path,
                                        folder,
                                        name,
                                        directory,
                                        size,
                                        packed,
                                        dos,
                                        mtime,
                                        lock,
                                        support,
                                        link,
                                        nested,
                                        hidden,
                                        stored,
                                        saveName,
                                    }) => ({
                                        index,
                                        path,
                                        folder,
                                        name,
                                        directory,
                                        size,
                                        packed,
                                        dos,
                                        mtime,
                                        lock,
                                        support,
                                        link,
                                        nested,
                                        hidden,
                                        stored,
                                        saveName,
                                    }),
                                ),
                                hidden: archive.hidden,
                                parents: folders.parents,
                                names: folders.names,
                            },
                            bytesOf(name).length,
                        ),
                    ).not.toBeNull();
                    return;
                }
                const wanted = expected.entries!;
                expect(archive.entries.map((entry) => entry.path)).toEqual(
                    wanted.map((entry) => entry.path),
                );
                expect(archive.hidden).toBe(expected.hidden);
                for (const [index, want] of wanted.entries()) {
                    const entry = archive.entries[index]!;
                    const listed = archive.listed.find((item) => item.index === index)!;
                    const label = `${name}: ${want.path}`;
                    expect(entry.directory, label).toBe(want.directory ?? false);
                    expect(listed.hidden, label).toBe(want.hidden ?? false);
                    expect(listed.lock, label).toBe(want.lock ?? 'none');
                    expect(listed.support, label).toBe(want.support ?? 'ok');
                    expect(listed.link, label).toBe(want.link ?? false);
                    expect(listed.nested, label).toBe(want.nested ?? false);
                    expect(listed.stored, label).toBe(want.stored ?? false);
                    if (want.size !== undefined) expect(entry.size, label).toBe(want.size);
                    if (want.asksFirst !== undefined)
                        expect(asksFirst(entry), label).toBe(want.asksFirst);
                    const password = entry.lock === 'none' ? null : table.password;
                    expect(await outcome(() => archive.check(index, password)), label).toBe(
                        want.check,
                    );
                    const hash = createHash('sha256');
                    expect(
                        await outcome(() =>
                            archive.download(
                                index,
                                (chunk) => void hash.update(chunk),
                                undefined,
                                password,
                            ),
                        ),
                        label,
                    ).toBe(want.download);
                    if (want.downloadSha256)
                        expect(hash.digest('hex'), label).toBe(want.downloadSha256);
                    if (want.withoutPassword)
                        expect(await outcome(() => archive.check(index, null)), label).toBe(
                            want.withoutPassword,
                        );
                    if (want.wrongPassword)
                        expect(await outcome(() => archive.check(index, 'not it')), label).toBe(
                            want.wrongPassword,
                        );
                }
                const listedAt = (path: string) =>
                    archive.listed.find((item) => item.path === path)!;
                for (const [path, parts] of Object.entries(expected.parts ?? {}))
                    expect(partsOf(tree, listedAt(path)), path).toEqual(parts);
                for (const [path, length] of Object.entries(expected.partsLength ?? {}))
                    expect(partsOf(tree, listedAt(path)).length, path.slice(0, 20)).toBe(length);
                for (const [path, name] of Object.entries(expected.saveNames ?? {}))
                    expect(archive.listed.find((item) => item.path === path)?.saveName, path).toBe(
                        name,
                    );
                if (expected.unlock) {
                    expect(await (await open(name)).unlock(table.password)).toBe(
                        expected.unlock.right,
                    );
                    expect(await (await open(name)).unlock('not it')).toBe(expected.unlock.wrong);
                }
                if (expected.unproven) {
                    const held = await open(name);
                    const index = held.entries.findIndex(
                        (entry) => entry.path === expected.unproven!.entry,
                    );
                    // Only its check byte passed: held, then let go of by the damage it reads.
                    expect(await held.unlock(expected.unproven.password)).toBe(true);
                    expect(await outcome(() => held.download(index, () => {}))).toBe(
                        'password-unproven',
                    );
                    expect(held.unlocked).toBe(false);
                    expect(await outcome(() => held.download(index, () => {}))).toBe('password');
                }
                if (expected.damagedTwice) {
                    const held = await open(name);
                    const index = held.entries.findIndex(
                        (entry) => entry.path === expected.damagedTwice,
                    );
                    expect(await held.unlock(table.password, index)).toBe(true);
                    expect(await outcome(() => held.download(index, () => {}))).toBe(
                        'password-unproven',
                    );
                    // Typed again, the same password is kept and the damage said, not asked for again.
                    expect(await held.unlock(table.password, index)).toBe(true);
                    const damage = expected.entries!.find(
                        (entry) => entry.path === expected.damagedTwice,
                    )!.download;
                    expect(await outcome(() => held.download(index, () => {}))).toBe(damage);
                    expect(held.unlocked).toBe(true);
                }
                if (expected.unlockSkips) {
                    const bytes = bytesOf(name);
                    let read = 0;
                    const counted = await ZipArchive.open({
                        size: bytes.length,
                        read: async (offset, length) => {
                            read += length;
                            return bytes.slice(offset, offset + length);
                        },
                    });
                    read = 0;
                    expect(await counted.unlock(table.password)).toBe(true);
                    const skipped = counted.entries.find(
                        (entry) => entry.path === expected.unlockSkips,
                    )!;
                    expect(read, 'what the unlock read').toBeLessThan(skipped.packed);
                }
                if (expected.unlockWith) {
                    const { password, anywhere, at } = expected.unlockWith;
                    expect(await (await open(name)).unlock(password), 'aimed at none').toBe(
                        anywhere,
                    );
                    for (const [path, right] of Object.entries(at)) {
                        const index = archive.entries.findIndex((entry) => entry.path === path);
                        expect(await (await open(name)).unlock(password, index), path).toBe(right);
                    }
                }
            },
            120_000,
        );
});

describe('reading', () => {
    it('previews a deflated entry byte for byte, and reads a stored one only by its span', async () => {
        const archive = await open('basic.zip');
        const readme = archive.entries.findIndex((entry) => entry.path === 'docs/readme.txt');
        const text = new TextDecoder().decode(await archive.preview(readme, 1024));
        expect(text).toContain('Read me. This entry is deflated.');
        const stored = archive.entries.findIndex((entry) => entry.path === 'docs/stored.txt');
        const { offset, size } = await archive.span(stored);
        const bytes = bytesOf('basic.zip').subarray(offset, offset + size);
        expect(new TextDecoder().decode(bytes)).toContain('This entry is stored.');
        // A preview is held to its limit before anything is inflated.
        expect(await outcome(() => archive.preview(readme, 10))).toBe('too-large');
    });

    it('keeps a password only once it opens something, and drops it on close', async () => {
        const archive = await open('aes.zip');
        expect(await outcome(() => archive.preview(0, 1024))).toBe('password');
        expect(await archive.unlock('not it')).toBe(false);
        expect(await outcome(() => archive.preview(0, 1024))).toBe('password');
        expect(await archive.unlock(table.password)).toBe(true);
        expect(new TextDecoder().decode(await archive.preview(0, 1024))).toContain('AE-2');
        archive.close();
        expect(archive.unlocked).toBe(false);
        // Closed, nothing reads any more: not the entry it opened, not one it didn't need.
        expect(await outcome(() => archive.preview(0, 1024))).toBe('damaged');
        expect(await outcome(() => archive.preview(2, 1024))).toBe('damaged');
    });

    /*
     * unproven.zip under the right password, which only its check byte proves: a download stopped
     * part way (as the worker stops one, and as a failing sink ends one) is no damage, and the
     * password stays held for the next, which comes out whole.
     */
    it('lets a stopped download keep a password only its check byte proved', async () => {
        const archive = await open('unproven.zip');
        expect(await archive.unlock(table.password, 0)).toBe(true);
        const stop = new AbortController();
        const stopped = await outcome(() =>
            archive.download(
                0,
                () => {
                    // The worker's send, once the page has stopped it.
                    stop.abort();
                    throw new ZipError('damaged');
                },
                stop.signal,
            ),
        );
        expect(stopped).not.toBe('password-unproven');
        expect(archive.unlocked).toBe(true);
        const failed = await outcome(() =>
            archive.download(0, () => {
                throw new Error('The disk is full.');
            }),
        );
        expect(failed).not.toBe('password-unproven');
        expect(archive.unlocked).toBe(true);
        let size = 0;
        await archive.download(0, (chunk) => {
            size += chunk.length;
        });
        expect(size).toBe(archive.entries[0]!.size);
    });

    it('keeps a re-accepted password as proven as it was', async () => {
        // A small entry that proves the password, and a damaged one past the ratio that can only check it.
        const zeros = new Uint8Array(2 << 20);
        const bytes = writeZip([
            {
                name: 'small.txt',
                data: new TextEncoder().encode('Proves it.'),
                encrypt: { kind: 'zipcrypto' },
            },
            {
                name: 'zeros.bin',
                data: zeros,
                method: 8,
                crc: (crc32(zeros) ^ 0x00a5a5a5) >>> 0,
                encrypt: { kind: 'zipcrypto' },
            },
        ]);
        const archive = await ZipArchive.open({
            size: bytes.length,
            read: async (offset, length) => bytes.slice(offset, offset + length),
        });
        expect(await archive.unlock(table.password, 0)).toBe(true);
        // Accepted again by the entry that can only check it: still proven, so its damage is said.
        expect(await archive.unlock(table.password, 1)).toBe(true);
        expect(await outcome(() => archive.download(1, () => {}))).toBe('crc');
        expect(archive.unlocked).toBe(true);
    });
});
