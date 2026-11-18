import { describe, expect, test } from 'vitest';
import { lineAt, parseFailure, parseWarning, structuredKind } from '@/lib/text-parse';

/*
 * The warning beside Save names the line a person has to fix. A wrong line
 * sends them looking in the wrong place; a warning on text that parses makes
 * them distrust a file that is fine.
 */

describe('the structured-text check', () => {
    test('text that parses gets no warning', async () => {
        expect(await parseFailure('json', '{\n  "a": [1, 2]\n}\n')).toBeNull();
        expect(await parseFailure('yaml', 'a: 1\nb:\n  - x\n---\nc: 2\n')).toBeNull();
        expect(await parseFailure('toml', 'title = "x"\n[owner]\nname = "y"\n')).toBeNull();
        expect(await parseFailure('xml', '<?xml version="1.0"?>\n<a><b/></a>\n')).toBeNull();
    });

    test('broken JSON names the line it fails on', async () => {
        const text = '{\n  "a": 1,\n  "b": 2,\n}\n';
        expect(await parseFailure('json', text)).toEqual({ line: 4 });
    });

    test('broken YAML names its line, a duplicate key included', async () => {
        expect(await parseFailure('yaml', 'a: 1\nb: [1, 2\nc: 3\n')).not.toBeNull();
        expect(await parseFailure('yaml', 'a: 1\nb: 2\na: 3\n')).toEqual({ line: 3 });
    });

    test('broken TOML names its line', async () => {
        expect(await parseFailure('toml', 'a = 1\n\nb = = 2\n')).toEqual({ line: 3 });
        expect(await parseFailure('toml', 'a = 1\na = 2\n')).toEqual({ line: 2 });
    });

    test('broken XML is caught', async () => {
        expect(await parseFailure('xml', '<a>\n  <b>\n</a>\n')).not.toBeNull();
    });

    test('valid XML with its own <parsererror> element is not taken for broken', async () => {
        expect(
            await parseFailure('xml', '<log><parsererror>none</parsererror></log>\n'),
        ).toBeNull();
        expect(await parseFailure('xml', '<a xmlns="urn:x"><parsererror/></a>\n')).toBeNull();
    });

    test('the words and the languages checked', () => {
        expect(parseWarning('yaml', 14)).toBe('This YAML doesn’t parse at line 14.');
        expect(parseWarning('json', null)).toBe('This JSON doesn’t parse.');
        expect(structuredKind('jsonc')).toBeNull();
        expect(structuredKind('svg')).toBe('xml');
        expect(lineAt('a\nb\nc', 4)).toBe(3);
        expect(lineAt('a\nb\nc', 1)).toBe(1);
    });
});
