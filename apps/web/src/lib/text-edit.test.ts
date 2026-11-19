import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { describe, expect, test } from 'vitest';
import type { DriveNode } from '@hushos/drive/client';
import {
    editableThroughShares,
    editableFile,
    editableKind,
    mixedNote,
    openedState,
    openText,
    readOnlyReason,
    saveBytes,
    savedState,
    TEXT_EDIT_LIMIT,
    utf8Length,
    viewText,
    type ReadOnlyReason,
    type SaveState,
} from '@/lib/text-edit';

/*
 * The editor opens a file for editing only when what it saves is the file byte for byte except
 * for the edit, in the file's own encoding, byte order mark and line breaks. The verdicts and the
 * bytes a save writes are held to the core's (fixtures/text-edit-cases.json,
 * crates/hushos-core/tests/text_edit.rs): a case that differs is a file the phones let someone
 * edit and the web doesn't, or one a client saves with bytes changed that nobody touched.
 */

type Part = { hex: string; repeat?: number };
const cases = JSON.parse(
    readFileSync(
        join(import.meta.dirname, '../../../../crates/hushos-core/fixtures/text-edit-cases.json'),
        'utf8',
    ),
) as {
    bytes: {
        name: string;
        bytes: Part[];
        reason: ReadOnlyReason | null;
        encoding?: string;
        lineEnding?: string;
        mixed?: boolean;
        text?: string;
    }[];
    edits: { name: string; bytes: Part[]; text: string; saved: Part[] | null }[];
    sessions: {
        name: string;
        bytes: Part[];
        saves: { text: { text: string; repeat?: number }[]; saved: Part[] }[];
    }[];
    names: { name: string; mime: string | null; editable: boolean }[];
};

function bytesOf(parts: Part[]) {
    const pieces = parts.map((part) => {
        const one = Uint8Array.from(part.hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
        const out = new Uint8Array(one.length * (part.repeat ?? 1));
        for (let at = 0; at < out.length; at += one.length) out.set(one, at);
        return out;
    });
    const all = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
        all.set(piece, at);
        at += piece.length;
    }
    return all;
}

/* Bytes compared as plain arrays: a TextEncoder of another realm (jsdom's) still compares equal. */
const plain = (bytes: Uint8Array) => Array.from(bytes);
/* Compared as buffers: the cases run to the 8 MiB limit, too long to diff element by element. */
const same = (a: Uint8Array | null, b: Uint8Array) =>
    a !== null && Buffer.from(a).equals(Buffer.from(b));
const utf8 = (text: string) => new TextEncoder().encode(text);
/* The text as CodeMirror's own document holds it, as the editor reads it back at a save. */
const throughEditor = (text: string) => EditorState.create({ doc: text }).doc.toString();
/* A session over bytes that must open for editing. */
const session = (bytes: Uint8Array): SaveState => {
    const state = openedState(bytes);
    if (!state) throw new Error('should open');
    return state;
};
/* What a save of `text` writes from an editor just opened on `bytes`, or null when it opened read-only. */
const savedFrom = (bytes: Uint8Array, text: string) => {
    const state = openedState(bytes);
    return state && saveBytes(state, text);
};

