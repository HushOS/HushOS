import type { StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { languageFor } from '@/lib/highlight';

/*
 * The text editor's languages (docs/editing-design.md, "The editor"): CodeMirror's own
 * packages, Lezer grammars where there is one and its legacy modes otherwise, chosen by the
 * file's name as the viewer's colouring is (languageFor), plain text for anything else. Each
 * is its own chunk and comes in with the first file of its language; nothing here loads
 * with the drive.
 */

type Loader = () => Promise<Extension>;

const legacy = async (load: () => Promise<StreamParser<unknown>>) => {
    const [{ StreamLanguage }, parser] = await Promise.all([
        import('@codemirror/language'),
        load(),
    ]);
    return StreamLanguage.define(parser);
};

const LOADERS: Record<string, Loader> = {
    javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
    jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
    typescript: async () =>
        (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
    tsx: async () =>
        (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
    json: async () => (await import('@codemirror/lang-json')).json(),
    jsonc: async () => (await import('@codemirror/lang-json')).json(),
    yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
    toml: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
    markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
    html: async () => (await import('@codemirror/lang-html')).html(),
    css: async () => (await import('@codemirror/lang-css')).css(),
    scss: async () => (await import('@codemirror/lang-css')).css(),
    xml: async () => (await import('@codemirror/lang-xml')).xml(),
    svg: async () => (await import('@codemirror/lang-xml')).xml(),
    python: async () => (await import('@codemirror/lang-python')).python(),
    rust: async () => (await import('@codemirror/lang-rust')).rust(),
    go: async () => (await import('@codemirror/lang-go')).go(),
    java: async () => (await import('@codemirror/lang-java')).java(),
    kotlin: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
    swift: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
    c: async () => (await import('@codemirror/lang-cpp')).cpp(),
    cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
    sql: async () => (await import('@codemirror/lang-sql')).sql(),
    shellscript: () =>
        legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
    ini: () =>
        legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
    properties: () =>
        legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
    dockerfile: () =>
        legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
    diff: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
};

/*
 * Every language at once, for the post-unlock preload (lib/preload.ts): fetched for whatever file
 * is opened later, so which grammar a device fetched never says what kind of file was edited.
 */
export async function preloadLanguages() {
    for (const load of Object.values(LOADERS)) await load().catch(() => {});
}

/*
 * Every grammar, all at once and in one fixed order, once per page: what the editor asks for
 * before its file's own grammar (loadLanguage). An Edit pressed before the post-unlock preload
 * reached the grammars then fetches all of them, never the one that names the file's language.
 */
let everyLanguage: Promise<void> | null = null;
export function allLanguages() {
    everyLanguage ??= Promise.all(
        Object.values(LOADERS).map((load) => load().catch(() => {})),
    ).then(() => {});
    return everyLanguage;
}

/* Names the viewer's colouring has no grammar for that the editor still colours. */
const EDITOR_ONLY: Record<string, string> = { properties: 'properties' };

/* The editor's language for a file name, or null for plain text. */
export function editorLanguage(name: string) {
    const extension = name.toLowerCase().split('.').pop() ?? '';
    const language =
        languageFor(name) ?? (name.includes('.') ? (EDITOR_ONLY[extension] ?? null) : null);
    return language && LOADERS[language] ? language : null;
}

/* The language's extension, loaded; plain text (no extension) when it fails to load. */
export async function loadLanguage(language: string | null): Promise<Extension> {
    const loader = language ? LOADERS[language] : undefined;
    if (!loader) return [];
    // Never this grammar alone: the whole set first (allLanguages), whatever the file is.
    await allLanguages();
    try {
        return await loader();
    } catch {
        return [];
    }
}

/*
 * Soft wrap: on for prose (Markdown and plain text, CSV included), off for code, where a
 * wrapped line hides its indentation.
 */
export function wrapsLines(language: string | null) {
    return language === null || language === 'markdown';
}
