import evlog from '@hushos/logging/nitro';
import { loggingOptions } from '@hushos/logging';
import { defineConfig } from 'nitro';

export default defineConfig({
    preset: 'bun',
    traceDeps: [
        // Elysia loads these through runtime require(), outside the bundler's import graph.
        'typebox*',
        'exact-mirror*',
        // Kept out of the bundle (vite.config.ts, `ssr.external`) and copied beside it with all it
        // needs: bundled, tsyringe ran before the polyfill it checks for, and the server's
        // shared chunk threw as it loaded. scripts/check-server-deps.ts fails a build that
        // bundles it again or leaves it out.
        '@simplewebauthn/server',
    ],
    experimental: { asyncContext: true },
    // Listed one by one: Nitro doesn't scan server/ unless serverDir is set.
    plugins: [
        './server/plugins/environment.ts',
        './server/plugins/request-context.ts',
        './server/plugins/security-headers.ts',
        './server/plugins/database.ts',
    ],
    modules: [evlog(loggingOptions)],
});
