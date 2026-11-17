// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    CANARY,
    FIXTURE_DIR,
    FIXTURES,
    PASSWORD,
    writeFixture,
} from '../../../../../e2e/fixtures/archives/make';

/*
 * Each archive fixture is what it claims, read by something other than HushOS: Python's zipfile
 * (run isolated, -I) and bsdtar. A fixture that stopped being malicious, or stopped being what
 * the tests think it is, fails here rather than passing quietly everywhere else. The committed
 * fixtures are also checked to be exactly what make.ts writes.
 */

const large = mkdtempSync(join(tmpdir(), 'hushos-archives-'));
afterAll(() => rmSync(large, { recursive: true, force: true }));

function pathOf(name: string) {
    const fixture = FIXTURES.find((item) => item.name === name)!;
    return fixture.large ? writeFixture(name, large) : join(FIXTURE_DIR, name);
}

/* zipfile's view of an archive: each entry's fields, and what reading it (with the password) did. */
const PY_LIST = String.raw`
import json, sys, warnings, zipfile, binascii
warnings.simplefilter('ignore')
out = {}
try:
    z = zipfile.ZipFile(sys.argv[1])
except Exception as e:
    print(json.dumps({'error': type(e).__name__ + ': ' + str(e)})); sys.exit()
read = sys.argv[2] == 'read'
entries = []
for i in z.infolist():
    item = {'name': i.filename, 'raw': binascii.hexlify(i.orig_filename.encode('utf-8', 'surrogateescape')).decode(),
            'method': i.compress_type, 'size': i.file_size, 'packed': i.compress_size,
            'offset': i.header_offset, 'flags': i.flag_bits, 'system': i.create_system,
            'mode': i.external_attr >> 16, 'crc': i.CRC}
    if read and not i.is_dir():
        try:
            data = z.read(i, pwd=sys.argv[3].encode())
            item['read'] = 'ok'
            item['text'] = data[:200].decode('utf-8', 'replace')
        except Exception as e:
            item['read'] = type(e).__name__ + ': ' + str(e)
    entries.append(item)
out['entries'] = entries
print(json.dumps(out))
`;

type PyEntry = {
    name: string;
    method: number;
    size: number;
    packed: number;
    offset: number;
    flags: number;
    system: number;
    mode: number;
    crc: number;
    read?: string;
    text?: string;
};

