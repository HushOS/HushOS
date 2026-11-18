import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { describe, expect, test } from 'vitest';
import type { DriveNode } from '@hushos/drive/client';
import {
    editableThroughShares,
    editableFile,
    editableKind,
    encodeText,
    openText,
    readOnlyReason,
    TEXT_EDIT_LIMIT,
    type ReadOnlyReason,
} from '@/lib/text-edit';

/*
 * The editor opens a file for editing only when what it saves is the file
 * byte for byte except for the edit. The verdicts are held to the core's
 * (fixtures/text-edit-cases.json, crates/hushos-core/tests/text_edit.rs): a
 * case that differs is a file the phones let someone edit and the web doesn't.
 */

type Part = { hex: string; repeat?: number };
const cases = JSON.parse(
    readFileSync(
        join(import.meta.dirname, '../../../../crates/hushos-core/fixtures/text-edit-cases.json'),
        'utf8',
    ),
) as {
    bytes: { name: string; bytes: Part[]; reason: ReadOnlyReason | null }[];
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

describe('which bytes open for editing', () => {
    test.each(cases.bytes.map((c) => [c.name, c] as const))('%s', (_, c) => {
        expect(readOnlyReason(bytesOf(c.bytes))).toBe(c.reason);
    });

    test('the fixture covers every reason and the limit is the web’s text limit', () => {
        const reasons = new Set(cases.bytes.map((c) => c.reason));
        for (const reason of [
            null,
            'too-large',
            'byte-order-mark',
            'utf-16',
            'encoding',
            'binary',
            'line-endings',
        ])
            expect(reasons).toContain(reason);
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
    test('every editable case comes back out of the editor byte for byte', () => {
        for (const c of cases.bytes.filter((each) => each.reason === null)) {
            const bytes = bytesOf(c.bytes);
            const opened = openText(bytes);
            expect(opened.editable, c.name).toBe(true);
            if (!opened.editable) continue;
            // Through CodeMirror's own document, as the editor holds it.
            const doc = EditorState.create({ doc: opened.text }).doc.toString();
            expect(plain(encodeText(doc)), c.name).toEqual(plain(bytes));
        }
    });

    test('an edit in the middle of multibyte text changes only those bytes', () => {
        const original = 'Grüße 👋\nzweite Zeile noch\nohne Zeilenende';
        const bytes = encodeText(original);
        const opened = openText(bytes);
        if (!opened.editable) throw new Error('should open');
        const at = opened.text.indexOf('zweite');
        const state = EditorState.create({ doc: opened.text });
        const edited = state.update({ changes: { from: at, to: at + 6, insert: 'dritte ✓' } }).state
            .doc;
        const saved = encodeText(edited.toString());
        // The same edit made on the bytes: the UTF-8 offset of the replaced word, everything else untouched.
        const byteAt = encodeText(original.slice(0, at)).length;
        const expected = [
            ...plain(bytes.subarray(0, byteAt)),
            ...plain(encodeText('dritte ✓')),
            ...plain(bytes.subarray(byteAt + 6)),
        ];
        expect(plain(saved)).toEqual(expected);
        // No final newline was added, and the line separator wasn't taken for a line break.
        expect(saved.at(-1)).toBe('e'.charCodeAt(0));
        expect(edited.lines).toBe(3);
    });

    test('a new line typed into the editor is LF, never CRLF', () => {
        const state = EditorState.create({ doc: 'a' });
        const typed = state.update({
            changes: { from: 1, insert: state.toText('\r\nb') },
        }).state;
        expect(plain(encodeText(typed.doc.toString()))).toEqual(plain(encodeText('a\nb')));
    });
});

describe('read-only files', () => {
    test('a file the editor can’t keep exactly is never offered as editable text', () => {
        for (const c of cases.bytes.filter((each) => each.reason !== null)) {
            const opened = openText(bytesOf(c.bytes));
            expect(opened.editable, c.name).toBe(false);
        }
    });

    test('a byte order mark or CRLF file still shows its words, read-only', () => {
        const bom = openText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
        expect(bom).toEqual({ editable: false, reason: 'byte-order-mark', text: 'hi' });
        const crlf = openText(encodeText('a\r\nb'));
        expect(crlf).toMatchObject({ editable: false, reason: 'line-endings', text: 'a\r\nb' });
        expect(openText(Uint8Array.from([0x61, 0x00]))).toMatchObject({ text: null });
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
