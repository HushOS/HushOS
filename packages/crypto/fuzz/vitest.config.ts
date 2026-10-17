import { defineConfig } from 'vitest/config';

/*
 * The differential test (`bun run fuzz:diff`), apart from `bun run test`: it
 * needs the core's verdicts binary built with cargo, and runs for minutes.
 */
export default defineConfig({
    test: {
        include: ['fuzz/**/*.test.ts'],
        fileParallelism: false,
    },
});
