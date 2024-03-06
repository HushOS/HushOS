import { type Config } from 'drizzle-kit';

import { serverEnvs } from '@/env/server';

export default {
    schema: './src/server/db/schema.ts',
    out: './src/server/db',
    driver: 'pg',
    dbCredentials: {
        connectionString: serverEnvs.DATABASE_URL,
    },
} satisfies Config;
