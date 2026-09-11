import { defineConfig } from 'vitest/config';

/* One entry for editors and `bun x vitest` at the root; Turbo still runs each package's own config. */
export default defineConfig({
    test: {
        projects: ['packages/*/vitest.config.ts', 'apps/web/vitest.config.ts'],
    },
});