function python(name: string, read = true, password = PASSWORD) {
    const output = execFileSync(
        'python3',
        ['-I', '-c', PY_LIST, pathOf(name), read ? 'read' : 'list', password],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    return JSON.parse(output) as { error?: string; entries: PyEntry[] };
}

function bsdtar(name: string, args: string[]) {
    const result = spawnSync('bsdtar', [...args, '-f', pathOf(name)], { encoding: 'utf8' });
    return { status: result.status, out: result.stdout, err: result.stderr };
}

const GiB = 1024 * 1024 * 1024;

describe('the archive fixtures, through independent readers', () => {
    it('are what make.ts writes today (the compressed bytes may differ between zlib builds)', () => {
        const fresh = mkdtempSync(join(tmpdir(), 'hushos-archives-fresh-'));
        try {
            for (const fixture of FIXTURES.filter((item) => !item.large)) {
                if (fixture.name === 'strong.zip') continue;
                const facts = (path: string) =>
                    JSON.parse(
                        execFileSync('python3', ['-I', '-c', PY_LIST, path, 'list', PASSWORD], {
                            encoding: 'utf8',
                        }),
                    ).entries.map((entry: PyEntry) => [
                        entry.name,
                        entry.method,
                        entry.size,
                        entry.crc,
                        entry.flags,
                    ]);
                expect(facts(writeFixture(fixture.name, fresh)), fixture.name).toEqual(
                    facts(join(FIXTURE_DIR, fixture.name)),
                );
            }
        } finally {
            rmSync(fresh, { recursive: true, force: true });
        }
    });

    it('basic.zip: folders, deflated and stored entries, a data descriptor, the canary inside', () => {
        const { entries } = python('basic.zip');
        const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
        expect(byName['docs/readme.txt']).toMatchObject({ method: 8, read: 'ok' });
        expect(byName['docs/readme.txt']!.text).toContain(CANARY);
        expect(byName['docs/stored.txt']).toMatchObject({ method: 0, read: 'ok' });
        expect(byName['streamed.txt']!.flags & 8).toBe(8);
        expect(byName['streamed.txt']!.read).toBe('ok');
        // Deflate64, which zipfile can't read: method 9 is what it says.
        expect(byName['deflate64.txt']).toMatchObject({ method: 9 });
    });

    it('names.zip: traversal, absolute, drive, UNC, NFC and NFD, NUL, an override, device names', () => {
        const names = python('names.zip', false).entries.map((entry) => entry.name);
        for (const name of [
            '../evil.txt',
            '../../etc/passwd',
            'a/../../b',
            'a\\..\\..\\b',
            '/abs.txt',
            '\\abs.txt',
            'C:\\win.txt',
            'C:evil.txt',
            '\\\\server\\share\\x',
            './a',
            'a//b',
            'é.txt'.normalize('NFC'),
            'é.txt'.normalize('NFD'),
            'rtl\u202etxt.exe',
            'CON',
            'aux.txt',
            'same',
            'same/inner.txt',
        ])
            expect(names, name).toContain(name);
        expect(names.some((name) => name.split('/').some((part) => part.length === 304))).toBe(
            true,
        );
        expect(names.some((name) => name.split('/').length === 41)).toBe(true);
        // zipfile cuts a name at its NUL; the raw bytes still hold it.
        expect(names).toContain('nul');
    });

    it('cp437.zip: CP437 bytes, a Unicode path field with a good and a stale CRC, UTF-8 with and without the flag', () => {
        // The directory walked with struct, not zipfile, whose handling of 0x7075 differs between Pythons.
        const records = JSON.parse(
            execFileSync(
                'python3',
                [
                    '-I',
                    '-c',
                    String.raw`
import json, struct, sys, zlib
b = open(sys.argv[1], 'rb').read()
e = b.rfind(b'PK'); count, size, at = struct.unpack('<HII', b[e+10:e+20])
out = []
for _ in range(count):
    flags = struct.unpack('<H', b[at+8:at+10])[0]
    n, x, c = struct.unpack('<HHH', b[at+28:at+34])
    name = b[at+46:at+46+n]; extra = b[at+46+n:at+46+n+x]; field = None; p = 0
    while p + 4 <= len(extra):
        tag, length = struct.unpack('<HH', extra[p:p+4])
        if tag == 0x7075:
            body = extra[p+4:p+4+length]
            field = {'crcMatches': struct.unpack('<I', body[1:5])[0] == zlib.crc32(name), 'name': body[5:].decode('utf-8')}
        p += 4 + length
    out.append({'flag': bool(flags & 0x800), 'cp437': name.decode('cp437'), 'utf8': name.decode('utf-8', 'replace'), 'field': field})
    at += 46 + n + x + c
print(json.dumps(out))`,
                    pathOf('cp437.zip'),
                ],
                { encoding: 'utf8' },
            ),
        );
        expect(records).toEqual([
            { flag: false, cp437: 'café-ö.txt', utf8: 'caf\ufffd-\ufffd.txt', field: null },
            {
                flag: false,
                cp437: 'nameé.txt',
                utf8: 'name\ufffd.txt',
                field: { crcMatches: true, name: 'Ünïcødé.txt' },
            },
            {
                flag: false,
                cp437: 'oldé.txt',
                utf8: 'old\ufffd.txt',
                field: { crcMatches: false, name: 'wrong.txt' },
            },
            { flag: false, cp437: 'na├»ve-utf8.txt', utf8: 'naïve-utf8.txt', field: null },
            { flag: true, cp437: 'µùÑµ£¼Φ¬₧.txt', utf8: '日本語.txt', field: null },
        ]);
    });

    it('mac.zip, nested.zip, symlink.zip, methods.zip: what each entry is', () => {
        expect(python('mac.zip', false).entries.map((entry) => entry.name)).toEqual([
            'photo.jpg',
            '__MACOSX/',
            '__MACOSX/._photo.jpg',
            'folder/file.txt',
            'folder/._file.txt',
            'folder/._orphan',
        ]);
        const nested = python('nested.zip').entries[0]!;
        expect(nested).toMatchObject({ name: 'inner.zip', read: 'ok' });
        const link = python('symlink.zip', false).entries[0]!;
        expect(link).toMatchObject({ name: 'link', system: 3 });
        expect(link.mode & 0o170000).toBe(0o120000);
        expect(python('methods.zip', false).entries.map((entry) => entry.method)).toEqual([
            12, 14, 93, 98, 8,
        ]);
    });

    it('aes.zip and aes-flipped.zip: WinZip AES-256 that opens with the password, and a flipped code that fails', () => {
        const right = bsdtar('aes.zip', ['-xO', '--passphrase', PASSWORD]);
        expect(right.status).toBe(0);
        expect(right.out).toContain('AES-256, AE-2.');
        expect(right.out).toContain('AES-256, AE-1.');
        expect(right.out).toContain(CANARY);
        expect(bsdtar('aes.zip', ['-xO', '--passphrase', 'not it', 'secret.txt']).status).not.toBe(
            0,
        );
        const flipped = bsdtar('aes-flipped.zip', ['-xO', '--passphrase', PASSWORD]);
        expect(flipped.status).not.toBe(0);
        expect(flipped.err).toMatch(/Authentication code/i);
        expect(python('aes.zip', false).entries.map((entry) => entry.method)).toEqual([99, 99, 8]);
    });

    it('zipcrypto.zip: traditional encryption that opens with the password only', () => {
        expect(python('zipcrypto.zip').entries.map((entry) => entry.read)).toEqual(['ok', 'ok']);
        expect(python('zipcrypto.zip', true, 'not it').entries[0]!.read).toMatch(/password/i);
    });

    it('bad-crc.zip, local-mismatch.zip: a wrong CRC-32, and a local header naming another file', () => {
        expect(python('bad-crc.zip').entries[0]!.read).toMatch(/Bad CRC-32/);
        expect(python('local-mismatch.zip').entries[0]!.read).toMatch(/differ/);
    });

    it('declares-1k.zip: declares 1 KiB and inflates to 100 MiB', () => {
        const entry = python('declares-1k.zip', false).entries[0]!;
        expect(entry.size).toBe(1024);
        const inflated = execFileSync(
            'python3',
            [
                '-I',
                '-c',
                String.raw`
import sys, zlib, zipfile
z = zipfile.ZipFile(sys.argv[1]); i = z.infolist()[0]
f = open(sys.argv[1], 'rb'); f.seek(i.header_offset + 26)
n, e = int.from_bytes(f.read(2), 'little'), int.from_bytes(f.read(2), 'little')
f.seek(i.header_offset + 30 + n + e)
d = zlib.decompressobj(-15); total = 0; data = f.read(i.compress_size)
while data:
    total += len(d.decompress(data, 1 << 20)); data = d.unconsumed_tail
print(total)`,
                pathOf('declares-1k.zip'),
            ],
            { encoding: 'utf8' },
        );
        expect(Number(inflated)).toBe(100 * 1024 * 1024);
    });

    it('overlap.zip: twenty records over one local header, 2,000 MiB declared from 100 KiB', () => {
        const { entries } = python('overlap.zip', false);
        expect(entries).toHaveLength(20);
        expect(new Set(entries.map((entry) => entry.offset))).toEqual(new Set([0]));
        expect(entries.reduce((sum, entry) => sum + entry.size, 0)).toBe(2000 * 1024 * 1024);
    });

    it('strong.zip: a ZIP64 end record of version 2 and an encrypted list of contents', () => {
        expect(python('strong.zip').error).toMatch(/Bad magic number for central directory/);
        const facts = execFileSync(
            'python3',
            [
                '-I',
                '-c',
                String.raw`
import sys, struct
b = open(sys.argv[1], 'rb').read()
loc = b.rfind(b'PK\x06\x07'); rec = struct.unpack('<Q', b[loc+8:loc+16])[0]
size, made, need = struct.unpack('<QHH', b[rec+4:rec+16])
cd = struct.unpack('<Q', b[rec+48:rec+56])[0]
print(size, need, b[cd:cd+4].hex())`,
                pathOf('strong.zip'),
            ],
            { encoding: 'utf8' },
        );
        const [size, need, signature] = facts.trim().split(' ');
        expect(Number(size)).toBeGreaterThan(44);
        expect(Number(need)).toBeGreaterThanOrEqual(62);
        // The archive extra data record (PK\x06\x08) where the directory should start.
        expect(signature).toBe('504b0608');
    });

    it('the large ones: 1 GiB of zeros, 5 GiB through ZIP64, 100,001 entries, a 65 MiB directory', () => {
        const zeros = python('zeros-1g.zip', false).entries[0]!;
        expect(zeros.size).toBe(GiB);
        expect(zeros.packed).toBeLessThan(1.1 * 1024 * 1024);
        const big = python('zip64-5g.zip', false).entries[0]!;
        expect(big.size).toBe(5 * GiB);
        expect(big.packed).toBeLessThan(5.5 * 1024 * 1024);
        expect(python('entries-100001.zip', false).entries).toHaveLength(100_001);
        const directory = execFileSync(
            'python3',
            [
                '-I',
                '-c',
                String.raw`
import sys, zipfile
f = open(sys.argv[1], 'rb'); end = zipfile._EndRecData(f)
print(end[zipfile._ECD_SIZE], end[zipfile._ECD_ENTRIES_TOTAL])`,
                pathOf('directory-65m.zip'),
            ],
            { encoding: 'utf8' },
        );
        const [size, count] = directory.trim().split(' ').map(Number);
        expect(size).toBeGreaterThan(65 * 1024 * 1024);
        expect(count).toBeLessThanOrEqual(100_000);
    }, 120_000);
});
