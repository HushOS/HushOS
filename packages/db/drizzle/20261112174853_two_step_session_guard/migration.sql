-- Hand-written (drizzle-kit generate --custom): Drizzle does not model triggers. This is the
-- repository's first one. undo.sql beside this file takes it back.
--
-- Why it exists (docs/two-step-design.md 10, docs/self-hosting.md). The second step is a server rule:
-- the code that signs a person in asks for it before it opens a session and releases the password
-- envelope. A release from before two-step sign-in does not know the rule. Run against this schema,
-- as an older container beside newer ones during a rolling update or after a rollback, it would sign
-- an account that has the step in with the password alone. So the database refuses what that code
-- writes: a session whose "two_step_at" is null, for an account that has a confirmed factor. Older
-- code never sets the column, so it fails to sign such accounts in rather than skip their step.
-- Accounts without a confirmed factor are untouched.
--
-- What it refuses, for an account with a confirmed factor:
--   - INSERT of a session with "two_step_at" null;
--   - UPDATE that gives a session with "two_step_at" null to that account ("user_id"), or a new
--     token ("token_hash"): either is a new session by another road.
-- What it leaves alone: every other UPDATE (a session that was open before the account turned the
-- step on keeps working until it ends, as the design has it) and every DELETE.
--
-- What it does not cover: step-ups. An older container also skips the step at a password change, a
-- rotation and account deletion. Only a session that already exists can get there, and it still
-- needs the password (docs/two-step-design.md 10, "What it does not cover").
--
-- The function is SECURITY DEFINER with a fixed search_path: it reads "two_step_factors" as the role
-- that owns it (the one that migrates), whatever role writes the session. A split-role install whose
-- application role was never granted SELECT on the new table would otherwise fail every sign-in. It
-- takes no argument and returns only the row it was given, so it lends that role nothing else.
-- pg_temp is named last in its search_path, so nothing a session made temporary is found first, and
-- EXECUTE is taken from PUBLIC: a trigger fires whatever the writing role may execute, and nobody
-- has a reason to call it.
--
-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on "sessions": reads go on, and writes to
-- "sessions" wait until the run commits.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE FUNCTION "sessions_two_step_guard"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW."user_id" = OLD."user_id" AND NEW."token_hash" = OLD."token_hash" THEN
		RETURN NEW;
	END IF;
	IF NEW."two_step_at" IS NULL AND EXISTS (
		SELECT 1 FROM public."two_step_factors" AS factor
		WHERE factor."user_id" = NEW."user_id" AND factor."confirmed_at" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'HushOS: this account asks for a second step at sign-in, and this session did not pass it.'
			USING ERRCODE = 'check_violation',
				TABLE = 'sessions',
				CONSTRAINT = 'sessions_two_step_guard',
				HINT = 'A release from before two-step sign-in cannot sign this account in. Finish the rollout, or see "Two-step sign-in" under "Release migration notes" in docs/self-hosting.md.';
	END IF;
	RETURN NEW;
END
$guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "sessions_two_step_guard"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "sessions_two_step_guard" BEFORE INSERT OR UPDATE OF "user_id", "token_hash" ON "sessions" FOR EACH ROW EXECUTE FUNCTION "sessions_two_step_guard"();