describe('which bytes open for editing', () => {
    test.each(cases.bytes.map((c) => [c.name, c] as const))('%s', (_, c) => {
        const bytes = bytesOf(c.bytes);
        expect(readOnlyReason(bytes)).toBe(c.reason);
        const opened = openText(bytes);
        if (!opened.editable) return expect(opened.reason).toBe(c.reason);
        expect(opened.format).toEqual({
            encoding: c.encoding,
            lineEnding: c.lineEnding,
            mixed: c.mixed,
        });
        if (c.text !== undefined) expect(opened.text).toBe(c.text);
        expect(opened.text.includes('\r')).toBe(false);
    });

    test('the fixture covers every reason, encoding and line ending, and the limit is the web’s text limit', () => {
        const reasons = new Set(cases.bytes.map((c) => c.reason));
        for (const reason of [null, 'too-large', 'encoding', 'binary', 'line-endings'])
            expect(reasons).toContain(reason);
        const encodings = new Set(cases.bytes.map((c) => c.encoding));
        for (const encoding of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'])
            expect(encodings).toContain(encoding);
        expect(cases.bytes.some((c) => c.lineEnding === 'crlf' && !c.mixed)).toBe(true);
        expect(cases.bytes.some((c) => c.mixed)).toBe(true);
        expect(TEXT_EDIT_LIMIT).toBe(8 * 1024 * 1024);
    });
});

describe('which files the editor opens', () => {
    test.each(cases.names.map((c) => [`${c.name} (${c.mime ?? 'no type'})`, c] as const))(
        '%s',
        (_, c) => {
            expect(editableKind(c.name, c.mime)).toBe(c.editable);
        },
    );
});

describe('a save changes only the edited bytes', () => {
    test('every editable case saved without an edit, through the editor, is its own bytes again', () => {
        for (const c of cases.bytes.filter((each) => each.reason === null)) {
            const bytes = bytesOf(c.bytes);
            const opened = openText(bytes);
            if (!opened.editable) throw new Error(`${c.name} should open`);
            expect(same(savedFrom(bytes, throughEditor(opened.text)), bytes), c.name).toBe(true);
        }
    });

    test.each(cases.edits.map((c) => [c.name, c] as const))('%s', (_, c) => {
        const bytes = bytesOf(c.bytes);
        const saved = savedFrom(bytes, c.text);
        if (c.saved === null) return expect(saved).toBeNull();
        expect(plain(saved!)).toEqual(plain(bytesOf(c.saved)));
        // Typed or pasted into CodeMirror, whose document keeps every line break as LF: the same bytes.
        expect(plain(savedFrom(bytes, throughEditor(c.text))!)).toEqual(plain(bytesOf(c.saved)));
    });

    test.each(cases.sessions.map((c) => [c.name, c] as const))('%s', (_, c) => {
        let state = session(bytesOf(c.bytes));
        for (const [at, save] of c.saves.entries()) {
            const text = save.text.map((part) => part.text.repeat(part.repeat ?? 1)).join('');
            const bytes = saveBytes(state, throughEditor(text));
            if (!bytes) throw new Error(`save ${at + 1} refused`);
            expect(same(bytes, bytesOf(save.saved)), `save ${at + 1}`).toBe(true);
            state = savedState(state, throughEditor(text), bytes);
        }
    });

    test('an edit in the middle of multibyte text changes only those bytes', () => {
        const original = 'Grüße 👋\nzweite Zeile noch\nohne Zeilenende';
        const bytes = utf8(original);
        const opened = openText(bytes);
        if (!opened.editable) throw new Error('should open');
        const at = opened.text.indexOf('zweite');
        const state = EditorState.create({ doc: opened.text });
        const edited = state.update({ changes: { from: at, to: at + 6, insert: 'dritte ✓' } }).state
            .doc;
        const saved = savedFrom(bytes, edited.toString())!;
        // The same edit made on the bytes: the UTF-8 offset of the replaced word, everything else untouched.
        const byteAt = utf8(original.slice(0, at)).length;
        const expected = [
            ...plain(bytes.subarray(0, byteAt)),
            ...plain(utf8('dritte ✓')),
            ...plain(bytes.subarray(byteAt + 6)),
        ];
        expect(plain(saved)).toEqual(expected);
        // No final newline was added, and the line separator wasn't taken for a line break.
        expect(saved.at(-1)).toBe('e'.charCodeAt(0));
        expect(edited.lines).toBe(3);
    });

    test('half of an emoji is never written, in any encoding; a whole one is, and opens again', () => {
        const smile = '\u{1F600}';
        for (const bytes of [
            new TextEncoder().encode('a\n'),
            Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a\n')]),
            Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00]),
            Uint8Array.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a]),
        ]) {
            const state = session(bytes);
            // Typed between the halves, and each half left alone at the end.
            for (const broken of [`a${smile[0]}x${smile[1]}\n`, `a${smile[0]}\n`, `a${smile[1]}\n`])
                expect(saveBytes(state, broken)).toBeNull();
            const whole = saveBytes(state, `a${smile}\n`);
            expect(whole).not.toBeNull();
            const reopened = openText(whole!);
            expect(reopened.editable && reopened.text).toBe(`a${smile}\n`);
        }
    });

    test('a line break typed into the editor takes the file’s, in its encoding', () => {
        const typed = (bytes: Uint8Array) => {
            const opened = openText(bytes);
            if (!opened.editable) throw new Error('should open');
            const state = EditorState.create({ doc: opened.text });
            const end = state.doc.length;
            // Typed or pasted as CRLF, it is one line break in CodeMirror's document either way.
            const doc = state.update({ changes: { from: end, insert: state.toText('\r\nb') } })
                .state.doc;
            return plain(savedFrom(bytes, doc.toString())!);
        };
        expect(typed(utf8('a'))).toEqual(plain(utf8('a\nb')));
        expect(typed(utf8('a\r\n'))).toEqual(plain(utf8('a\r\n\r\nb')));
        // UTF-16 big endian with its byte order mark: CR and LF are two bytes each, high byte first.
        expect(typed(Uint8Array.from([0xfe, 0xff, 0, 0x61, 0, 0x0d, 0, 0x0a]))).toEqual([
            0xfe, 0xff, 0, 0x61, 0, 0x0d, 0, 0x0a, 0, 0x0d, 0, 0x0a, 0, 0x62,
        ]);
    });

    test('a mixed file says which line break a save writes', () => {
        const mixed = openText(utf8('a\r\nb\r\nc\n'));
        if (!mixed.editable) throw new Error('should open');
        expect(mixedNote(mixed.format)).toBe(
            'This file mixes line endings; saving uses Windows (CRLF).',
        );
        const lf = openText(utf8('a\nb\nc\r\n'));
        if (!lf.editable) throw new Error('should open');
        expect(mixedNote(lf.format)).toBe('This file mixes line endings; saving uses Unix (LF).');
        const one = openText(utf8('a\r\nb\r\n'));
        if (!one.editable) throw new Error('should open');
        expect(mixedNote(one.format)).toBeNull();
    });
});

