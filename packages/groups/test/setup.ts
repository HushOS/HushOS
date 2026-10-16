/*
 * What the domain reads from the environment when it loads: Drive's store
 * settings (nothing here reaches the store), the app origin invitation links
 * point at, and mail to the log. Set only when absent.
 */
process.env.STORAGE_ENDPOINT ??= 'http://store.test';
process.env.STORAGE_BUCKET ??= 'hushos-test';
process.env.STORAGE_ACCESS_KEY_ID ??= 'test';
process.env.STORAGE_SECRET_ACCESS_KEY ??= 'test';
process.env.APP_ORIGIN ??= 'http://localhost:5173';
process.env.EMAIL_ADAPTER = 'log';
process.env.EMAIL_FROM ??= 'HushOS <hushos@hushos.test>';
