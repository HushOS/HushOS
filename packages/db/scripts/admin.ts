import { dbEnv } from '@hushos/env/db';

/*
 * Operator roles are granted here and nowhere else:
 *   bun run admin:grant someone@example.com
 *   bun run admin:revoke someone@example.com
 * Run from the repository root so the root .env is loaded.
 */
const [action, email] = process.argv.slice(2);
if ((action !== 'grant' && action !== 'revoke') || !email) {
    console.error('Usage: admin <grant|revoke> <email>');
    process.exit(2);
}

/*
 * A browser test against a server of its own (E2E_BASE_URL), or the verify skill's instance
 * (VERIFY_RUN), passes that server's database. Reaching `hushos`, the developer's own, from
 * one means the root .env leaked in: refuse before anything connects.
 */
const marker = ['E2E_BASE_URL', 'VERIFY_RUN'].find((name) => process.env[name]);
const database = decodeURIComponent(new URL(dbEnv.DATABASE_URL).pathname.replace(/^\//, ''));
if (marker && database === 'hushos') {
    console.error(
        `Refusing to change roles in the hushos database while ${marker} is set: pass the test server's database (E2E_DATABASE_URL for the e2e suite).`,
    );
    process.exit(3);
}

const { setUserRole } = await import('../src/auth');
const { db } = await import('../src/client');
const normalized = email.trim().toLowerCase();
const result = await setUserRole(normalized, action === 'grant' ? 'admin' : 'member');
if (!result) {
    console.error(`No account with the email ${normalized}.`);
    await db.$client.end();
    process.exit(1);
}
console.log(`${result.email} is now ${action === 'grant' ? 'an admin' : 'a member'}.`);
await db.$client.end();
