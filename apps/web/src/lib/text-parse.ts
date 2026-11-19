/*
 * The structured-text check beside Save (docs/editing-design.md, "Structured
 * text"): JSON, YAML, TOML and XML that no longer parse get a warning naming
 * the first line that fails. It never refuses a save. The editor runs it through
 * lib/text-check.ts (a worker for JSON, YAML and TOML); this is the check itself.
 */

export type StructuredKind = 'json' | 'yaml' | 'toml' | 'xml';

const NAMES: Record<StructuredKind, string> = {
    json: 'JSON',
    yaml: 'YAML',
    toml: 'TOML',
    xml: 'XML',
};

/*
 * The parsers and the check worker, for the post-unlock preload: fetched whether or not such a
 * file is edited (lib/text-check.ts runs the checks in the worker).
 */
let parsers: Promise<void> | null = null;
export function preloadParsers() {
    // Once a page: the editor asks for it too, for whatever file it opens (text-editor.tsx editorAssets).
    parsers ??= (async () => {
        await import('@/lib/text-parse-data');
        (await import('@/lib/text-check')).preloadCheckWorker();
    })().catch(() => {});
    return parsers;
}

/* Which check a file gets, from the editor's language for it; null for anything else (JSONC included). */
export function structuredKind(language: string | null): StructuredKind | null {
    if (language === 'json') return 'json';
    if (language === 'yaml') return 'yaml';
    if (language === 'toml') return 'toml';
    if (language === 'xml' || language === 'svg') return 'xml';
    return null;
}

/* Recorded types that name a structured format, for a file whose name gives no language. */
const BY_TYPE: Record<string, StructuredKind> = {
    'application/json': 'json',
    'text/json': 'json',
    'application/yaml': 'yaml',
    'application/x-yaml': 'yaml',
    'text/yaml': 'yaml',
    'text/x-yaml': 'yaml',
    'application/toml': 'toml',
    'text/toml': 'toml',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/svg+xml': 'xml',
};

/*
 * Which check a file gets: by its name's language, or, when the name gives none (an extensionless
 * file), by the type its row records ("application/json; charset=utf-8" included).
 */
export function structuredKindOf(language: string | null, mime: string | null | undefined) {
    const named = structuredKind(language);
    if (named || language !== null) return named;
    const type = mime?.split(';')[0]?.trim().toLowerCase();
    return (type && BY_TYPE[type]) || null;
}

/* The warning's words: "This YAML doesn’t parse at line 14." */
export function parseWarning(kind: StructuredKind, line: number | null) {
    return line === null
        ? `This ${NAMES[kind]} doesn’t parse.`
        : `This ${NAMES[kind]} doesn’t parse at line ${line}.`;
}

export { lineAt } from '@/lib/text-lines';

/*
 * The first line that fails to parse, or null when the text parses. Whatever
 * the parser throws is a failure here, never a crash of the editor.
 */
export async function parseFailure(
    kind: StructuredKind,
    text: string,
): Promise<{ line: number | null } | null> {
    switch (kind) {
        case 'json':
        case 'yaml':
        case 'toml': {
            // The parsers bundled with the check worker's code (lib/text-parse-data.ts).
            const { dataFailure } = await import('@/lib/text-parse-data');
            return dataFailure(kind, text);
        }
        case 'xml': {
            // Parsed as data, never rendered: DOMParser's XML documents run no script and fetch nothing.
            const parser = new DOMParser();
            const parsed = parser.parseFromString(text, 'application/xml');
            // The browser's own error element, told apart from a document's <parsererror> by its
            // namespace (each engine has its own), learnt from a string that never parses.
            const namespace =
                parser
                    .parseFromString('<', 'application/xml')
                    .getElementsByTagName('parsererror')[0]?.namespaceURI ?? null;
            const failure = parsed.getElementsByTagNameNS(namespace ?? '*', 'parsererror')[0];
            if (!failure) return null;
            const words = failure.textContent ?? '';
            const line = /line (?:number )?(\d+)/i.exec(words);
            return { line: line ? Number(line[1]) : null };
        }
    }
}
