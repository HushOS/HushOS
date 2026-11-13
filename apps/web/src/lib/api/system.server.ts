import '@/lib/server-only';
import * as auth from '@hushos/auth/server';
import { db } from '@hushos/db';
import { log as serverLog } from '@hushos/logging';
import { API_SERVICE } from '@hushos/shared';
import { Elysia } from 'elysia';
import {
    healthResponse,
    readyResponse,
    unavailableResponse,
} from '@/lib/api/admin-responses.server';
import { requestContext } from '@/lib/api/shared.server';

/*
 * Once this process is ready it says which two-step key it seals under (its id, never the
 * key): the worker re-seals older secrets only towards the key the web service names
 * (docs/two-step-design.md 8), and a health check is the first thing a new container answers,
 * so a rotation does not wait for someone's next sign-in. Said once per process; a failure is
 * logged, never the readiness answer's, and the next check tries again.
 */
let keyAnnounced = false;
let keyAnnouncing = false;
function announceTwoStepKey() {
    if (keyAnnounced || keyAnnouncing) return;
    keyAnnouncing = true;
    void auth
        .announceTwoStepKey()
        .then(() => {
            keyAnnounced = true;
        })
        .catch((error: unknown) =>
            serverLog.error({
                message: 'The two-step key could not be announced to the worker.',
                twoStep: { failure: error instanceof Error ? error.name : typeof error },
            }),
        )
        .finally(() => {
            keyAnnouncing = false;
        });
}

/* Health and readiness (/api/health, /api/ready). */
export const systemApi = new Elysia()
    .use(requestContext)
    .get('/health', { response: { 200: healthResponse } }, () => ({
        status: 'ok' as const,
        service: API_SERVICE,
    }))
    // The 503 is declared too, so the outage reply is held to its shape like the 200.
    .get(
        '/ready',
        { response: { 200: readyResponse, 503: unavailableResponse } },
        async ({ status, log, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            try {
                await db.execute('select 1');
                announceTwoStepKey();
                return { status: 'ok' as const };
            } catch (error) {
                if (error instanceof Error) log.error(error);
                return status(503, { status: 'unavailable' as const });
            }
        },
    );
