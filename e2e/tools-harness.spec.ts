import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { buildCsp } from '../apps/web/server/csp';
import { newPage } from './helpers';

/*
 * The tools worker harness in a real browser (docs/file-tools-design.md, section 2 "Workers"):
 * a page and a tiny tools worker (e2e/fixtures/tools) bundled by Vite as the app's are, served
 * from their own origin under the production Content Security Policy. Real module workers,
 * real transfers, a real terminate: the watchdog stops a worker spinning in a loop, cancel
 * stops one producing and drops what the page held, the budget holds producing back, and a
 * range read across the source arrives byte for byte. The policy reports nothing throughout.
 *
 * The last test is against the app itself: a worker script a build serves carries the policy.
 */

test.describe.configure({ mode: 'serial' });

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'test-results', 'tools-harness-page');
const POLICY = buildCsp({ nonce: null, dev: false, storeOrigins: [], extraConnect: [] });
const TOOL_FAILED = "This file couldn't be processed.";
const MiB = 1024 * 1024;

let server: Server;
let origin: string;
let page: Page;

async function buildFixture() {
    // Vite is the web app's dependency: resolved from there, as the app's own build finds it.
    const require = createRequire(join(ROOT, 'apps/web/package.json'));
    const vite = (await import(pathToFileURL(require.resolve('vite')).href)) as {
        build(config: Record<string, unknown>): Promise<unknown>;
    };
    await vite.build({
        configFile: false,
        root: join(import.meta.dirname, 'fixtures/tools'),
        logLevel: 'warn',
        build: { outDir: OUT, emptyOutDir: true },
        worker: { format: 'es' },
    });
}

function serve() {
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
    return createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://x').pathname;
        const file = normalize(join(OUT, path === '/' ? 'index.html' : path));
        if (!file.startsWith(OUT) || !existsSync(file)) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, {
            'Content-Type': types[extname(file)] ?? 'application/octet-stream',
            'Content-Security-Policy': POLICY,
        });
        response.end(readFileSync(file));
    });
}

type Tools = {
    violations(): string[];
    lastBeat(): number;
    now(): number;
    state(): { status: string } | null;
    digest(
        size: number,
        offset: number,
        length: number,
        step: number,
    ): Promise<{
        outcome: { ok: boolean; value?: unknown; message?: string };
        expected: string;
        sourceIntact: boolean;
    }>;
    spin(
        watchdogMs: number,
    ): Promise<{ outcome: { ok: boolean; message?: string }; elapsed: number }>;
    produce(count: number, size: number, budgetBytes: number): void;
    received(): number;
    heldBytes(): number[];
    releaseAll(): void;
    releaseAsTheyCome(): void;
    cancel(): void;
    produced(): { ok: boolean; value?: unknown; name?: string } | null;
    urlLoads(): Promise<boolean>;
};
/* Runs `fn` on the page's `window.tools`; evaluated by the browser's debugger, which the policy does not govern. */
const tools = <T>(fn: (tools: Tools) => T | Promise<T>) =>
    page.evaluate(`(${fn.toString()})(window.tools)`) as Promise<T>;

/*
 * The worker stopped: no sign of life sent (by its own clock) later than `graceMs` after the
 * run ended, and none at all for half a second after that. An idle worker stops at once.
 * Chromium lets a worker busy in a loop run on for up to two seconds after terminate() before
 * it forcibly stops its script (measured: beats until 2.0 s, then none).
 */
async function expectStopped(graceMs: number) {
    const ended = await tools((t) => t.now());
    await page.waitForTimeout(graceMs);
    const last = await tools((t) => t.lastBeat());
    expect(last).toBeLessThanOrEqual(ended + graceMs);
    await page.waitForTimeout(500);
    expect(await tools((t) => t.lastBeat())).toBe(last);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await buildFixture();
    server = serve();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    page = await browser.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => 'tools' in window);
});

test.afterAll(async () => {
    await page?.close();
    await new Promise((resolve) => server?.close(resolve));
});

