import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { serverEnvs } from '@/env/server';
import * as schema from '@/services/db/schema';

const client = postgres(serverEnvs.DATABASE_URL);
export const db = drizzle(client, { schema });
