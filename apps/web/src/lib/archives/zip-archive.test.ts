// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import table from '../../../../../e2e/fixtures/archives/expected.json';
import { FIXTURE_DIR, FIXTURES } from '../../../../../e2e/fixtures/archives/make';
import { ZipArchive } from './zip-archive';
import { asksFirst, ZipError } from './zip-format';

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
    parts?: Record<string, string[]>;
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
                    expect(
                        await outcome(() => archive.download(index, () => {}, undefined, password)),
                        label,
                    ).toBe(want.download);
                    if (want.withoutPassword)
                        expect(await outcome(() => archive.check(index, null)), label).toBe(
                            want.withoutPassword,
                        );
                    if (want.wrongPassword)
                        expect(await outcome(() => archive.check(index, 'not it')), label).toBe(
                            want.wrongPassword,
                        );
                }
                for (const [path, parts] of Object.entries(expected.parts ?? {}))
                    expect(archive.listed.find((item) => item.path === path)?.parts, path).toEqual(
                        parts,
                    );
                if (expected.unlock) {
                    expect(await (await open(name)).unlock(table.password)).toBe(
                        expected.unlock.right,
                    );
                    expect(await (await open(name)).unlock('not it')).toBe(expected.unlock.wrong);
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
        expect(await outcome(() => archive.preview(0, 1024))).toBe('password');
    });
});