test.afterEach(async () => {
    // Nothing the harness does needs the policy relaxed.
    expect(await tools((t) => t.violations())).toEqual([]);
});

test('a range read across the source arrives byte for byte, and the page keeps its copy', async () => {
    // 20 MiB read in uneven 3 MiB steps from an odd offset: no step lines up with anything.
    const { outcome, expected, sourceIntact } = await tools((t) =>
        t.digest(20 * 1024 * 1024, 12_345, 17 * 1024 * 1024 + 7, 3 * 1024 * 1024 + 1),
    );
    expect(outcome).toEqual({ ok: true, value: expected });
    expect(sourceIntact).toBe(true);
});

test('the watchdog stops a worker spinning in a loop, and the loop ends', async () => {
    const { outcome, elapsed } = await tools((t) => t.spin(1_000));
    expect(outcome).toEqual({ ok: false, message: TOOL_FAILED, name: 'Error' });
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(5_000);
    // Terminated, not told to stop: a loop never reads a message, so only terminate ends it.
    await expectStopped(2_500);
});

test('the budget holds producing back until the page releases, then it runs to the end', async () => {
    await tools((t) => t.produce(10, 1_048_576, 3 * 1_048_576));
    await expect.poll(() => tools((t) => t.received())).toBe(3);
    // Three MiB waiting of three: the fourth is never made while nothing is released.
    await page.waitForTimeout(500);
    expect(await tools((t) => t.received())).toBe(3);
    expect(await tools((t) => t.state()?.status)).toBe('running');
    await tools((t) => t.releaseAsTheyCome());
    await expect.poll(() => tools((t) => t.produced())).toEqual({ ok: true, value: 10 });
    expect(await tools((t) => t.received())).toBe(10);
});

test('cancel terminates the worker, empties what the page held and revokes the run’s URL', async () => {
    await tools((t) => t.produce(10, 1_048_576, 2 * 1_048_576));
    await expect.poll(() => tools((t) => t.received())).toBe(2);
    expect(await tools((t) => t.heldBytes())).toEqual([MiB, MiB]);
    expect(await tools((t) => t.urlLoads())).toBe(true);
    expect(await tools((t) => t.now() - t.lastBeat())).toBeLessThan(500);

    await tools((t) => t.cancel());
    await expect
        .poll(() => tools((t) => t.produced()))
        .toMatchObject({
            ok: false,
            name: 'ToolCancelled',
        });
    expect(await tools((t) => t.heldBytes())).toEqual([0, 0]);
    expect(await tools((t) => t.urlLoads())).toBe(false);
    await expectStopped(100);
});

test('the app serves its worker scripts under the same policy', async ({ browser }) => {
    const app = await newPage(browser);
    const workers: string[] = [];
    app.on('worker', (worker) => workers.push(worker.url()));
    await app.goto('/login', { waitUntil: 'networkidle' });
    // Signing in starts the crypto worker (OPAQUE runs there); the account need not exist.
    await app.getByRole('textbox', { name: /email/i }).fill('nobody@hushos.local');
    await app.getByLabel('Password', { exact: true }).fill('not the password at all');
    await app.locator('form button[type=submit]').click();
    await expect.poll(() => workers.length).toBeGreaterThan(0);
    // Vite's dev server serves a worker from source, outside Nitro's response hook: the check is
    // of a build, which is what ships (and what CI runs the suite against).
    const built = workers.filter((url) => new URL(url).pathname.startsWith('/assets/'));
    test.skip(built.length === 0, 'Workers come from source on the dev server.');
    for (const url of built) {
        const response = await app.request.get(url);
        expect(response.ok()).toBe(true);
        const policy = response.headers()['content-security-policy'] ?? '';
        expect(policy).toContain("worker-src 'self'");
        expect(policy).toContain("'wasm-unsafe-eval'");
        expect(policy).not.toContain("'unsafe-eval'");
    }
    await app.context().close();
});
