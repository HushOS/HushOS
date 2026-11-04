import { dbEnv } from '@hushos/env/db';
import { log } from '@hushos/logging';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { relations } from './schema';

export const db = drizzle(dbEnv.DATABASE_URL, { relations });

// An idle pooled connection can die (Postgres restart, pooler timeout, network blip).
// Without a listener the pool's 'error' event is unhandled and exits the process.
// The pool discards the broken client on its own; a warning is all that is needed.
db.$client.on('error', (error: Error & { code?: string }) => {
    log.warn({ message: 'Postgres pool connection error', name: error.name, code: error.code });
});

// The web server bundles this module twice, once with Nitro's plugins and once with the
// app, and each copy creates its own pool. Every copy records its pool here, process-wide,
// so the shutdown plugin closes the one that served requests and not only its own.
const registry: unique symbol = Symbol.for('hushos.db.pools');
const shared = globalThis as typeof globalThis & { [registry]?: Set<Pool> };
const pools = (shared[registry] ??= new Set());
pools.add(db.$client);

/* Ends every pool this process opened that is still open. */
export async function endPools() {
    await Promise.all([...pools].filter((pool) => !pool.ended).map((pool) => pool.end()));
}
