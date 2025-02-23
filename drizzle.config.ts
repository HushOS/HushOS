import { serverEnvs } from '@/env/server';
import { type Config } from 'drizzle-kit';

export default {
    schema: './app/lib/schemas/index.ts',
    out: './app/lib/migrations',
    dialect: 'postgresql',
    dbCredentials: {
        url: serverEnvs.DATABASE_URL,
    },
    verbose: true,
    strict: true,
    casing: 'snake_case',
} satisfies Config;
