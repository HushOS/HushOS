import { describe, expect, it, vi } from 'vitest';
import { describeParseError, formatJson, inspectJson, jsonPath } from '@/lib/json';

/* What this engine's JSON.parse throws for `text`. */
function thrown(text: string) {
    try {
        JSON.parse(text);
    } catch (error) {
        return error;
    }
    throw new Error('expected the text to be invalid');
}

describe('describeParseError', () => {
    it('places an unexpected token on the right line of a CRLF file, where the engine gives no offset', () => {
        const text =
            '{\r\n    "name": "x",\r\n    "items": [1, 2],\r\n    "ok": true,\r\n    "next": tru,\r\n}\r\n';
        const problem = describeParseError(thrown(text), text);
        expect(problem).toMatchObject({ line: 5, column: 16 });
        // The reason without the engine's quote of the file or its offset.
        expect(problem.reason).not.toMatch(/not valid JSON|position|tru,/);
    });

    it('counts an emoji before the error as one column, not two', () => {
        const text = '{"a": "😀😀", x}';
        expect(describeParseError(thrown(text), text)).toMatchObject({ line: 1, column: 13 });
    });

    it('points just after the last character when the file ends too soon, not at the blank lines after it', () => {
        const withOffset = '{"a": [1, 2\n\n';
        expect(describeParseError(thrown(withOffset), withOffset)).toMatchObject({
            line: 1,
            column: 12,
        });
        // Chrome names no offset at the very end of the input.
        const without = '{\n  "a":\n';
        expect(describeParseError(thrown(without), without)).toMatchObject({ line: 2, column: 7 });
    });

    it('is not misled by braces and escaped quotes inside strings', () => {
        const text = '{"a": "x\\"}", "b": }';
        expect(describeParseError(thrown(text), text)).toMatchObject({ line: 1, column: 20 });
    });

    it("reads Firefox's line and column and Safari's bare reason", () => {
        const firefox = new SyntaxError(
            "JSON.parse: expected ',' or '}' after property value in object at line 3 column 5 of the JSON data",
        );
        expect(describeParseError(firefox, '{\n"a": 1\n    "b": 2}')).toEqual({
            reason: "expected ',' or '}' after property value in object",
            line: 3,
            column: 5,
            offset: 13,
        });
        const safari = new SyntaxError('JSON Parse error: Unexpected identifier "tru"');
        expect(describeParseError(safari, '[1,\n tru]')).toEqual({
            reason: 'unexpected identifier "tru"',
            line: 2,
            column: 5,
            offset: 8,
        });
    });

    it("drops Chrome's offset from a reason that ends 'after JSON at position'", () => {
        const text = '{"a": 1} x';
        const problem = describeParseError(thrown(text), text);
        expect(problem).toMatchObject({ line: 1, column: 10 });
        expect(problem.reason).not.toMatch(/position|line \d/);
    });
});

describe('formatJson', () => {
    it('keeps numbers and escapes exactly as the file wrote them', () => {
        const text = '{"n":12345678901234567890,"f":1.50,"z":-0,"s":"\\u00e9\\"{,"}';
        expect(formatJson(text).pretty).toBe(
            '{\n  "n": 12345678901234567890,\n  "f": 1.50,\n  "z": -0,\n  "s": "\\u00e9\\"{,"\n}',
        );
    });

    it('lays out like JSON.stringify with two spaces, empty containers included', () => {
        const text =
            '{ "a" : [ ], "b":{\r\n}, "c":[1,{"d":[true,null,"x"]}], "e": "😀", "f": {"g": {"h": []}} }';
        expect(formatJson(text).pretty).toBe(JSON.stringify(JSON.parse(text), null, 2));
    });

    it('counts every value, empty containers once and commas in strings never', () => {
        // root, a, 1, 2, {}, b
        expect(formatJson('{"a":[1,2,{}],"b":"x,y"}').nodes).toBe(6);
        expect(formatJson('[]').nodes).toBe(1);
    });

    it('measures nesting, an empty container included', () => {
        expect(formatJson('[1]').depth).toBe(1);
        expect(formatJson('{"a":[[]]}').depth).toBe(3);
        expect(formatJson('"x"').depth).toBe(0);
        const deep = `${'['.repeat(3000)}${']'.repeat(3000)}`;
        expect(formatJson(deep).depth).toBe(3000);
    });

    it('notices a key repeated within one object, and only within one', () => {
        expect(formatJson('{"a":1,"a":2}').duplicates).toBe(true);
        expect(formatJson('{"a":1,"b":{"a":2}}').duplicates).toBe(false);
        expect(formatJson('[{"a":1},{"a":2}]').duplicates).toBe(false);
        // A value that happens to equal a key is not a key.
        expect(formatJson('{"a":"a","b":["a"]}').duplicates).toBe(false);
    });
});

describe('inspectJson', () => {
    it('says why a file is invalid instead of laying it out', () => {
        expect(inspectJson('{"a": 1,}')).toMatchObject({
            ok: false,
            problem: { line: 1, column: 9 },
        });
        expect(inspectJson('[1]')).toEqual({
            ok: true,
            pretty: '[\n  1\n]',
            nodes: 2,
            depth: 1,
            duplicates: false,
        });
    });

    it('lays out an invalid file whose line is too long to draw, and marks the problem in the layout', () => {
        const items = Array.from({ length: 2000 }, (_, i) => `{"id":${i}}`);
        items.splice(1500, 0, '{"id":tru}');
        const text = `{"items":[${items.join(',')}]}`;
        const result = inspectJson(text);
        if (result.ok || !result.layout) throw new Error('expected a laid-out invalid file');
        expect(result.problem.line).toBe(1);
        const marked = result.layout.text.split('\n')[result.layout.line! - 1];
        expect(marked).toContain('tru');
        // A file with short lines is shown as written.
        expect(inspectJson('{\n"a": tru\n}')).toMatchObject({ ok: false, layout: null });
    });

    it('treats running out of stack on valid JSON as deep, not invalid', () => {
        // Safari's parser recurses where Chrome's doesn't; this is what it throws.
        const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
            throw new RangeError('Maximum call stack size exceeded.');
        });
        expect(inspectJson('[[[1]]]')).toMatchObject({ ok: true, depth: 3 });
        expect(inspectJson('[[[1]]')).toMatchObject({ ok: false });
        parse.mockRestore();
    });
});

describe('jsonPath', () => {
    it('writes paths the way JavaScript reads them', () => {
        expect(jsonPath(['items', 3, 'name'])).toBe('items[3].name');
        expect(jsonPath([0, 'first name'])).toBe('[0]["first name"]');
        expect(jsonPath(['café', 'a.b', '', '2x', 'say "hi"'])).toBe(
            'café["a.b"][""]["2x"]["say \\"hi\\""]',
        );
        expect(jsonPath(['$ok', '_x'])).toBe('$ok._x');
    });
});
