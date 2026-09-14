import { defineConfig, devices } from '@playwright/test';

/*
 * Browser tests against a running HushOS: the local infrastructure (Postgres,
 * MinIO, MailHog from `bun run infra:up`) and the web dev server, started here
 * when nothing already listens on 5173. Each run registers its own account
 * through the real sign-up flow, so no fixtures live in the database.
 */
export default defineConfig({
    testDir: './e2e',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
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
        // From the root, so Bun loads the root .env the way `bun run dev` does.
        command: 'bun run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 180_000,
        // In CI the server log is the only way to see a dev-server reload mid-run.
        stdout: process.env.CI ? 'pipe' : 'ignore',
        stderr: 'pipe',
    },
});
