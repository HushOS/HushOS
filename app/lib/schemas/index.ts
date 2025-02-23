import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tempFile = pgTable('temp_file', {
    id: text().primaryKey(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
});
