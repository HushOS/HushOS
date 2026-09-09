import { dbEnv } from '@hushos/env/db';
import { log } from '@hushos/logging';
import { drizzle } from 'drizzle-orm/node-postgres';
import { relations } from './schema';

export const db = drizzle(dbEnv.DATABASE_URL, { relations });

// An idle pooled connection can die (Postgres restart, pooler timeout, network blip).
// Without a listener the pool's 'error' event is unhandled and exits the process.
// The pool discards the broken client on its own; a warning is all that is needed.
db.$client.on('error', (error: Error & { code?: string }) => {
    log.warn({ message: 'Postgres pool connection error', name: error.name, code: error.code });
});
