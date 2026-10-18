import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    plugins: [react()],
    test: {
        // Real crypto and Postgres run several times slower on a loaded CI runner than here; a
        // test that takes 1 s locally has hit 5.3 s there. Locally the default still flags slow tests.
        testTimeout: process.env.CI ? 30_000 : 5_000,
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}', 'server/**/*.test.ts'],
        passWithNoTests: true,
        restoreMocks: true,
    },
});
