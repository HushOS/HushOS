import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        globalSetup: ['./test/setup-db.ts'],
        setupFiles: ['./test/setup.ts'],
        fileParallelism: false,
        passWithNoTests: true,
    },
});
