import { parse as parseToml, TomlError } from 'smol-toml';
import { parseAllDocuments } from 'yaml';
import { lineAt } from '@/lib/text-lines';

/*
 * The data formats' checks (JSON, YAML, TOML), synchronous and with their
 * parsers bundled in: run in the check worker (text-check.worker.ts), so a
 * large or pathological file never holds the page, and inline only for small
 * text where no worker can start (lib/text-check.ts).
 */

export type DataKind = 'json' | 'yaml' | 'toml';

/*
 * Where a JSON text first breaks the grammar (RFC 8259), by our own scan: the offset of the
 * character that can't go on (its length when the text ends too soon), or -1 when it parses.
 * Never read from the engine's message, which differs by engine and on some (JavaScriptCore)
 * names no place at all. Iterative, so nesting however deep never runs out of stack.
 */
export function jsonErrorOffset(text: string): number {
    const n = text.length;
    let i = 0;
    const space = () => {
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
            else break;
        }
    };
    // A string from its opening quote; false with `i` at the fault.
    const string = () => {
        i++;
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 0x22) {
                i++;
                return true;
            }
            if (c < 0x20) return false;
            if (c === 0x5c) {
                const escape = text[i + 1];
                if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
                    i += 2;
                    continue;
                }
                if (escape === 'u') {
                    for (let k = 2; k < 6; k++) {
                        if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) {
                            i += k;
                            return false;
                        }
                    }
                    i += 6;
                    continue;
                }
                i++;
                return false;
            }
            i++;
        }
        return false;
    };
    const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const number = () => {
        NUMBER.lastIndex = i;
        const found = NUMBER.exec(text);
        if (!found || found[0].length === 0) return false;
        i += found[0].length;
        return true;
    };
    const containers: ('{' | '[')[] = [];
    let expect: 'value' | 'key' | 'after' = 'value';
    for (;;) {
        space();
        if (expect === 'value') {
            const c = text[i];
            if (c === '{' || c === '[') {
                containers.push(c);
                i++;
                space();
                if (text[i] === (c === '{' ? '}' : ']')) {
                    containers.pop();
                    i++;
                    expect = 'after';
                } else expect = c === '{' ? 'key' : 'value';
                continue;
            }
            if (c === '"') {
                if (!string()) return i;
            } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
                if (!number()) return i;
            } else if (text.startsWith('true', i)) i += 4;
            else if (text.startsWith('false', i)) i += 5;
            else if (text.startsWith('null', i)) i += 4;
            else return i;
            expect = 'after';
            continue;
        }
        if (expect === 'key') {
            if (text[i] !== '"' || !string()) return i;
            space();
            if (text[i] !== ':') return i;
            i++;
            expect = 'value';
            continue;
        }
        const top = containers.at(-1);
        if (!top) return i < n ? i : -1;
        if (text[i] === ',') {
            i++;
            expect = top === '{' ? 'key' : 'value';
            continue;
        }
        if (text[i] === (top === '{' ? '}' : ']')) {
            containers.pop();
            i++;
            continue;
        }
        return i;
    }
}

/* The first line that fails to parse, or null when the text parses; whatever a parser throws is a failure. */
export function dataFailure(kind: DataKind, text: string): { line: number | null } | null {
    switch (kind) {
        case 'json':
            try {
                JSON.parse(text);
                return null;
            } catch {
                // The place from our own scan, whatever the engine's message says (or doesn't).
                const at = jsonErrorOffset(text);
                return { line: at < 0 ? null : lineAt(text, at) };
            }
        case 'yaml':
            try {
                for (const document of parseAllDocuments(text, { prettyErrors: true })) {
                    if (!('errors' in document)) continue;
                    const [first] = document.errors;
                    if (first) return { line: first.linePos?.[0].line ?? null };
                }
                return null;
            } catch {
                return { line: null };
            }
        case 'toml':
            try {
                parseToml(text);
                return null;
            } catch (error) {
                return { line: error instanceof TomlError ? error.line : null };
            }
    }
}
