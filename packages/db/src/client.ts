import { dbEnv } from '@hushos/env/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { relations } from './schema';

export const db = drizzle(dbEnv.DATABASE_URL, { relations });
