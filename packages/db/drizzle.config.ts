import { dbEnv } from '@hushos/env/db';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'postgresql',
    schema: './src/schema/index.ts',
    out: './drizzle',
    dbCredentials: { url: dbEnv.MIGRATION_DATABASE_URL ?? dbEnv.DATABASE_URL },
});
