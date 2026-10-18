/*
 * JSON for the viewer: why a file isn't valid and where, the same text laid
 * out with two-space indents, and the path to a value. Pure and free of
 * imports, so the JSON worker bundles this file and nothing else.
 */

export type JsonProblem = {
    /* The browser's reason, without its position: "expected ',' or '}' after property value". */
    reason: string;
    /* 1-based; null where neither the browser nor the scan could place it. */
    line: number | null;
    column: number | null;
    /* The UTF-16 offset of that place, for marking it in a laid-out copy. */
    offset: number | null;
};

export type JsonInspection =
    | ({ ok: true } & JsonLayout)
    | {
          ok: false;
          problem: JsonProblem;
          /* A file with lines too long to draw, laid out anyway, with the problem's line in the layout. */
          layout: { text: string; line: number | null } | null;
      };

/* A line longer than this is laid out before it is shown: browsers can't draw a line of megabytes. */
const LONG_LINE = 10_000;

/* Validates with the browser's parser, and lays the text out again when it is valid. */
export function inspectJson(text: string): JsonInspection {
    try {
        JSON.parse(text);
    } catch (error) {
        // An engine whose parser recurses can run out of stack on JSON that is merely deep; the
        // scan, which doesn't recurse, says whether the grammar really broke.
        if (!(error instanceof RangeError) || errorOffset(text) !== -1) {
            const problem = describeParseError(error, text);
            return { ok: false, problem, layout: hasLongLine(text) ? layOut(text, problem) : null };
        }
    }
    return { ok: true, ...formatJson(text) };
}

function hasLongLine(text: string) {
    let start = 0;
    for (let end = text.indexOf('\n'); ; end = text.indexOf('\n', start)) {
        if ((end === -1 ? text.length : end) - start > LONG_LINE) return true;
        if (end === -1) return false;
        start = end + 1;
    }
}

function layOut(text: string, problem: JsonProblem) {
    const { pretty, markAt } = formatJson(text, problem.offset ?? undefined);
    return { text: pretty, line: markAt === null ? null : lineColumn(pretty, markAt).line };
}

/*
 * The reason and place a JSON.parse error names. Chrome gives an offset ("at
 * position 42"), Firefox a line and column, Safari nothing; Chrome also drops
 * the offset for an unexpected token and at the end of the input. Where the
 * browser gives no place, a scan finds the first character the grammar can't
 * take, which is where every engine stops.
 */
export function describeParseError(error: unknown, text: string): JsonProblem {
    const message = error instanceof Error ? error.message : String(error);
    const reason = reasonOf(message);
    const firefox = /at line (\d+) column (\d+)/.exec(message);
    if (firefox) {
        const line = Number(firefox[1]);
        const column = Number(firefox[2]);
        return { reason, line, column, offset: offsetOf(text, line, column) };
    }
    const chrome = /at position (\d+)/.exec(message);
    const found = chrome ? Number(chrome[1]) : errorOffset(text);
    if (found < 0) return { reason, line: null, column: null, offset: null };
    // Past the last character means the text ended too soon: point just after what is there.
    const offset = Math.min(found, contentEnd(text));
    return { reason, ...lineColumn(text, offset), offset };
}

/* The offset of a 1-based line and column, counting the column in UTF-16 units. */
function offsetOf(text: string, line: number, column: number) {
    let start = 0;
    for (let at = 1; at < line; at++) {
        const end = text.indexOf('\n', start);
        if (end === -1) break;
        start = end + 1;
    }
    return Math.min(text.length, start + Math.max(0, column - 1));
}

function reasonOf(message: string) {
    const reason = message
        .replace(/^JSON\.parse: /, '')
        .replace(/^JSON Parse error: /, '')
        .replace(/ at line \d+ column \d+ of the JSON data$/, '')
        .replace(/,\s*(\.\.\.)?".*"(\.\.\.)? is not valid JSON$/s, '')
        .replace(/ (?:in|after) JSON at position \d+.*$/s, '')
        .trim();
    if (!reason) return 'it ends too soon';
    // "Unexpected end" reads as part of the sentence it follows; "JSON" keeps its capitals.
    return /^[A-Z][a-z]/.test(reason) ? reason[0]!.toLowerCase() + reason.slice(1) : reason;
}

/* The end of the text before any trailing JSON whitespace. */
function contentEnd(text: string) {
    let end = text.length;
    while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
    return end;
}

