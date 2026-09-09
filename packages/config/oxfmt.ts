import { defineConfig } from 'oxfmt';

export default defineConfig({
    printWidth: 100,
    tabWidth: 4,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    ignorePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.output/**',
        '**/.nitro/**',
        '**/.tanstack/**',
        '**/.turbo/**',
        '**/routeTree.gen.ts',
        '**/src/rendered/**',
        'bun.lock',
    ],
});
