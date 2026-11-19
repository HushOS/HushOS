import { afterEach, describe, expect, test, vi } from 'vitest';
import { jsonErrorOffset } from '@/lib/text-parse-data';
import {
    lineAt,
    parseFailure,
    parseWarning,
    structuredKind,
    structuredKindOf,
} from '@/lib/text-parse';

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

    test('a file whose name gives no language is checked by the type its row records', () => {
        // An extensionless file recorded as JSON (or YAML, TOML, XML) still gets its warning.
        expect(structuredKindOf(null, 'application/json')).toBe('json');
        expect(structuredKindOf(null, 'application/json; charset=utf-8')).toBe('json');
        expect(structuredKindOf(null, 'application/yaml')).toBe('yaml');
        expect(structuredKindOf(null, 'application/toml')).toBe('toml');
        expect(structuredKindOf(null, 'text/xml')).toBe('xml');
        // Plain text stays unchecked, and a name's own language wins over its recorded type.
        expect(structuredKindOf(null, 'text/plain')).toBeNull();
        expect(structuredKindOf(null, null)).toBeNull();
        expect(structuredKindOf('yaml', 'application/json')).toBe('yaml');
        expect(structuredKindOf('rust', 'application/json')).toBeNull();
    });

    test('broken JSON names its line whatever the engine says: JavaScriptCore’s words name no place', async () => {
        // Safari's JSON.parse: "JSON Parse error: …", with no position or line in it.
        const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
            throw new SyntaxError('JSON Parse error: Unexpected comma at the end of object');
        });
        try {
            expect(await parseFailure('json', '{\n  "a": 1,\n  "b": 2,\n}\n')).toEqual({ line: 4 });
            expect(await parseFailure('json', '[1,\n2,\n\n  3 4]')).toEqual({ line: 4 });
        } finally {
            parse.mockRestore();
        }
    });
});

/*
 * Our own scan of where JSON breaks, held to the grammar: every place it names is where a reader
 * has to look, and text that parses is never said to break. Fails on a wrong place, or on a valid
 * text called broken.
 */
describe('where JSON breaks', () => {
    afterEach(() => vi.restoreAllMocks());

    test('valid JSON breaks nowhere, deep nesting included', () => {
        for (const text of [
            '{}',
            ' [ ] ',
            '"\\u00e9\\n"',
            '{"a": [1, -2.5e+3, true, false, null, {"b": "c"}]}',
            '0',
            '-0.0E-1',
            '['.repeat(50_000) + ']'.repeat(50_000),
        ]) {
            expect(() => JSON.parse(text)).not.toThrow();
            expect(jsonErrorOffset(text), text.slice(0, 40)).toBe(-1);
        }
    });

    test('each fault is placed where the text can’t go on', () => {
        const cases: [string, string][] = [
            ['{"a": 1,}', '}'],
            ['[1, 2,]', ']'],
            ['{"a" 1}', '1'],
            ['{a: 1}', 'a'],
            ['[01]', '1]'],
            ['[1 2]', '2]'],
            ['{"a": tru}', 'tru}'],
            ['"bad \\x escape"', 'x escape'],
            ['"\\u12G4"', 'G4"'],
            ['{} {}', '{}'],
            ['[-]', '-]'],
        ];
        for (const [text, from] of cases) {
            expect(() => JSON.parse(text)).toThrow();
            expect(jsonErrorOffset(text), text).toBe(text.lastIndexOf(from));
        }
        // Ending too soon: placed at the end.
        expect(jsonErrorOffset('{"a": [1, 2')).toBe(11);
        expect(jsonErrorOffset('"open')).toBe(5);
        expect(jsonErrorOffset('')).toBe(0);
    });
});
