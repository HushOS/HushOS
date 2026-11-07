import '@/lib/server-only';
import { db } from '@hushos/db';
import { API_SERVICE } from '@hushos/shared';
import { Elysia } from 'elysia';
import { requestContext } from '@/lib/api/shared.server';

/* Health and readiness (/api/health, /api/ready). */
export const systemApi = new Elysia()
    .use(requestContext)
    .get('/health', () => ({ status: 'ok' as const, service: API_SERVICE }))
    .get('/ready', async ({ status, log, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        try {
            await db.execute('select 1');
            return { status: 'ok' as const };
        } catch (error) {
            if (error instanceof Error) log.error(error);
            return status(503, { status: 'unavailable' as const });
        }
    });