function isSpace(code: number) {
    return code === 32 || code === 10 || code === 13 || code === 9;
}

/*
 * The 1-based line and column of a UTF-16 offset, as the viewer numbers them:
 * lines end at a line feed (CRLF counts once, its CR closing the line before),
 * and a column counts characters, so an emoji is one.
 */
export function lineColumn(text: string, offset: number) {
    const at = Math.max(0, Math.min(offset, text.length));
    let line = 1;
    let start = 0;
    for (let found = text.indexOf('\n'); found !== -1 && found < at;) {
        line++;
        start = found + 1;
        found = text.indexOf('\n', start);
    }
    let column = 1;
    for (let index = start; index < at; index++) {
        const code = text.charCodeAt(index);
        // The low half of a surrogate pair belongs to the character before it.
        if (code >= 0xdc00 && code <= 0xdfff && index > start) {
            const before = text.charCodeAt(index - 1);
            if (before >= 0xd800 && before <= 0xdbff) continue;
        }
        column++;
    }
    return { line, column };
}

/*
 * The offset of the first character the JSON grammar can't accept, or -1 when
 * the text is valid. Only locates: JSON.parse decides validity.
 */
export function errorOffset(text: string): number {
    const n = text.length;
    // true for an object, false for an array.
    const stack: boolean[] = [];
    let state: 'value' | 'first-value' | 'after' | 'key' | 'first-key' | 'colon' = 'value';
    let i = 0;
    for (;;) {
        while (i < n && isSpace(text.charCodeAt(i))) i++;
        if (i >= n) return state === 'after' && stack.length === 0 ? -1 : n;
        const c = text[i]!;
        if (state === 'value' || state === 'first-value') {
            if (c === ']' && state === 'first-value') {
                stack.pop();
                i++;
                state = 'after';
            } else if (c === '{') {
                stack.push(true);
                i++;
                state = 'first-key';
            } else if (c === '[') {
                stack.push(false);
                i++;
                state = 'first-value';
            } else {
                const end = scalarEnd(text, i);
                if (end < 0) return ~end;
                i = end;
                state = 'after';
            }
        } else if (state === 'after') {
            if (stack.length === 0) return i;
            const object = stack[stack.length - 1]!;
            if (c === ',') {
                i++;
                state = object ? 'key' : 'value';
            } else if (c === (object ? '}' : ']')) {
                stack.pop();
                i++;
            } else return i;
        } else if (state === 'key' || state === 'first-key') {
            if (c === '}' && state === 'first-key') {
                stack.pop();
                i++;
                state = 'after';
            } else if (c === '"') {
                const end = stringEnd(text, i);
                if (end < 0) return ~end;
                i = end;
                state = 'colon';
            } else return i;
        } else {
            if (c !== ':') return i;
            i++;
            state = 'value';
        }
    }
}

/* The end of the string, number or literal at `i`, or ~offset of the character that breaks it. */
function scalarEnd(text: string, i: number): number {
    const c = text[i]!;
    if (c === '"') return stringEnd(text, i);
    if (c === '-' || (c >= '0' && c <= '9')) return numberEnd(text, i);
    for (const word of ['true', 'false', 'null']) {
        if (c !== word[0]) continue;
        for (let k = 1; k < word.length; k++) if (text[i + k] !== word[k]) return ~(i + k);
        return i + word.length;
    }
    return ~i;
}

function stringEnd(text: string, i: number): number {
    const n = text.length;
    for (let j = i + 1; j < n; j++) {
        const code = text.charCodeAt(j);
        if (code === 34) return j + 1;
        if (code < 0x20) return ~j;
        if (code !== 92) continue;
        const escape = text[j + 1];
        if (escape === undefined) return ~n;
        if (escape === 'u') {
            for (let k = 2; k < 6; k++)
                if (!/[0-9a-fA-F]/.test(text[j + k] ?? '')) return ~Math.min(j + k, n);
            j += 5;
        } else if ('"\\/bfnrt'.includes(escape)) j++;
        else return ~(j + 1);
    }
    return ~n;
}

