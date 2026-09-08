import evlog from '@hushos/logging/nitro';
import { loggingOptions } from '@hushos/logging';
import { defineConfig } from 'nitro';

export default defineConfig({
    preset: 'bun',
    // Elysia loads these through runtime require(), outside the bundler's import graph.
    traceDeps: ['typebox*', 'exact-mirror*'],
    experimental: { asyncContext: true },
    plugins: ['./server/plugins/request-context.ts'],
    modules: [evlog(loggingOptions)],
});
