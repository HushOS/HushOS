import { vi } from 'vitest';

/*
 * The API app as the server mounts it, for tests that read its route table or send it requests
 * that are turned away before they reach a database, a store or a mail server. Tests that use it
 * run in Node (`// @vitest-environment node`): the API is server-only.
 */
export async function loadApi() {
    vi.stubEnv('APP_ORIGIN', 'http://localhost:5173');
    vi.stubEnv(
        'DATABASE_URL',
        process.env.DATABASE_URL ?? 'postgresql://test:test@127.0.0.1:1/test',
    );
    vi.stubEnv('EMAIL_ADAPTER', 'log');
    vi.stubEnv('EMAIL_FROM', 'noreply@example.test');
    vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'test');
    vi.stubEnv('STORAGE_BUCKET', 'test');
    vi.stubEnv('STORAGE_ENDPOINT', 'http://127.0.0.1:1');
    vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'test');
    vi.stubEnv('GROUPS_ENABLED', 'true');
    // Outside Nitro there is no request context for the logger.
    vi.doMock('@/lib/logging.server', () => {
        const log = { set() {}, error() {}, info() {}, warn() {} };
        return { useLogger: () => log, useRequestId: () => 'test' };
    });
    const { apiApp } = await import('@/lib/api.server');
    return apiApp;
}

export type ApiRoute = { method: string; path: string; hooks?: Record<string, unknown> };

/* The API module itself, for tests of its HTTP edge (handleApiRequest) as well as the app. */
export async function loadApiModule() {
    await loadApi();
    return import('@/lib/api.server');
}
