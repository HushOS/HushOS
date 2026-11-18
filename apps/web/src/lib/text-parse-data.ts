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

/* The first line that fails to parse, or null when the text parses; whatever a parser throws is a failure. */
export function dataFailure(kind: DataKind, text: string): { line: number | null } | null {
    switch (kind) {
        case 'json':
            try {
                JSON.parse(text);
                return null;
            } catch (error) {
                return { line: jsonLine(text, error instanceof Error ? error.message : '') };
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
