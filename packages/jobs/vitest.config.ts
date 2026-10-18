import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Real crypto and Postgres run several times slower on a loaded CI runner than here; a
        // test that takes 1 s locally has hit 5.3 s there. Locally the default still flags slow tests.
        testTimeout: process.env.CI ? 30_000 : 5_000,
        include: ['src/**/*.test.ts'],
        passWithNoTests: true,
    },
});
