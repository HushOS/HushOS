import type { Root } from 'hast';
import type { HighlighterCore, LanguageRegistration } from 'shiki/core';

/*
 * Syntax highlighting for the viewer, loaded the first time a file needs it and
 * never on page load. Shiki runs its grammars on the JavaScript regex engine,
 * so there is no WebAssembly to fetch; each grammar is its own chunk and comes
 * in when a file of that language is opened. Output is a syntax tree the viewer
 * renders as elements, never HTML strings.
 */

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

/* Grammars we ship, by Shiki language id; anything else previews as plain text. */
const LANGUAGES: Record<string, LanguageLoader> = {
    typescript: () => import('@shikijs/langs/typescript'),
    tsx: () => import('@shikijs/langs/tsx'),
    javascript: () => import('@shikijs/langs/javascript'),
    jsx: () => import('@shikijs/langs/jsx'),
    json: () => import('@shikijs/langs/json'),
    jsonc: () => import('@shikijs/langs/jsonc'),
    css: () => import('@shikijs/langs/css'),
    scss: () => import('@shikijs/langs/scss'),
    html: () => import('@shikijs/langs/html'),
    xml: () => import('@shikijs/langs/xml'),
    svg: () => import('@shikijs/langs/xml'),
    yaml: () => import('@shikijs/langs/yaml'),
    toml: () => import('@shikijs/langs/toml'),
    ini: () => import('@shikijs/langs/ini'),
    markdown: () => import('@shikijs/langs/markdown'),
    shellscript: () => import('@shikijs/langs/shellscript'),
    python: () => import('@shikijs/langs/python'),
    ruby: () => import('@shikijs/langs/ruby'),
    rust: () => import('@shikijs/langs/rust'),
    go: () => import('@shikijs/langs/go'),
    java: () => import('@shikijs/langs/java'),
    kotlin: () => import('@shikijs/langs/kotlin'),
    swift: () => import('@shikijs/langs/swift'),
    c: () => import('@shikijs/langs/c'),
    cpp: () => import('@shikijs/langs/cpp'),
    csharp: () => import('@shikijs/langs/csharp'),
    php: () => import('@shikijs/langs/php'),
    sql: () => import('@shikijs/langs/sql'),
    graphql: () => import('@shikijs/langs/graphql'),
    dockerfile: () => import('@shikijs/langs/dockerfile'),
    makefile: () => import('@shikijs/langs/makefile'),
    diff: () => import('@shikijs/langs/diff'),
    lua: () => import('@shikijs/langs/lua'),
    dart: () => import('@shikijs/langs/dart'),
    elixir: () => import('@shikijs/langs/elixir'),
    haskell: () => import('@shikijs/langs/haskell'),
    zig: () => import('@shikijs/langs/zig'),
    r: () => import('@shikijs/langs/r'),
    tex: () => import('@shikijs/langs/latex'),
    nix: () => import('@shikijs/langs/nix'),
    powershell: () => import('@shikijs/langs/powershell'),
    csv: () => import('@shikijs/langs/csv'),
};

/* File extension (or exact file name) to language id. */
const BY_EXTENSION: Record<string, string> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'jsx',
    json: 'json',
    jsonc: 'jsonc',
    json5: 'jsonc',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'svg',
    plist: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    env: 'ini',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    fish: 'shellscript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    cs: 'csharp',
    php: 'php',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    mk: 'makefile',
    diff: 'diff',
    patch: 'diff',
    lua: 'lua',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    hs: 'haskell',
    zig: 'zig',
    r: 'r',
    tex: 'tex',
    nix: 'nix',
    ps1: 'powershell',
    csv: 'csv',
    tsv: 'csv',
};
const BY_NAME: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    '.gitignore': 'ini',
    '.gitattributes': 'ini',
    '.editorconfig': 'ini',
    '.env': 'ini',
    '.npmrc': 'ini',
};

/* The language a file name highlights as, or null for plain text. */
export function languageFor(name: string): string | null {
    const lower = name.toLowerCase();
    const named = BY_NAME[lower];
    if (named) return named;
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return null;
    const extension = lower.slice(dot + 1);
    return BY_EXTENSION[extension] ?? null;
}

export const HIGHLIGHT_LIMIT = 512 * 1024;

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function highlighter() {
    core ??= (async () => {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
            await Promise.all([
                import('shiki/core'),
                import('shiki/engine/javascript'),
                import('@shikijs/themes/github-light-default'),
                import('@shikijs/themes/github-dark-default'),
            ]);
        return createHighlighterCore({
            themes: [light.default, dark.default],
            langs: [],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
    })();
    return core;
}

async function ensureLanguage(language: string) {
    if (loaded.has(language)) return;
    let pending = loading.get(language);
    if (!pending) {
        pending = (async () => {
            const loader = LANGUAGES[language];
            if (!loader) throw new Error(`No grammar for ${language}.`);
            const [instance, grammar] = await Promise.all([highlighter(), loader()]);
            await instance.loadLanguage(...grammar.default);
            loaded.add(language);
        })().finally(() => loading.delete(language));
        loading.set(language, pending);
    }
    await pending;
}

/*
 * Highlights code to a syntax tree with both themes in place: each token
 * carries `--shiki-light` and `--shiki-dark`, and the stylesheet picks one with
 * `light-dark()`, so the page's theme applies without re-highlighting.
 */
export async function highlight(code: string, language: string): Promise<Root> {
    if (!LANGUAGES[language]) throw new Error(`No grammar for ${language}.`);
    await ensureLanguage(language);
    const instance = await highlighter();
    return instance.codeToHast(code, {
        lang: language,
        themes: { light: 'github-light-default', dark: 'github-dark-default' },
        defaultColor: false,
        cssVariablePrefix: '--shiki-',
    });
}

export function canHighlight(language: string | null): language is string {
    return language !== null && language in LANGUAGES;
}
