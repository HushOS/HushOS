import { inject } from 'vitest';

/* Runs in every test worker before the test file's imports, so the db client sees the test URL. */
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MIGRATION_DATABASE_URL = '';
