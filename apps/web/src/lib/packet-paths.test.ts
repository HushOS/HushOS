import { describe, expect, it } from 'vitest';
import { type PacketTree, packetPaths, packetSegment, printable } from '@/lib/packet-paths';

const file = (id: string, name: string): PacketTree => ({ id, name, kind: 'file' });
const folder = (id: string, name: string, children: PacketTree[]): PacketTree => ({
    id,
    name,
    kind: 'folder',
    children,
});

/* What an extractor would do with each part of a segment: a dot pair, or a name that becomes one. */
const climbs = (segment: string) =>
    segment.split(/[\\/]/).some((part) => climbsAlone(part.normalize('NFKC')));
const climbsAlone = (segment: string) => {
    const cut = segment.split('\0')[0]!; // C extractors and Python's zipfile stop at a NUL
    const windows = cut.replace(/[. ]+$/, ''); // Windows drops trailing dots and spaces
    return ['', '.', '..'].includes(cut) || ['', '.', '..'].includes(windows);
};

describe('packet paths for names a reported person chose', () => {
    const hostile = [
        '.',
        '..',
        '',
        '..\0x',
        '.. ',
        '...',
        ' ',
        '..\u202e',
        '\u202e..',
        '.\0',
        '..\\..\\x',
        '．．',
        '．．／x',
        '.. .',
        '\u3000..',
    ];

    it('never makes a segment that climbs out of the zip or is empty', () => {
        const tree = folder(
            'root',
            '..',
            hostile.map((name, index) =>
                folder(`f${index}`, name, [
                    file(`x${index}`, name),
                    file(`y${index}`, 'inner.txt'),
                ]),
            ),
        );
        const paths = packetPaths(tree);
        expect(paths).toHaveLength(hostile.length * 2);
        for (const { path } of paths)
            for (const segment of path.split('/')) expect(climbs(segment), path).toBe(false);
    });

    it('gives siblings that come out the same name distinct paths, case aside', () => {
        const tree = folder('root', 'Evidence', [
            file('1', 'a/b'),
            file('2', 'a_b'),
            file('3', '.'),
            file('4', '..'),
            file('5', '_'),
            file('6', 'photo.jpg'),
            file('7', 'photo.jpg'),
            file('8', 'Photo.JPG'),
            folder('9', 'notes', []),
            file('10', 'notes'),
            file('11', 'x (2)'),
            file('12', 'x'),
            file('13', 'x'),
        ]);
        const paths = packetPaths(tree).map((entry) => entry.path.toLowerCase());
        expect(new Set(paths).size).toBe(paths.length);
        expect(packetPaths(tree).find((entry) => entry.nodeId === '7')?.path).toBe(
            'Evidence/photo (2).jpg',
        );
    });

    it('treats names a file system sees as one as colliding', () => {
        const nfc = 'caf\u00e9.jpg';
        const nfd = 'cafe\u0301.jpg';
        const tree = folder('root', 'r', [
            file('1', nfc),
            file('2', nfd),
            file('3', '\u03c3.txt'), // σ
            file('4', '\u03c2.txt'), // ς, the same letter to NTFS
            file('5', 'ＡＢ.txt'), // full-width
            file('6', 'ab.txt'),
        ]);
        const keys = packetPaths(tree).map((entry) =>
            entry.path.normalize('NFKC').toUpperCase().toLowerCase(),
        );
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('takes bidi marks and controls out of a segment', () => {
        expect(packetSegment('invoice\u202efdp.exe')).toBe('invoice_fdp.exe');
        expect(packetSegment('a\u200fb\u2066c\u061cd')).toBe('a_b_c_d');
        expect(packetSegment('x\u0085y\u007fz')).toBe('x_y_z');
    });

    it('never lets a file with an empty name take its folder’s path', () => {
        const tree = folder('root', 'dir', [
            file('empty', ''),
            folder('sub', 'sub', [file('e2', '')]),
        ]);
        const paths = packetPaths(tree).map((entry) => entry.path);
        for (const path of paths) {
            expect(path.endsWith('/')).toBe(false);
            expect(['dir', 'dir/sub']).not.toContain(path);
        }
    });

    it('keeps each name under the byte limit, with room for a number', () => {
        const segment = packetSegment('名'.repeat(300));
        expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(240);
        const tree = folder('root', 'r', [
            file('1', '名'.repeat(300)),
            file('2', '名'.repeat(300)),
        ]);
        for (const { path } of packetPaths(tree))
            expect(new TextEncoder().encode(path.split('/').at(-1)!).length).toBeLessThanOrEqual(
                255,
            );
    });

    it('does not use a name Windows keeps for a device', () => {
        const longCon = `con${' '.repeat(300)}x`; // the byte cut and trim leave "con"
        for (const name of [
            'CON',
            'nul.txt',
            'Com1',
            'lpt9.log',
            'nul .txt',
            'COM¹',
            'CONIN$',
            'conout$.log',
            longCon,
        ])
            expect(packetSegment(name).startsWith('_'), JSON.stringify(name.slice(0, 12))).toBe(
                true,
            );
        expect(packetSegment('console.txt')).toBe('console.txt');
    });

    it('keeps the names as uploaded beside the cleaned path, root first', () => {
        const tree = folder('root', 'a/b', [file('f', 'x\ny.txt')]);
        expect(packetPaths(tree)).toEqual([
            { nodeId: 'f', path: 'a_b/x_y.txt', names: ['a/b', 'x\ny.txt'] },
        ]);
    });
});

describe('names written into the packet’s text files', () => {
    it('cannot start a new line or reorder the text around them', () => {
        const forged = 'a.txt\nmd5=0000  sha1=0000\r\u2028\u202eb';
        const line = printable(forged);
        for (const char of ['\n', '\r', '\u2028', '\u202e']) expect(line).not.toContain(char);
        expect(line).toContain('\\u{a}');
    });

    it('leaves ordinary names as they are', () => {
        expect(printable('Holiday photos 2026 / Lisbon.jpg')).toBe(
            'Holiday photos 2026 / Lisbon.jpg',
        );
    });
});
