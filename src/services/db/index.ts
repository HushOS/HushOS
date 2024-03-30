import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { serverEnvs } from '@/env/server';
import * as schema from '@/services/db/schema';

export const db = drizzle(postgres(serverEnvs.DATABASE_URL), { schema });