describe('read-only files', () => {
    test('a file the editor can’t keep exactly is never offered as editable text', () => {
        for (const c of cases.bytes.filter((each) => each.reason !== null)) {
            const opened = openText(bytesOf(c.bytes));
            expect(opened.editable, c.name).toBe(false);
        }
    });

    test('a Latin-1 or lone-CR file still shows its words, read-only; UTF-16 without a mark doesn’t', () => {
        const latin = openText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]));
        expect(latin).toEqual({ editable: false, reason: 'encoding', text: 'caf\ufffd' });
        expect(openText(utf8('a\rb'))).toEqual({
            editable: false,
            reason: 'line-endings',
            text: 'a\rb',
        });
        expect(openText(Uint8Array.from([0x61, 0x00]))).toMatchObject({ text: null });
        expect(openText(Uint8Array.from([0x68, 0, 0x69, 0]))).toEqual({
            editable: false,
            reason: 'encoding',
            text: null,
        });
    });
});

describe('the size of a text in UTF-8', () => {
    test('is what TextEncoder writes, without encoding it', () => {
        for (const text of ['', 'ascii', 'Grüße', '✓ ✗', '👋 and 😀', '\ud83d alone', 'end \udc00'])
            expect(utf8Length(text), text).toBe(new TextEncoder().encode(text).length);
    });
});

describe('the viewer’s words', () => {
    test('UTF-16 with a byte order mark reads as UTF-16; anything else as UTF-8', () => {
        expect(viewText(Uint8Array.from([0xff, 0xfe, 0x68, 0, 0x69, 0]))).toBe('hi');
        expect(viewText(Uint8Array.from([0xfe, 0xff, 0, 0x68, 0, 0x69]))).toBe('hi');
        expect(viewText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
    });
});

describe('a file the viewer read as text', () => {
    const file = (name: string, mime: string | null) =>
        ({ kind: 'file', name, metadata: { mime }, currentVersion: { id: 'v1' } }) as DriveNode;

    test('an extensionless file of no known type is editable once the viewer found it text', () => {
        const readme = file('README', 'application/octet-stream');
        expect(editableFile(readme)).toBe(false);
        expect(editableFile(readme, true)).toBe(true);
    });

    test('a sniff never makes a file of another kind editable', () => {
        expect(editableFile(file('report.pdf', 'application/pdf'), true)).toBe(false);
        expect(editableFile(file('photo.png', null), true)).toBe(false);
        expect(editableFile(file('clip.mp4', null), true)).toBe(false);
    });
});

describe('editing in someone else’s folder', () => {
    const chain = [
        { id: 'doc', workspaceId: 'w' },
        { id: 'inner', workspaceId: 'w' },
        { id: 'top', workspaceId: 'w' },
    ];
    const grant = (nodeId: string, role: 'viewer' | 'editor', workspaceId = 'w') => ({
        workspaceId,
        nodeId,
        role,
    });

    test('the nearest grant decides, as the server’s does', () => {
        expect(editableThroughShares(chain, [grant('top', 'editor')])).toBe(true);
        // A viewer's grant on the file itself, inside a folder shared to edit: not editable.
        expect(editableThroughShares(chain, [grant('top', 'editor'), grant('doc', 'viewer')])).toBe(
            false,
        );
        expect(
            editableThroughShares(chain, [grant('top', 'editor'), grant('inner', 'viewer')]),
        ).toBe(false);
        expect(
            editableThroughShares(chain, [grant('top', 'viewer'), grant('inner', 'editor')]),
        ).toBe(true);
    });

    test('a file shared to edit inside a folder shared to edit is edited: its folder can be listed', () => {
        expect(editableThroughShares(chain, [grant('top', 'editor'), grant('doc', 'editor')])).toBe(
            true,
        );
        // Its own grant to view still decides, whatever the folder's.
        expect(editableThroughShares(chain, [grant('top', 'viewer'), grant('doc', 'viewer')])).toBe(
            false,
        );
        // Shared to edit on its own, under a folder shared to view: the role is the file's, and the folder can be listed.
        expect(editableThroughShares(chain, [grant('top', 'viewer'), grant('doc', 'editor')])).toBe(
            true,
        );
    });

    test('a file shared on its own is never edited, and grants match by workspace too', () => {
        expect(editableThroughShares(chain, [grant('doc', 'editor')])).toBe(false);
        expect(editableThroughShares(chain, [grant('top', 'editor', 'other')])).toBe(false);
        expect(editableThroughShares(chain, [])).toBe(false);
    });
});
