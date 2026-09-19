import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig, type Plugin } from 'vite';

/*
 * `foo.mdx?meta` is the document's frontmatter alone. A route's `head()` runs in
 * the shared bundle, so reading the title through the compiled document would
 * ship every page's body to every visitor; this keeps the body in the page's
 * own chunk. The build runs on Bun, so its YAML parser does the reading.
 */
function mdxMeta(): Plugin {
    const suffix = '.mdx?meta';
    const prefix = '\0mdx-meta:';
    return {
        name: 'hushos:mdx-meta',
        enforce: 'pre',
        async resolveId(source, importer) {
            if (!source.endsWith(suffix)) return null;
            const resolved = await this.resolve(source.slice(0, -5), importer, { skipSelf: true });
            // A virtual id, so the MDX compiler's own filter leaves the module alone.
            return resolved ? prefix + resolved.id : null;
        },
        async load(id) {
            if (!id.startsWith(prefix)) return null;
            const file = id.slice(prefix.length);
            this.addWatchFile(file);
            const text = await Bun.file(file).text();
            const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
            const frontmatter = block ? Bun.YAML.parse(block[1] ?? '') : {};
            return `export const frontmatter = ${JSON.stringify(frontmatter)};`;
        },
    };
}

export default defineConfig({
    server: {
        host: '0.0.0.0',
        port: Number(process.env.PORT ?? 5173),
        // IP addresses are allowed by default; this adds Tailscale hostnames.
        allowedHosts: ['.ts.net'],
    },
    resolve: { tsconfigPaths: true },
    optimizeDeps: {
        // Pre-bundle what the viewer loads lazily (highlighter, grammars, PDF,
        // video demuxing), so a cold dev server does not discover them on the
        // first preview and reload the page under the person.
        include: [
            'shiki/core',
            'shiki/engine/javascript',
            '@shikijs/themes/github-light-default',
            '@shikijs/themes/github-dark-default',
            '@shikijs/langs/*',
            'pdfjs-dist',
            'mediabunny',
            'mammoth',
            'xlsx',
            'fflate',
            'hast-util-from-html',
            'hast-util-sanitize',
        ],
    },
    plugins: [
        mdxMeta(),
        {
            // MDX compiles to React components at build time, so legal pages and
            // posts server-render like any other route and can embed components.
            enforce: 'pre',
            ...mdx({
                // Only .mdx: DESIGN.md is imported as raw text and must not be compiled.
                include: /\.mdx$/,
                remarkPlugins: [
                    remarkGfm,
                    remarkFrontmatter,
                    [remarkMdxFrontmatter, { name: 'frontmatter' }],
                ],
                rehypePlugins: [rehypeSlug],
                providerImportSource: '@mdx-js/react',
            }),
        },
        tailwindcss(),
        tanstackStart(),
        nitro(),
        react({ include: /\.(mdx|js|jsx|ts|tsx)$/ }),
    ],
});
