import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import rehypeSlug from 'rehype-slug';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        host: '0.0.0.0',
        port: Number(process.env.PORT ?? 5173),
        // Development is intentionally reachable through LAN and Tailscale hostnames.
        allowedHosts: true,
    },
    resolve: { tsconfigPaths: true },
    plugins: [
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
