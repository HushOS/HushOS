import { initLogger, loggingOptions, redactAuthenticationEvent } from '@hushos/logging';
import { definePlugin } from 'nitro';

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
        const release = process.env.HUSHOS_RELEASE_SHA;
        if (
            release &&
            /^[a-f0-9]{40}$/.test(release) &&
            new URL(event.req.url).pathname === '/api/ready'
        )
            response.headers.set('x-hushos-release', release);
    });
});
