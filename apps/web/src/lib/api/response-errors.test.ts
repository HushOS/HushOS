// @vitest-environment node
import { Elysia, t } from 'elysia';
import { expect, test } from 'vitest';
import { loadApi } from '@/test/api-app';

/*
 * A response that fails its own schema is the server's bug. Before, the auth and billing error
 * mapping took every ValidationError for the caller's ("Please check your information"), so a
 * broken response read as the person's mistake and was never logged.
 */
test('a response that fails its schema is a 500 on every feature, never a 400', async () => {
    await loadApi();
    const { requestContext } = await import('@/lib/api/shared.server');
    const app = new Elysia({ prefix: '/api' })
        .use(requestContext)
        .get(
            '/auth/probe',
            { response: { 200: t.Object({ right: t.String() }) } },
            () => ({ wrong: 1 }) as unknown as { right: string },
        )
        .get(
            '/billing/probe',
            { response: { 200: t.Object({ right: t.String() }) } },
            () => ({ wrong: 1 }) as unknown as { right: string },
        )
        .get(
            '/drive/probe',
            { response: { 200: t.Object({ right: t.String() }) } },
            () => ({ wrong: 1 }) as unknown as { right: string },
        );
    for (const path of ['/api/auth/probe', '/api/billing/probe', '/api/drive/probe']) {
        const response = await app.handle(new Request(`http://localhost${path}`));
        expect(response.status, path).toBe(500);
        expect(await response.text(), path).not.toContain('check your information');
    }
});
