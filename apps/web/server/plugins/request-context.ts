import { initLogger, loggingOptions, redactAuthenticationEvent } from '@hushos/logging';
import { definePlugin } from 'nitro';

const oneRequestPerConnection = process.env.CI === 'true';

export default definePlugin((nitroApp) => {
    let privacyConfigured = false;
    nitroApp.hooks.hook('request', (event) => {
        if (!privacyConfigured) {
            // Module options cross a JSON build boundary. Install the function policy at runtime.
            initLogger({
                ...loggingOptions,
                redact: { ...loggingOptions.redact, transform: redactAuthenticationEvent },
            });
            privacyConfigured = true;
        }
        event.req.context ??= {};
        // Generate correlation IDs here; caller-controlled header values never enter logs.
        event.req.context.requestId = crypto.randomUUID();
    });

    nitroApp.hooks.hook('response', (response, event) => {
        const requestId = event.req.context?.requestId;
        if (typeof requestId === 'string') response.headers.set('x-request-id', requestId);
        // Every response names the release that served it, so a tab can notice a
        // newer one after a deploy and reload itself instead of failing oddly.
        const release = process.env.HUSHOS_RELEASE_SHA;
        if (release && /^[a-f0-9]{40}$/.test(release))
            response.headers.set('x-hushos-release', release);
        // CI runs the browser suite against this build with nothing in front of it: one
        // request per connection there, as the dev server does in CI (vite.config.ts), so
        // WebKit never sends a POST on a connection the server is closing.
        if (oneRequestPerConnection) response.headers.set('connection', 'close');
    });
});
