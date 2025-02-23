import { serverEnvs } from '@/env/server';
import * as schema from '@/lib/schemas';
import { drizzle } from 'drizzle-orm/node-postgres';

export const db = drizzle(serverEnvs.DATABASE_URL, {
    schema,
});
