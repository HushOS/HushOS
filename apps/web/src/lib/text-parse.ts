/*
 * The structured-text check beside Save (docs/editing-design.md, "Structured
 * text"): JSON, YAML, TOML and XML that no longer parse get a warning naming
 * the first line that fails. It never refuses a save. Loaded with the editor,
 * never with the drive; YAML's and TOML's parsers come in only for those files.
 */

export type StructuredKind = 'json' | 'yaml' | 'toml' | 'xml';

const NAMES: Record<StructuredKind, string> = {
    json: 'JSON',
    yaml: 'YAML',
    toml: 'TOML',
    xml: 'XML',
};

/* The YAML and TOML parsers, for the post-unlock preload: fetched whether or not such a file is edited. */
export async function preloadParsers() {
    await Promise.all([import('yaml'), import('smol-toml')]);
}

/* Which check a file gets, from the editor's language for it; null for anything else (JSONC included). */
export function structuredKind(language: string | null): StructuredKind | null {
    if (language === 'json') return 'json';
    if (language === 'yaml') return 'yaml';
    if (language === 'toml') return 'toml';
    if (language === 'xml' || language === 'svg') return 'xml';
    return null;
}

/* The warning's words: "This YAML doesn’t parse at line 14." */
export function parseWarning(kind: StructuredKind, line: number | null) {
    return line === null
        ? `This ${NAMES[kind]} doesn’t parse.`
        : `This ${NAMES[kind]} doesn’t parse at line ${line}.`;
}

/* The line an offset into `text` falls on, counting from 1. */
export function lineAt(text: string, offset: number) {
    let line = 1;
    const end = Math.min(Math.max(offset, 0), text.length);
    for (let at = text.indexOf('\n'); at !== -1 && at < end; at = text.indexOf('\n', at + 1))
        line++;
    return line;
}

/*
 * Where JSON.parse gave up: engines say it differently ("at position 12",
 * "(line 3 column 5)", "at line 3 column 5"), and some not at all.
 */
function jsonLine(text: string, message: string) {
    const line = /line (\d+)/i.exec(message);
    if (line) return Number(line[1]);
    const position = /position (\d+)/i.exec(message);
    if (position) return lineAt(text, Number(position[1]));
    return null;
}

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
            try {
                JSON.parse(text);
                return null;
            } catch (error) {
                return { line: jsonLine(text, error instanceof Error ? error.message : '') };
            }
        case 'yaml': {
            const { parseAllDocuments } = await import('yaml');
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
        }
        case 'toml': {
            const { parse, TomlError } = await import('smol-toml');
            try {
                parse(text);
                return null;
            } catch (error) {
                return { line: error instanceof TomlError ? error.line : null };
            }
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
