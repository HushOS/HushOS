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
        // The same for the AWS SDK (storage in packages/drive, email in packages/emails): bundled,
        // its CommonJS wrappers were split across two server chunks that import each other, one
        // called require_schema before the other had defined it, and every request answered 500.
        '@aws-sdk/client-s3',
        '@aws-sdk/client-sesv2',
        '@aws-sdk/s3-request-presigner',
    ],
    experimental: { asyncContext: true },
    // Every server module runs in source order, whatever chunk it lands in. Without it the
    // bundler split the server into chunks that import each other, and one built its link-token
    // header schema before the other had set the header's name: the schema asked for a header
    // named "undefined", and every link visitor got 400 in the built server only. Any constant
    // read at a module's top level across such a split (a schema's limits) was exposed the same way.
    rolldownConfig: { output: { strictExecutionOrder: true } },
    // Listed one by one: Nitro doesn't scan server/ unless serverDir is set.
    plugins: [
        './server/plugins/environment.ts',
        './server/plugins/request-context.ts',
        './server/plugins/security-headers.ts',
        './server/plugins/database.ts',
    ],
    modules: [evlog(loggingOptions)],
});
