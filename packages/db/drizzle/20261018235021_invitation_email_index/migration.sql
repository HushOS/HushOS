-- Hand-edited (this header and the lock timeout). Account → Family lists the open invitations to
-- an account's own address (GET /api/invitations): a partial index on the address of open ones.
-- Building it locks group_invitations against writes (inviting, accepting, revoking) until the
-- run commits: milliseconds, since few invitations are open at once.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "group_invitations_open_email_idx" ON "group_invitations" ("normalized_email") WHERE "state" = 'open';