function numberEnd(text: string, i: number): number {
    let j = i;
    const digit = () => j < text.length && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57;
    if (text[j] === '-') j++;
    if (text[j] === '0') j++;
    else if (digit()) while (digit()) j++;
    else return ~j;
    if (text[j] === '.') {
        j++;
        if (!digit()) return ~j;
        while (digit()) j++;
    }
    if (text[j] === 'e' || text[j] === 'E') {
        j++;
        if (text[j] === '+' || text[j] === '-') j++;
        if (!digit()) return ~j;
        while (digit()) j++;
    }
    return j;
}

const DELIMITER: boolean[] = [];
for (const c of ' \t\r\n,:{}[]"') DELIMITER[c.charCodeAt(0)] = true;

export type JsonLayout = {
    pretty: string;
    /* Every value, the top one included. */
    nodes: number;
    /* The deepest nesting of objects and arrays; the top value alone is 0. */
    depth: number;
    /* Whether some object names a key twice (as spelled), so a parsed value keeps only the last. */
    duplicates: boolean;
};

/*
 * JSON laid out with two-space indents, token by token from the text itself
 * rather than through JSON.stringify, so a number reads exactly as the file
 * wrote it (12345678901234567890 stays, 1.50 keeps its zero) and so do escapes
 * in strings. Counts what the tree needs to know on the way. Text that isn't
 * valid is laid out as far as it goes; `mark` asks where an offset of the
 * text lands in the layout.
 */
export function formatJson(text: string): JsonLayout;
export function formatJson(
    text: string,
    mark: number | undefined,
): JsonLayout & { markAt: number | null };
export function formatJson(text: string, mark?: number) {
    const n = text.length;
    const indents = [''];
    const indent = (depth: number) => (indents[depth] ??= '  '.repeat(depth));
    // Each open container: an object's keys so far, or null for an array.
    const keys: (Set<string> | null)[] = [];
    let out = '';
    let depth = 0;
    let deepest = 0;
    let nodes = 1;
    let duplicates = false;
    let markAt: number | null = null;
    let i = 0;
    while (i < n) {
        if (markAt === null && mark !== undefined && i >= mark) markAt = out.length;
        const c = text[i]!;
        const code = text.charCodeAt(i);
        if (isSpace(code)) {
            i++;
        } else if (c === '"') {
            const end = stringEnd(text, i);
            const stop = end < 0 ? n : end;
            const token = text.slice(i, stop);
            out += token;
            i = stop;
            const object = keys[keys.length - 1];
            if (object && !duplicates) {
                let next = i;
                while (next < n && isSpace(text.charCodeAt(next))) next++;
                if (text[next] === ':') {
                    if (object.has(token)) duplicates = true;
                    else object.add(token);
                }
            }
        } else if (c === '{' || c === '[') {
            let next = i + 1;
            while (next < n && isSpace(text.charCodeAt(next))) next++;
            if (text[next] === (c === '{' ? '}' : ']')) {
                out += c === '{' ? '{}' : '[]';
                i = next + 1;
                deepest = Math.max(deepest, depth + 1);
            } else {
                // A container with something in it holds one more value than it has commas.
                nodes++;
                depth++;
                deepest = Math.max(deepest, depth);
                keys.push(c === '{' ? new Set() : null);
                out += c + '\n' + indent(depth);
                i++;
            }
        } else if (c === '}' || c === ']') {
            depth = Math.max(0, depth - 1);
            keys.pop();
            out += '\n' + indent(depth) + c;
            i++;
        } else if (c === ',') {
            nodes++;
            out += ',\n' + indent(depth);
            i++;
        } else if (c === ':') {
            out += ': ';
            i++;
        } else {
            // A number or a literal runs to the next delimiter.
            let end = i + 1;
            while (end < n && !DELIMITER[text.charCodeAt(end)]) end++;
            out += text.slice(i, end);
            i = end;
        }
    }
    const layout = { pretty: out, nodes, depth: deepest, duplicates };
    if (mark === undefined) return layout;
    return { ...layout, markAt: markAt ?? out.length };
}

export type PathSegment = string | number;

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/*
 * A value's path as people write it in JavaScript: `items[3].name`, with keys
 * that aren't plain names quoted (`["first name"]`), and nothing for the top.
 */
export function jsonPath(segments: readonly PathSegment[]) {
    let out = '';
    for (const segment of segments) {
        if (typeof segment === 'number') out += `[${segment}]`;
        else if (IDENTIFIER.test(segment)) out += out ? `.${segment}` : segment;
        else out += `[${JSON.stringify(segment)}]`;
    }
    return out;
}
