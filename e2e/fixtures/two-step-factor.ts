#!/usr/bin/env bun
/*
 * Gives an account an authenticator app and its ten backup codes, straight in the database of
 * the server under test: what an account that turned two-step sign-in on looks like to a
 * server that no longer offers it (TWO_STEP_ENABLED off), where no request can turn it on.
 * The spec that uses this checks that such an account is still asked for its step. The app is
 * made as the server makes one (the secret sealed under the server's two-step key, the codes
 * under its keyed hash), so the server under test must share this process's OPAQUE setup and
 * two-step key: both come from the same .env. Prints the setup key and the codes as JSON.
 * Test databases only.
 *
 *   DATABASE_URL=<the server's database> bun e2e/fixtures/two-step-factor.ts <email>
 */
const email = process.argv[2];
const url = process.env.DATABASE_URL;
if (!email || !url)
    throw new Error('Usage: DATABASE_URL=… bun e2e/fixtures/two-step-factor.ts <email>');
// Only the accounts the browser suite registers.
if (!/^e2e-[a-z0-9-]+@hushos\.local$/.test(email))
    throw new Error('Only an e2e account (e2e-…@hushos.local) is given a factor.');
// As the admin script: a test against a server of its own (E2E_BASE_URL) or the verify skill's
// instance (VERIFY_RUN) passes that server's database, so reaching `hushos`, the developer's own,
// from one means the root .env leaked in. CI's own database is also named `hushos`.
const marker = ['E2E_BASE_URL', 'VERIFY_RUN'].find((name) => process.env[name]);
if (marker && decodeURIComponent(new URL(url).pathname.slice(1)) === 'hushos')
    throw new Error(`Refusing to add a factor in the hushos database while ${marker} is set.`);

// Imported once the database is known to be the right one: these modules connect as they load.
const { totpStep } = await import('../../packages/crypto/src/two-step-server');
const { findCredential } = await import('../../packages/db/src/auth');
const twoStep = await import('../../packages/db/src/two-step');
const { newBackupCodes, newTotp } = await import('../../packages/auth/src/two-step');

const credential = await findCredential(email.toLowerCase());
if (!credential) throw new Error(`No account for ${email}.`);
const app = await newTotp({ id: credential.userId, email });
await twoStep.createPendingTotp(app.row);
const codes = await newBackupCodes(credential.userId);
if (!codes) throw new Error('The account is gone.');
const confirmed = await twoStep.confirmTotp({
    userId: credential.userId,
    factorId: app.row.id,
    // Well before now, so the app's current code is one it has not used.
    step: totpStep() - 100,
    backupCodes: codes.stored,
});
if (confirmed.status !== 'ok') throw new Error(`The app was not confirmed: ${confirmed.status}.`);
console.log(JSON.stringify({ secret: app.shown.secret, codes: codes.shown }));
process.exit(0);
