import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        globalSetup: ['./test/global-setup.ts'],
        setupFiles: ['../db/test/setup.ts'],
        fileParallelism: false,
        passWithNoTests: true,
    },
});
