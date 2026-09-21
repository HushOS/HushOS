import { defineConfig, devices } from '@playwright/test';

/*
 * Browser tests against a running HushOS: the local infrastructure (Postgres,
 * MinIO, MailHog from `bun run infra:up`) and the web dev server, started here
 * when nothing already listens on 5173. Each run registers its own account
 * through the real sign-up flow, so no fixtures live in the database.
 */
export default defineConfig({
    testDir: './e2e',
    globalSetup: './e2e/global-setup.ts',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    // Files run in parallel; the serial blocks inside a file keep their order.
    // Every file registers its own accounts, so files share only the dev server,
    // and that is the ceiling: more workers past this only slow the uploads.
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : 6,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    outputDir: 'test-results',
    use: {
        baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
        trace: 'retain-on-failure',
        acceptDownloads: true,
        ...devices['Desktop Chrome'],
    },
    // WebKit runs locally on demand (`--project=webkit`): the engine behind Safari,
    // for the module worker, IndexedDB key storage and download paths.
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
        // A phone-sized Chromium for the layout checks in mobile.spec.ts.
        {
            name: 'mobile',
            use: { ...devices['Pixel 7'] },
            testMatch: /mobile\.spec\.ts/,
        },
        { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /mobile\.spec\.ts/ },
    ],
    webServer: {
        // From the root, so Bun loads the root .env the way `bun run dev` does. In CI
        // the server's output goes to a file the workflow uploads on failure, and only
        // there: three lines a request, it was most of the job log and buried the tests.
        command: process.env.CI
            ? 'mkdir -p scratchpad && bun run dev > scratchpad/e2e-server.log 2>&1'
            : 'bun run dev',
        // Each test context sends its own x-forwarded-for (see helpers.ts), so the
        // per-address cap on verification emails never trips. A dev server you
        // started yourself needs TRUSTED_PROXY_HEADER=x-forwarded-for in .env.
        env: { TRUSTED_PROXY_HEADER: 'x-forwarded-for' },
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
