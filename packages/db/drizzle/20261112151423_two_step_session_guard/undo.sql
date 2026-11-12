-- Takes back 20261112151423_two_step_session_guard: the trigger on "sessions" and its function.
-- Run it as the role that migrates (psql -f undo.sql); it is one transaction, so it applies whole
-- or not at all. Run it before 20261112151421_two_step's undo.sql if that is being taken back too.
--
-- After this, a release from before two-step sign-in signs every account in with the password
-- alone, whatever factors it has (docs/self-hosting.md, "Two-step sign-in"). Not run by drizzle-kit:
-- packages/db/src/two-step.migration.test.ts runs it and checks the schema is back to before.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER "sessions_two_step_guard" ON "sessions";
DROP FUNCTION "sessions_two_step_guard"();
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '20261112151423_two_step_session_guard';
COMMIT;
