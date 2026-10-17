/*
 * What the domain reads from the environment when it loads: Drive's store
 * settings (nothing here reaches the store), the app origin invitation links
 * point at, and mail to the log. Set only when absent.
 *
 * Billing is off whatever the developer's .env says (`bun run` loads it, and
 * it may hold a sandbox token): admission then never reaches Polar. The
 * billing tests turn it on themselves, with Polar's client replaced.
 */
process.env.BILLING_PROVIDER = 'none';
delete process.env.POLAR_ACCESS_TOKEN;
delete process.env.POLAR_WEBHOOK_SECRET;
process.env.STORAGE_ENDPOINT ??= 'http://store.test';
process.env.STORAGE_BUCKET ??= 'hushos-test';
process.env.STORAGE_ACCESS_KEY_ID ??= 'test';
process.env.STORAGE_SECRET_ACCESS_KEY ??= 'test';
process.env.APP_ORIGIN ??= 'http://localhost:5173';
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM ??= 'HushOS <hushos@hushos.test>';
