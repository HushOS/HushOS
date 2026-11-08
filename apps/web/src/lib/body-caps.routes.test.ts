// @vitest-environment node
import { expect, test } from 'vitest';
import { BODY_CAPS, DEFAULT_BODY_BYTES } from '@/lib/body-caps';
import { loadApiModule, type ApiRoute } from '@/test/api-app';

/*
 * The caps against the API itself: each named cap still names a route the app serves (a renamed
 * route would fall to the default and refuse real uploads or documents), and the edge reads every
 * write under them before Elysia parses anything.
 */
test('every named cap matches a route the API serves', async () => {
    const { apiApp } = await loadApiModule();
    const routes = apiApp.routes as unknown as ApiRoute[];
    const filled = (path: string) =>
        path.replace(/^\/api/, '').replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
    for (const cap of BODY_CAPS)
        expect(
            routes.some(
                (route) => route.method === cap.method && cap.path.test(filled(route.path)),
            ),
            `${cap.method} ${cap.path}`,
        ).toBe(true);
});

test('the edge refuses a drive write past its cap before the app sees it', async () => {
    const { handleApiRequest } = await loadApiModule();
    const response = await handleApiRequest(
        new Request('http://localhost/api/drive/nodes/00000000-0000-4000-8000-000000000000/trash', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
            body: 'x'.repeat(DEFAULT_BODY_BYTES + 1),
        }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'too-large' });
});
