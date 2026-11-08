import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Real crypto and Postgres run several times slower on a loaded CI runner than here; a
// test that takes 1 s locally has hit 5.3 s there. Locally the default still flags slow tests.
const testTimeout = process.env.CI ? 30_000 : 5_000;

export default defineConfig({
    resolve: { tsconfigPaths: true },
    plugins: [react()],
    test: {
        passWithNoTests: true,
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    testTimeout,
                    environment: 'jsdom',
                    setupFiles: ['./src/test/setup.ts'],
                    include: [
                        'src/**/*.test.{ts,tsx}',
                        'src/**/*.spec.{ts,tsx}',
                        'server/**/*.test.ts',
                    ],
                    exclude: ['src/**/*.db.test.ts'],
                    restoreMocks: true,
                },
            },
            {
                // Routes run against a migrated Postgres of their own (`<base>_test_web`), for
                // what only real rows show: the types raw SQL hands back to a response schema.
                extends: true,
                test: {
                    name: 'db',
                    testTimeout,
                    environment: 'node',
                    include: ['src/**/*.db.test.ts'],
                    globalSetup: ['./src/test/db-setup.ts'],
                    setupFiles: ['../../packages/db/test/setup.ts'],
                    fileParallelism: false,
                    restoreMocks: true,
                },
            },
        ],
    },
});
