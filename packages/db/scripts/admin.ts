import { setUserRole } from '../src/auth';
import { db } from '../src/client';

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
const normalized = email.trim().toLowerCase();
const result = await setUserRole(normalized, action === 'grant' ? 'admin' : 'member');
if (!result) {
    console.error(`No account with the email ${normalized}.`);
    await db.$client.end();
    process.exit(1);
}
console.log(`${result.email} is now ${action === 'grant' ? 'an admin' : 'a member'}.`);
await db.$client.end();
