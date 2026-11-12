-- Takes back 20261112160538_two_step: the two-step tables, "sessions"."two_step_at",
-- "account_devices"."two_step_failures" and the 'two-step' purpose of a bound password proof.
-- Run it as the role that migrates, and stop at the first error:
--     psql -v ON_ERROR_STOP=1 -f undo.sql
-- It is one transaction, so it applies whole or not at all. Run it after
-- 20261112174853_two_step_session_guard's undo.sql: it stops, changing nothing, while the guard is
-- still on "sessions", since the guard reads a table this drops and every sign-in would fail
-- without it.
--
-- It deletes every account's factors, backup codes and security log, which turns the second step
-- off for everyone who had it. Nothing here can bring them back. So while any account has a
-- confirmed factor it also stops, changing nothing, until the session says it is meant:
--     PGOPTIONS="-c hushos.delete_two_step=yes" psql -v ON_ERROR_STOP=1 -f undo.sql
-- or, where a pooler between you and Postgres refuses startup options, in the same session:
--     psql -v ON_ERROR_STOP=1 -c "set hushos.delete_two_step = 'yes'" -f undo.sql
-- Either needs a connection that keeps its session for the whole run: a direct one, as
-- MIGRATION_DATABASE_URL is meant to be, or a pooler in session mode. Take a backup first
-- (docs/self-hosting.md, "Two-step sign-in"). Not run by drizzle-kit:
-- packages/db/src/two-step.migration.test.ts runs it and checks the schema is back to before.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Locked before the count below and held to the end, so no factor can be confirmed between the
-- count and the drop: what the check saw is what is deleted.
LOCK TABLE "two_step_factors" IN ACCESS EXCLUSIVE MODE;
DO $undo$
DECLARE
	stepped bigint;
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_trigger
		WHERE tgname = 'sessions_two_step_guard' AND tgrelid = 'public.sessions'::regclass
	) THEN
		RAISE EXCEPTION 'HushOS: the two-step guard is still on "sessions".'
			USING HINT = 'Run 20261112174853_two_step_session_guard/undo.sql first.';
	END IF;
	SELECT count(DISTINCT "user_id") INTO stepped
	FROM public."two_step_factors" WHERE "confirmed_at" IS NOT NULL;
	IF stepped > 0 AND current_setting('hushos.delete_two_step', true) IS DISTINCT FROM 'yes' THEN
		RAISE EXCEPTION 'HushOS: % account(s) have two-step sign-in on, and this deletes their methods and backup codes.', stepped
			USING HINT = 'Take a backup, then run it again with PGOPTIONS="-c hushos.delete_two_step=yes" (docs/self-hosting.md, "Two-step sign-in").';
	END IF;
END
$undo$;
-- Locked before the delete, so no proof for a two-step change can be stored between it and the
-- older check, which would refuse that row and fail the undo.
LOCK TABLE "opaque_login_attempts" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "opaque_login_attempts" WHERE "purpose" = 'two-step';
ALTER TABLE "opaque_login_attempts" DROP CONSTRAINT "opaque_login_attempts_purpose_binding", ADD CONSTRAINT "opaque_login_attempts_purpose_binding" CHECK (("purpose" = 'login' and "session_token_hash" is null) or ("purpose" in ('delete', 'password', 'master-key', 'recovery-key', 'devices') and "session_token_hash" is not null and octet_length("session_token_hash") = 32));
ALTER TABLE "sessions" DROP COLUMN "two_step_at";
ALTER TABLE "account_devices" DROP COLUMN "two_step_failures";
DROP TABLE "account_security_events";
DROP TABLE "two_step_attempts";
DROP TABLE "two_step_backup_codes";
DROP TABLE "two_step_factors";
DROP TABLE "two_step_state";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '20261112160538_two_step';
COMMIT;
