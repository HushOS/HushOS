import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

// Foundation metadata only. Drive content and encryption schemas are future work.
export const workspaces = pgTable('workspaces', {
    id: uuid().defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
