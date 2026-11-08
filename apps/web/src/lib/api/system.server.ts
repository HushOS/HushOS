import '@/lib/server-only';
import { db } from '@hushos/db';
import { API_SERVICE } from '@hushos/shared';
import { Elysia } from 'elysia';
import {
    healthResponse,
    readyResponse,
    unavailableResponse,
} from '@/lib/api/admin-responses.server';
import { requestContext } from '@/lib/api/shared.server';

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
                return { status: 'ok' as const };
            } catch (error) {
                if (error instanceof Error) log.error(error);
                return status(503, { status: 'unavailable' as const });
            }
        },
    );
