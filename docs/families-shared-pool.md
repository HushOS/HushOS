# Families: one storage pool for each member's own files and the family folders

An addendum to `docs/groups-design.md` 3.5 (Storage and the payer), decided by the owner on 19 October 2026, the day families launched on the web with no subscribers. Where this and 3.5 disagree, this wins; 3.5 points here, and was rewritten to match by the docs step (section 11, step 7) on 20 October 2026.

Families are switched off on hushos.com (`GROUPS_ENABLED=false`) from today until this ships. The last step of the plan (section 9) switches them back on.

## 1. What is wrong with what shipped

The shipped pool covers family folders only. `group_storage.quota_bytes` is read by `freeBytes` (`packages/db/src/drive.ts`) for a group area, and a member's own files (My files) keep their own allowance: Free's 2 GB or their own paid plan. The pricing page (`FAMILY_POOL_LINE`), its FAQ, the announcement post and the family's page all say so.

What that costs:

- **A family plan sells storage most families cannot use.** Family Plus is 800 GB for four people's shared folders, while each of those people keeps paying for, or running out of, their own space. Every comparable family plan (iCloud+, Google One, Dropbox Family) covers each member's own files; ours reads as the worse deal at the same price.
- **"One storage source per person"** (groups-design 3.5) was designed and never built (`docs/groups-design.md` 9 says so). A member who pays for their own plan and joins a family pays twice for storage today.
- **An account can be in several families.** Nothing stops it, and nothing could say which pool holds that person's own files if their files were pooled. `GROUP_OWNED_LIMIT` caps families created (3 by default), not families joined.
- **There are three copies of the allowance arithmetic**, and they would drift as soon as the pool changes: `freeBytes` (`drive.ts`), `getStorageAllowance` (`packages/db/src/auth.ts`, what `/api/auth/storage` and both phone apps read) and `getGroupPoolUsage` (`packages/db/src/billing.ts`, what the downgrade guard and the family page read). The phones would show 2 GB while uploads are checked against 800 GB.

## 2. Decisions

Final, from the owner:

1. **One shared pool.** A family's storage (Family Plus 800 GB, Family Pro 2 TB, Family Max 4 TB; prices unchanged) covers each member's own files (My files) and the family folders. Everything draws from one pool.
2. **One family per account, final.** An account is personal or in exactly one family, never two. Today's code allows several; that stops. Someone may still be shared into a single folder of another family once sharing inside family folders exists (groups-design 3.4); that is a share, not a membership, and draws nothing from their pool. Extra families "for folders only" are a possible later change, not now.
3. **Personal plans are unchanged** for anyone not in a family.
4. **One view for a family member, no switcher for families.** A member sees the family's name, then My files (private: no other member can open it; it draws from the family pool; shares and links to people outside the family live here), the family folders, Shared and Trash. There is no separate personal workspace to switch to.
5. **Personal ↔ family moves are allowed both ways and cost nothing:** both sides are the same pool.
6. **Entry points.** Account → Family shows your family (manage it, leave it), or, if you have none, Create a family and how invitations work. The Plans page shows the family tiers beside the personal ones, each with Create a family. The pricing page's button goes there through sign-up. Joining happens only through the email invitation's join flow. Someone not in a family sees no Families item in the sidebar.
7. **Company workspaces are separate.** The one-family rule is about where a person's own files live and which pool they draw from. A company workspace (HushOS for Companies, later) belongs to the company and uses the company's storage, so a person can be personal or in one family and also in any number of company workspaces. The uniqueness rule covers family memberships only (section 4).
8. **The workspace switcher arrives with companies, not before.** Its entries are "You" (personal or family, the view in decision 4) and then each company. Company → You moves are blocked unless the company's policy allows them, for that person or for the whole company. Company plans are later; this addendum records the rule and the hook only (section 6.4).

Defaults proposed here, for the owner to confirm (section 11):

- **A personal subscriber who joins a family:** their own files move into the family pool at once, and their personal plan ends at that moment, with the unused days refunded, prorated (owner decision 2; 3.3, 5.1). No double charge.
- **Someone already in a family who is invited to another** can open the invitation, which says they must leave their family first; they can neither accept nor be let in until they do.
- **Leaving, removal, or the family plan ending:** their own files go back to their own allowance (Free, 2 GB, unless they buy a plan). Over it, nothing is deleted and nothing becomes unreadable; uploads are refused until they make room or buy a plan.
- **Per-member limits:** not in milestone 1.
- **Who sees what:** the organizer and anyone who manages the family see each member's usage as a rounded size, never names, counts or contents.

This replaces three bullets of groups-design 3.5: "One storage source per person" (the keep-your-own-plan choice is gone: everything draws from one pool), "What the organizer sees" (managers now see rounded per-member usage) and "Optional per-member limits" (deferred).

## 3. Rules and edge cases

### 3.1 When a member's own files draw from the pool

A person's personal workspace is **pooled** when all of these hold:

- `BILLING_PROVIDER=polar` (with `none`, nothing is pooled; section 8);
- they have an `active` membership in a family (`group_kind = 'family'`);
- that family's `group_storage` row has a live plan: `expires_at` is set and in the future.

A personal plan doesn't change this (owner decision 2): someone who pays for one is pooled the moment the three hold, and billing ends their plan then, refunding the unused days (5.1).

`expires_at` is the plan's period end plus `BILLING_GRACE_DAYS` (3 by default), and it is null for a family that never had a plan (`createGroup` writes `quota_bytes = 0`, `expires_at = null`). So:

- **An organizer who created a family but hasn't paid yet** keeps their own allowance, a paid personal plan included. Their files join the pool when the family's plan goes live, and then their personal plan ends with the unused days refunded (5.1).
- **When a family plan ends** (cancelled at its period's end, or revoked; at once when Polar's payment retries run out, `unpaid`, or the plan is paused: groups-design 3.5, Polar's statuses; the grace days only cover a renewal that is late, not a plan that has ended), every member's own files go back to their own allowance at the same moment, with no job to run: the rule is computed on every check. The family folders read an empty pool, as today.
- **Family folders always read the pool**, as today: a family without a live plan stores nothing in them.

Nothing else adds to the pool while a person is pooled: not Free's 2 GB ("no stacking of free allowances", groups-design 3.5), not referral bonuses, not an operator's grant, not a personal plan in the moment before billing ends it. Those rows stay in `storage_entitlements` and count again the moment the person is no longer pooled.

### 3.2 Joining

- **Creating a family while in one** is refused, 409 `in-family`: "You're in Lindqvist family. Leave it before you create another."
- **Opening an invitation while in a family** (route 14) succeeds and returns `inFamily: { name }`, so the join page can say: "You're in Lindqvist family. To join Ortega family, leave yours first, from Account → Family. This invitation stays open until 26 October." The invitation email says nothing about it: the server would be telling the inviter, through the email's wording, that the invitee is in a family.
- **Accepting while in a family** is refused, 409 `in-family`, with the same words. This goes further than the default ("can't be let in"): an accepted membership would sit in the other family's pending list, and its managers would learn that the person is in some family. Refusing at accept leaks nothing and costs the invitee one step, since they must leave first anyway.
- **Letting someone in who has since joined or created another family** is refused at admit, 409 `in-family`, before any place is bought: "They've joined another family since they accepted. They can join yours once they leave it." It does not name the other family.
- **The newcomer's own files must fit.** Admission refuses, 409 `pool-full`, when the newcomer's own used and reserved bytes are more than the pool's free space (a newcomer who pays for a personal plan counted like anyone, since they draw from the pool once in; only when the family's plan is live, since without one nobody is pooled): admitting them would stop every member's uploads at once. The manager reads: "Their files don't fit in the family's free space. Free up space or move to a bigger plan, then let them in." It gives no figure, so a manager doesn't learn the newcomer's usage beyond "more than what's free". That answer is still a coarse probe: a manager who lets the same person in again as the free space changes (by freeing or filling space, or across a tier change) can bracket their usage between two free-space readings. Accepted: it takes deliberate repeated attempts, each needs the newcomer's pending admission, and the bracket is no finer than the manager can steer the free space. The newcomer's join page says beforehand that their files will count against the family's storage, with their own figure.
- **Admission order:** the `in-family` and `pool-full` checks run before `ensureGroupSeat` charges for a place, and again inside the admitting transaction under the locks in 3.6. A race lost between the first check and the transaction (the newcomer was admitted elsewhere, or the pool filled) leaves a paid place and nobody admitted. The place is not lost: it is open for the next person, and the payer can schedule fewer places for the renewal. It is logged; it cannot be avoided without holding a Polar charge inside a database transaction.
- **The first purchase by an organizer whose own files exceed the tier** is refused, as a downgrade is (groups-design 3.5): "Your files take 950 GB, more than Family Plus's 800 GB. Choose a bigger plan or free at least 150 GB."

### 3.3 A personal subscriber joining

When a person becomes pooled (admitted to a family with a live plan, or their family's plan goes live), their files draw from the pool at once, and their own live personal subscription ends at that moment, at Polar, with the unused days of the period they paid for refunded, prorated (owner decision 2). Section 5.1 has the mechanics.

- **The join page says so before accepting:** "Your Pro plan ends when you're let in, and the unused days are refunded. From then on your files use Lindqvist family's storage." The same line, with "when the family's plan starts", is on the organizer's checkout for the family's first plan.
- **The managers are not told** that a newcomer pays for a plan: that is the newcomer's business.
- **While pooled, a personal plan can't be bought:** 409 `in-family`, "Your storage comes from Lindqvist family's plan. Leave the family to choose a plan of your own." The ended plan can't be resumed, at HushOS or in Polar's portal: a revoked subscription is over. A personal subscription that turns up live for a pooled person (a checkout that raced the admission) is ended and refunded the same way.
- **Leaving later:** their personal plan has ended, so nothing of it comes back; they are on Free plus whatever else they hold (3.4) until they buy a plan again.

### 3.4 Leaving, removal, and plans ending

Their own files go back to their own allowance: 2 GB plus whatever entitlements they still have (referral bonuses, operator grants). A personal plan they had when they joined ended then (3.3), so it doesn't come back.

- **Over the allowance:** downloads, previews, moving to the Trash and deleting all keep working; uploads, copies and new versions are refused (`over-quota`, as today). Nothing is deleted and nothing becomes unreadable, however long it lasts.
- **The grace period today:** there is none for being over quota, and none is needed for safety, because nothing has a deadline: an over-quota account stays readable for as long as it exists. The only grace HushOS has is `BILLING_GRACE_DAYS` (3), how long an allowance outlives its billing period, which already applies when a family plan ends. This addendum proposes no new grace (question 4 has the alternative and its cost).
- **What they are told:** the leave dialog shows their own files' size against their allowance ("Your files take 312 GB. On Free you have 2 GB: you'll be able to open and download everything, but not upload, until you make room or choose a plan."). A removed member gets that line in the removal email. Members of a family whose plan ended get it in the plan-ended email.
- **Payer and organizer rules are unchanged:** the payer of a live plan can't leave or be removed, and the organizer hands over `members` and `billing` first (groups-design 3.3).

### 3.5 Tier changes and move-backs

The pool's usage now includes members' own files, so every place that compares usage with a tier changes with it:

- **A move to a smaller tier** is refused while the whole family (own files and folders) holds more than the smaller pool: "Your family stores 850 GB, more than Family Plus's 800 GB. Free at least 50 GB, then change the plan." Members' own files keep growing until the renewal, so the family can land above the smaller pool. Then every member's uploads pause, in My files and in the family folders; nothing is deleted.
- **A move-back** (an unpaid upgrade reverted at the period end, groups-design 3.5) cannot be refused: it is what the family paid for. It can likewise land the family above its pool. The payer is emailed with the figure, and the family page and every member's storage meter say the family is full.
- **The family page** shows the payer, before they confirm a smaller tier, whether the family fits today, as it does now (`over` in `apps/web/src/lib/family-billing.ts`), counted the new way.
- **Being full is everyone's problem, and only managers can see why.** Without per-member limits, one member's own files can fill the pool for all, and a manager can only see rounded sizes and ask, or remove them (who then keeps their files, over their own allowance). This is the price of deferring per-member limits; section 7 keeps the data model ready for them.

### 3.6 Uploads racing for the last free bytes

The pool row is the one lock that every check against the pool takes, whichever workspace the bytes land in:

1. Resolve the pool: an area's own group, or, for a personal workspace, its owner's active family membership, live plan or not (as built: a plan going live is billing's write under the pool lock, so the check must hold that lock to see it; whether the plan is live, and whether a personal plan is still in force, is decided under it).
2. Lock `group_storage` for that group (`FOR UPDATE`). As built, the pool lock is a transaction-scoped advisory lock keyed by the family (`takePoolLock`), taken together with the row lock and in its place in the lock order, so a group made before billing, with no row yet, still serialises its first plan's write against uploads.
3. For a personal workspace, read the membership again. Admit, leave, removal, dissolution and billing's pool write all take the same lock (below), so under it the membership is settled. If it changed between 1 and 3, start over (at most twice; then answer 503 and let the client retry).
4. Lock the target `workspace_storage` row. For a personal workspace whose owner was in no family at step 1, read the membership again here (as built): no pool lock was taken, so an admission is what could move them, and it locks the newcomer's `workspace_storage` row while it checks `pool-full`. A change starts over as in 3.
5. Sum the pool (3.7) and compare. As built, the pool is counted in parts, the family folders together and each pooled member's own files, each part's used and reserved bytes rounded up to a whole GiB on its own and the parts summed; a reservation is checked against the pool less every other part so counted, less the target part's own bytes, and a refusal names that figure. A member's own part counts to the byte there (they know their own bytes); the family folders' part counts in whole GiB even for a writer to a folder, since its bytes are everyone's, uploads in flight included: counted exactly, a writer's `over-quota` refusal would show the folders' exact total and another member's upload into them as it starts. That costs up to another GiB of the folders' room. Counting the exact total and rounding the free space down (what step 3 first built) didn't hide anything: tier quotas are whole GiB, so the rounded figure changed at exactly the byte the exact one did, and a member adding single bytes to their own files could watch an upload's answer (or their storage figures) change as the total crossed a GiB and learn the others' usage to the byte, modulo a GiB; a payer could do the same with the downgrade guard. Counted part by part, another member's files move any answer only when their own part crosses a whole GiB, which managers already see (3.9). It costs up to a GiB of the pool for each part, members plus one. A workspace on its own allowance is checked to the byte.

Two members uploading into their own My files at once queue on the pool row, and only one of two uploads that each fit alone but not together gets the reservation. That is what `freeBytes` already does for two family folders, extended to personal workspaces.

**Lock order, everywhere:** the `groups` row, then `workspaces` rows (the change-sequence and area locks: a group's areas first, in id order, as `lockAreas` takes them, then a personal workspace, as account deletion takes the person's own after their families' areas and a move's completion takes its two sides), then `group_storage`, then `workspace_storage`. Membership changes in `packages/db/src/groups.ts` take `group_storage` after `lockGroup` and `lockAreas`, and never lock a personal workspace's row after it. Releases and purges only lower `used_bytes` or `reserved_bytes`. They don't take the pool lock: lowering can't overspend, and taking it would add a second lock order.

Account deletion departs every family without the pool lock (as built): it deletes the person's own workspace in the same transaction, which would lock a personal workspace's row after the pool. Nothing is mis-charged without it, since an upload racing the deletion is deleted with the workspace.

### 3.7 The pool's usage

```
pool_used(family) = Σ used_bytes + reserved_bytes over
    every workspace with group_id = family (deleted family folders included until their purge)
  + the personal workspace of every member whose membership in the family is active
```

There is exactly one implementation, `poolUsage(tx, groupId)` in `packages/db`, called by `freeBytes`, `getStorageAllowance` and the billing summary; `getGroupPoolUsage`'s separate query goes. The ways it can count bytes twice, each with a test (section 10):

- joining through `workspace_keys` or `area_grants`, which have one row per member per area, would multiply each family folder by the number of members;
- joining personal workspaces through every membership row instead of active ones would count a member who left;
- an account in two families would be counted in both pools (prevented by the unique index, section 4).

The family page's figures leave out reserved bytes, as today; the upload check counts them.

### 3.8 Moving files between My files and the family folders

The server copies only within one workspace (`copyFile` points the new version at the same object). Across workspaces a move is done on the device: download, re-encrypt under the destination's keys, upload, then remove the source. Personal ↔ family moves are allowed both ways.

**Quota:** both sides are the same pool, so a finished move changes nothing. During a move both copies exist, and a naive copy-then-delete needs free space equal to what is moved, and leaves the source in the Trash, still counted, for 30 days. To make "free" true, including in a full pool:

- **A move is a pool-neutral upload.** Upload begin takes `moveOf: { workspaceId, nodeId, versionId }`. The server checks that the source's workspace is in the same pool as the destination, that the caller may delete it, and that `versionId` is still current. The reservation charged is `max(0, new size − bytes the source frees)`, the source's current and older versions together.
- **The source is removed in the completion's transaction**, deleted outright and never put in the Trash: there is no moment after commit when both count. A source that changed meanwhile (a new version, a rename into a trashed folder, a deletion) fails the completion with `stale`, the copy is released, and the source is untouched.
- **Folders** move file by file: folders are created at the destination (no bytes), each file moves as above, and the source folder is deleted when empty.
- **What a move loses,** said in the dialog before it starts: older versions (only the current one is moved); shares and links on the source (family folders can't hold shares yet, groups-design 3.4: "Moving revokes 3 shares and 1 link."); and, for a file moving out of a family folder, the writer's signature, which becomes the mover's (the open item "copies or moves between spaces re-sign as the copier", groups-design 9).
- **What it costs the device:** every byte goes down and back up. A 300 GB move is 600 GB of transfer on the person's connection. That is a real weakness; a server-side copy that re-wraps only the content key would avoid it, but it needs the object store's key layout (`objectKey` names the workspace) to allow cross-workspace references, and is not proposed now.
- **Outside one pool** (billing off; a family without a live plan, whose folders have no room; a company workspace), a move needs the destination's free space: the copy is charged in full, as an upload is. As built (step 5, section 13) it still names its source and deletes it in the completion's transaction, so it is as atomic as a move within a pool; an earlier draft made it a copy and a separate delete, which could delete a new version landing in between.

### 3.9 Who sees what

- **Each member** sees their own usage, the family's total and free space, and the family folders' total. From those they can work out the others' combined usage, never any one person's.
- **The organizer and every `members` or `billing` holder** also see each member's own usage (My files, with its Trash and older versions, which count), rounded up to the whole gigabyte, "Under 1 GB" below that. They never see names, counts, types or dates of anyone's files.
- **Rounding happens on the server.** The manager's response carries the rounded figure only, so the exact byte count never reaches another member's browser. Whole gigabytes keep one photo's upload from showing as a change.
- **The pool's totals are counted part by part (as built after step 3).** In a family of two, the exact total less one's own files and the folders is the other person's usage, and live reserved bytes show each upload they start. So everything a member or manager reads about the pool, and every check made against it, counts the pool in parts (3.6 step 5): the folders together and each member's own files, each rounded up to a whole GiB and summed. That is `/api/auth/storage` while pooled (used counted so; free the pool less the parts with uploads in flight; nothing included, read as 0; `reservedBytes` always "0", kept because shipped iPhone builds decode it), the family billing summary's `usedBytes`, the free space an `over-quota` refusal names, `pool-full`, and the downgrade (and first-purchase) guard's comparison and figures. Rounding only the total was not enough: quotas are whole GiB, so it changed at the same byte the exact total did.
- **The server learns nothing new:** it already holds every workspace's padded byte count. What changes is that other people, the family's managers, now see a coarse version of it. The privacy policy (`apps/web/src/content/legal/privacy.mdx`), which says nothing about families today, gains a section that says so plainly (section 7.5).

## 4. Database

One migration, `<timestamp>_one_family_shared_pool`:

1. **`groups`:** add a unique constraint on `(id, kind)`, so memberships can carry the kind and reference it.
2. **`group_memberships.group_kind`:** `text not null`, backfilled from `groups.kind`, with a composite foreign key `(group_id, group_kind) → groups (id, kind)` so it can never disagree with its group. Postgres can't put another table's column in a partial index, so the kind must live on the row.
3. **The one-family rule:**

    ```sql
    create unique index group_memberships_one_family_idx
        on group_memberships (user_id)
        where group_kind = 'family' and state = 'active';
    ```

    Only `active` family rows count. `accepted` rows can't coexist with an active family in practice (accept is refused, 3.2), but the index does not need to forbid them, and `left` and `removed` rows are history. Company (`org`) memberships are outside the index, so a person in one family and three companies is four rows and no conflict.

4. **Existing accounts in several families.** The migration counts them first and, if there are any, stops with an error naming the query and `docs/self-hosting.md` (Groups). It does not resolve them. Marking a membership `left` in SQL looks like what the leave route does, but the route refuses an organizer, a payer and the last `members` holder, because the signed roster depends on those rules; a migration can't keep them. Instead:
    - **hushos.com:** families are off and nobody has paid. Run the query now, before the migration ships; if the rows are test accounts, as expected, those people leave the extra families (or the test families are dissolved), with `GROUPS_ENABLED=true` in a local or staging copy if needed.
    - **Self-hosted:** families have been on by default for days (#46). The release's Upgrade notes give the query and say: have each listed person leave all but one family on the release before this one, then upgrade. A server whose migration stops keeps running the previous images.

5. **No new storage tables.** Pooling is derived from the membership and `group_storage`. Per-member limits, when they come, are one nullable `own_files_cap_bytes` column on `group_memberships`, not part of this migration.

The repository functions that insert or activate a family membership (`createGroup`, `acceptInvitation`, the admit path in `writeChain`) map a violation of `group_memberships_one_family_idx` to the `in-family` result, never to a 500.

## 5. Billing

### 5.1 The personal plan of someone who becomes pooled

Owner decision 2: the personal plan ends the moment its owner's files join the pool, and the unused part of what they paid is refunded, prorated. Step 3 pools them at once; step 4 ends and refunds the plan, as follows (as built, `packages/billing/src/endings.ts`).

- **Trigger:** the admission commits for a family with a live plan (route 17 queues it after `writeChain` returns), `reconcileGroup` writes a live pool with a pooled member whose personal plan the mirror holds as live (the organizer's first purchase, a lapsed plan bought again, a checkout that raced an admission), `reconcileCustomer` finds a live personal plan for a pooled person (`subscription.updated` and every other personal delivery), or Polar reports a personal `order.paid` for a pooled person. Each sends `billing.end-personal-plan` with `{ userId, groupId, admittedAt, seenAt }`: the membership, and when HushOS saw them pooled. The queue is `stately`, keyed by the user, so the first job sent for a person is the one kept while it waits.
- **One ending per personal subscription** (`personal_plan_endings`, keyed by the subscription id, which is ended once), made by the job while its owner is pooled, holding the membership (`group_id`, `admitted_at`), `pooled_at` (the earliest `seenAt`), and, once Polar has ended it, `revoked_at` with the period it was in. Someone who leaves before the revoke keeps their plan (`dropped`; ended for a new membership if they are pooled again).
- **The job, in order,** each ending worked under a lease on its row (`lease_owner`, `lease_until`, two minutes by the database's clock, as `claimPlanChange` keeps time, so worker hosts whose clocks differ can't take one early), taken with a conditional update and renewed between steps; the lease and the job's signal are checked right before every refund is asked for. A second run (pg-boss's retry of one it took for dead after ten minutes) can't take an ending another holds and is retried later; a run that stalled past its lease, which another run then took, asks Polar for nothing more. Plain rows rather than an advisory lock: a session lock is dropped with its connection while the run goes on, and doesn't hold behind a transaction-mode pooler (PlanetScale's, which docs/self-hosting.md allows). A failure is retried ten times, backing off from a minute to six hours (about a day in all); after that the daily reconcile queues it again for as long as anything is open:
    1. **Revoke at Polar:** `subscriptions.revoke(id)` ends it now, not at the period's end (Polar allows this for a plan set to cancel at the period's end). The answer's `ended_at` and `current_period_start`/`current_period_end` are stored the first time it succeeds, and every retry computes from them, so a retry an hour later doesn't refund an hour less. A 403 `AlreadyCanceledSubscription` (a first try whose answer was lost, so nothing is stored) is followed by reading the subscription: its own `ended_at` is the instant, never now; a 403 for one without `ended_at` is retried. An `ended_at` more than five minutes before `pooled_at` is a plan that ended before pooling (it ran out, or was ended at Polar): nothing is refunded. 404: nothing to end. Polar is not told the family's name. Then `reconcileCustomer`, which revokes the entitlement locally.
    2. **Compute the refund,** again at every run, over every order of that period, not only the newest: the checkout or renewal that paid for it, and every change order made inside it, an upgrade's charge (by card, or paid from the customer's balance) or a downgrade's credit (a negative net amount, credited to the balance). An order belongs to the period when it is made inside it (a checkout or renewal up to an hour before its start, for clock differences) and is paid or credits. Each order paid for its share of the period: a checkout or renewal from the period's start, a change order from when it was made, to the period's end. Its unused share is the seconds from the stored revocation time to the period's end over that span (the whole span for an order made after `pooled_at`: a renewal that slipped past the revoke paid for nothing they used), of its net amount (after discounts, before tax) less other people's live refunds on it, rounded down. **What is owed in all is the sum of every order's unused share, signed:** a downgrade's credit counts against it and an upgrade paid from that credit counts for it, so a downgrade on day 10 (credit 400) and an upgrade on day 12 paid from it (360) of a 1000 renewal revoked on day 15 owe 500 - 300 + 300 = 500, and the 40 left in the balance is what the days used were worth. That total is placed on the orders Polar refunds on, at most what Polar will refund on each (`net_amount + applied_balance_amount`, the balance being negative when it paid part, less live refunds): each order its own share first, then the difference (a credit taken off, the share of an order Polar refunds nothing on added) newest order first. What the period's orders can't carry was paid from the customer's balance, which came from an earlier card payment (a downgrade's proration credit, a card-paid top-up), so it is the customer's money: it is refunded on the customer's earlier card-paid orders in the same currency (`orders.list` by external customer id), newest first, each at most what Polar will refund on it (`net_amount + applied_balance_amount` less live refunds), under the same key, lease, listing-first, 10-minute wait and pending rules as the period's own, with a comment saying it returns balance credit from an ended plan, since it lands against an older payment. **Placement starts from what is already back:** HushOS's own refunds on every order, the period's and earlier ones, are counted first, and nothing new is placed beyond what is owed less them, so a period order that can take more later (another refund on it failed) never adds to what earlier orders already returned. Balance not yet spent is never touched: Polar has no way to clear a balance, so paying it out by card would pay it twice. **Disputes:** a refund Polar refuses because the charge is disputed (`RefundDisputedPayment`) drops that order's share for good (`disputed`), listed for operators and never moved to another order: a lost dispute returns the whole charge by chargeback, and the share on top would pay twice. **Other refusals are failures, never final:** `RefundsBlocked` (the order's or organisation's refunds blocked, which can be lifted) and `RefundUnknownPayment` (a payment record not there yet) count a failed try, owed after five and asked again daily; `RefundedAlready` places the amounts again from a fresh listing. **The refund window:** neither Polar nor Stripe documents an age limit on card refunds; Polar's refund service checks no order age, and a charge too old for Stripe reaches HushOS as Polar re-raising Stripe's error, a 500, which is unsure (it may still have made the refund) and so waits 10 minutes before the next ask. An earlier order that fails five times in a row is given up: listed under Refunds owed with what it carries, never asked again and its share never moved, since an unsure ask may yet land. What no order can carry is not refunded: it is logged at warn level with the account, the membership (family and admission), the subscription and the amount, and listed for operators on the management page under **Not refundable through Polar**, to refund by hand if they decide to. Orders Polar refunds nothing on (free, 100%-off, paid from balance, a credit) are settled as `none` without listing their refunds. Polar's refund `amount` excludes tax and Polar refunds the matching tax itself, prorated, so HushOS never computes tax.
    3. **Refund through Polar's refunds API,** per order, what its target still lacks: `refunds.create({ order_id, amount, reason: 'customer_request', comment: 'Moved to a HushOS family plan', revoke_benefits: false, metadata: { hushos_refund: '<userId>:<groupId>:<admittedAt>:<order_id>' } })`. Polar documents no idempotency key for refunds, so the key is HushOS's own: the key and target are written locally first (`personal_plan_refunds`), the time of the ask stamped just before the call, and before every computation the order's refunds at Polar are listed. HushOS's own are those with the key, and any live refund without it that appeared from its first ask on (one Polar recorded without the metadata after an ask that errored once the card had been refunded, or an operator's): either way the person has that money back, and HushOS doesn't try to tell them apart. Other people's live refunds before that lower the share instead. Live means pending or succeeded, read from the list, never from `refunded_amount`, which moves only when a refund succeeds. An order with anything still pending on it, HushOS's or anyone's, stays open and is read again by the daily reconcile, so a refund that later fails or is cancelled is owed again, even after HushOS asked for its own; HushOS's own that failed also counts a failed try. A 403 `RefundedAlready` settles it. After an ask that timed out or got a 5xx, nothing is asked again for 10 minutes after it (`unsure_until`, the database's clock), though the order's refunds are listed first every run: Polar can commit a timed-out refund late and takes no idempotency key, so a retry a minute later would otherwise ask again before the first lands. A retried job, a webhook replay, a reconcile or a second run therefore never refund twice.
- **Polar's fee isn't returned.** Polar keeps its fee on a refunded order; HushOS bears it. Accepted: it is the price of not charging people twice.
- **Failures:** a revoke that fails retries; a refund that fails (Polar refuses or can't be reached, the refunds can't be listed, or Polar's refund fails) counts one failed try. After 5 in a row it is listed on the management page under **Refunds owed**, with the order, account and amount before tax, logged at error level, and no longer retried by pg-boss: it is asked for again at most once a day (the daily reconcile queues it), until it lands or the operator refunds it in Polar by hand (the job then finds that refund and stops).
- **The production token needs `refunds:write`** (and `refunds:read` for the match in step 3); the owner adds the scopes to the existing token (Polar tokens' scopes can be edited in place). The sandbox token needs them too to test this live; until then only the fake Polar in `packages/billing` has refunded anything. Without them every refund fails and is listed as owed after five tries, while plans are still revoked.
- **Refunds that fail after they landed:** Stripe can fail a refund it reported succeeded for up to 30 days, and Polar then marks it failed and takes it back off the order. The daily reconcile lists again the refunds of every ending settled in the last 30 days and opens any whose refunds no longer hold what HushOS counted, so the job places them again; Polar's `refund.updated` delivery for a refund with HushOS's key that failed or was cancelled opens it at once. Polar answering `RefundedAlready` four passes running while its listing never shows the order refunded counts a failed try, so it ends on Refunds owed rather than failing unseen.
- **The daily reconcile** queues the job for every pooled person whose personal plan the mirror holds as live (a lost job, a checkout that raced the admission), and for every ending not yet settled (a refund pending at Polar, checked again; a failed one, owed and tried again).
- **Webhooks:** no new subscriptions. `subscription.updated` and every other personal delivery already run `reconcileCustomer`, which queues the job for a pooled person with a live plan. An `order.paid` for a personal subscription while its owner is pooled (a renewal that slipped past the revoke, a checkout that raced the admission) queues it too, and is logged at error level; an order made after `pooled_at` is refunded whole.
- **`startCheckout` and `resume`** refuse while pooled: `BillingError` 409 with the `in-family` copy (3.3), and `code: 'in-family'`, which `/api/billing/*` passes through as `code`, so the web can tell this refusal apart without matching on words. `GET /api/billing` adds `family: { name, planName }` while pooled, and carries no plan chosen at sign-up then.

### 5.2 What the family side changes

- **`getGroupPoolUsage`** becomes `poolUsage` (3.7). The downgrade guard in `changeGroupPlan` and the summary's `storage.usedBytes` read it, so both now count members' own files.
- **`getGroupBilling`** gains `usage: { ownBytes, foldersBytes, members }` in both views (as built): `ownBytes` is the caller's own files, exact, or null for a payer who is no longer a member; `foldersBytes` the family folders' total in whole GiB, rounded up; `members: [{ userId, ownBytesRounded }]`, already rounded (3.9; "0" for anything under 1 GiB, read "Under 1 GB"), largest first, only for a caller who holds `members` or `billing` (the organizer holds both), null for anyone else.
- **First purchase** (`startGroupCheckout`) refuses a tier smaller than what the pool would hold the moment it goes live (3.2): the organizer's own files, and, for a lapsed family buying again, every member's and the folders'. Compared with what the pool counts (each part rounded up to a whole GiB, 5 above), said in whole GiB rounded up: "Your files take 950 GB, more than Family Plus's 800 GB. Choose a bigger plan or free at least 150 GB." ("Your family stores …" with more than one member; "Free at least …" alone where no bigger tier is on offer). Plans and the Create a family dialog say the same before a family is made, from the same count (`countedPool`, `firstPlanTooSmall`).
- **Polar products** keep their metadata: `quota_bytes` is already the whole family's. Only the description changes, through `bun run polar:seed --update`: from "storage for the whole family" to "{storage} for the whole family: everyone's own files and the family folders, {n} members included." Prices are unchanged, so `--update` replaces no price.
- **The catalogue** (`listCatalogue`) changes no shape. What the pages say about it is section 7.

## 6. Server checks and API

### 6.1 Group routes

`GroupErrorCode` (`packages/groups/src/protocol.ts`) gains `in-family` (409) and `pool-full` (409).

| Route                            | Change                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups`               | 409 `in-family` when the caller has an active family membership; the unique index is the backstop                                                                                                               |
| `POST /api/invitations/open`     | Adds `inFamily: { groupId, name } \| null`, the caller's own family                                                                                                                                             |
| `POST /api/invitations/accept`   | 409 `in-family`, before the `no-plan` check                                                                                                                                                                     |
| `POST /api/groups/:id/.../admit` | 409 `in-family`, then 409 `pool-full`, both before `ensureGroupSeat`, and again inside the transaction                                                                                                          |
| `POST /api/groups/:id/leave`     | Unchanged checks; the answer adds `ownBytes` and `allowanceBytes` after leaving, for the confirmation                                                                                                           |
| `GET /api/groups`                | Returns at most one family; the web reads it as "the family". The array shape stays for companies                                                                                                               |
| `GET /api/billing/groups/:id`    | The manager view gains rounded per-member usage (5.2)                                                                                                                                                           |
| `GET /api/auth/storage`          | Reads `poolUsage` and the pool when pooled; adds `pool: { groupId, name } \| null`. `quotaBytes`, `usedBytes` and `availableBytes` become the pool's, so shipped phones show the right figures without updating |
| `GET /api/billing`               | Adds `family: { name, planName } \| null` when pooled                                                                                                                                                           |
| Drive upload begin               | Optional `moveOf` (3.8)                                                                                                                                                                                         |

### 6.2 Web copy for the new refusals

| Where                                   | Copy                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Join page, already in a family          | "You're in Lindqvist family. To join Ortega family, leave yours first, from Account → Family. This invitation stays open until 26 October." |
| Create a family, already in one         | "You're in Lindqvist family. Leave it before you create another."                                                                           |
| Let them in, they joined another family | "They've joined another family since they accepted. They can join yours once they leave it."                                                |
| Let them in, their files don't fit      | "Their files don't fit in the family's free space. Free up space or move to a bigger plan, then let them in."                               |
| Plans page, buying while pooled         | "Your storage comes from Lindqvist family's plan. Leave the family to choose a plan of your own."                                           |

### 6.3 What doesn't change

Rosters, successions, seals, grants and the join code are untouched: a person's own files never enter a roster, and pooling is storage accounting only. No crypto fixture changes.

### 6.4 The company hook

Company plans are later; this records where their rules attach so nothing here has to be undone:

- **Storage:** a company area resolves to the company's own pool in step 1 of 3.6 (`group_storage` keyed by the org's group id, `quota_bytes_per_member` from its plan). Personal pooling only ever looks at `group_kind = 'family'`.
- **Company → You moves:** refused unless the company's policy allows export for that person or for the whole company. The hook is the `moveOf` check (the source's workspace is an org area: consult policy, refuse with 403 `policy`) and the web's move dialog. **This can't be a hard guarantee in an end-to-end encrypted drive:** a member who can open a company file can always save a copy, and an upload of that copy looks like any other. The policy stops HushOS's own move and copy actions and nothing more; product copy must say "HushOS won't move it", never "can't leave".
- **You → company moves:** open (question 1).

## 7. The web

### 7.1 Sidebar

Not in a family:

- Home, My files, Shared, Trash; Tags and People you share with. No Families item (`organise` loses it; `FamilyRows` goes).

In a family:

- **The family's name and avatar at the top of the sidebar,** under the brand, linking to Account → Family. That slot is where the switcher goes later, so nothing moves when companies arrive.
- Home, **My files**, **Family folders** (opens `/app/s/<groupId>`, the family's folders), Shared, Trash.
- **Trash** shows My files' Trash and the family folders' Trash (today `/app/s/$groupId/trash`) as two sections of one page.
- **The storage meter** shows the pool everywhere, not only inside the family folders: "Lindqvist family · 312 GB of 800 GB used", and "The family's storage is full" when it is. With no live plan it shows the person's own allowance, labelled My files, as today.

With companies, later: the top slot becomes a switcher with "You" (the family's name as its second line, or nothing for a personal account) and each company, grouped under "Companies" when there are several. Choosing a company replaces the nav with that company's. "You" is everything above.

### 7.2 Account → Family

A new page, `/app/family`, linked from Account as **Family**:

- **In a family:** today's family page (members, roles, invitations, pending admissions with the word check, the plan for those who manage it), with the per-member usage list (7.3) for managers, and Leave at the foot with the figures from 3.4.
- **Not in a family:** what a family is, in two sentences, Create a family, and how invitations work ("Someone in a family invites you by email; you join from the link in it").
- `/app/families` and `/app/families/$groupId` redirect to `/app/family`. `/app/families/$groupId/join` keeps its URL, since invitation links already sent point at the join flow.

### 7.3 Per-member usage on the family page

For managers, under the plan: one row per member, name and rounded size, largest first, then "Family folders" with their total, then the free space. Nobody else sees the list. The text says what the numbers are: "How much each person's own files take, to the nearest whole GB. You can't see what the files are."

### 7.4 The Plans page and the pricing page

- **Plans (`/app/billing`):** the family tiers sit beside the personal plans, each with Create a family. Choosing one names the family, creates it (the creation flow of groups-design 3.1, on the device) and goes straight to checkout for that tier, carrying the choice the way a personal plan choice is carried through sign-up (`billing_intents`). A pooled member sees "Your storage comes from Lindqvist family's plan" in place of the personal plan picker.
- **`FAMILY_POOL_LINE`** (`apps/web/src/lib/plans.ts`) becomes: "One pool for the whole family: everyone's own files and the family folders. Each person's files stay private to them."
- **The family section's headline** becomes "Storage for up to {n} people, and folders you share, end-to-end encrypted." (today: "Family folders for up to {n} members, end-to-end encrypted.").
- **The FAQ** (`apps/web/src/lib/pricing-faq.ts`) changes "What is a family plan?" (drop "that storage is for family folders, and each member's own files stay on their own plan"), "Who pays for a family plan?" (a member who already pays for their own plan stops paying for it), "What happens if a member leaves or is removed?" (their own files go back to their own allowance, with the over-quota line) and "What happens when a family plan is cancelled?" (everyone's own files go back to their own plans). A new question, "Can the family see my files?", gets the answer from 3.9.
- **`pricingLede`:** "a family plan adds folders you share" becomes "a family plan covers everyone in it, with folders you share".

### 7.5 Privacy policy

A new section in `apps/web/src/content/legal/privacy.mdx`, "Families":

> If you are in a family, the people who manage it see how much space your own files take, rounded up to the whole gigabyte. They never see your files' names, how many there are, or what is in them. Our servers know who is in each family and each person's role, as the family announcement describes.

### 7.6 The announcement post

`apps/web/src/content/blog/family-plans.mdx` says, in "What a family is": "A family's storage is for its family folders; each member's own files stay on their own plan, Free included." Its Plans table says "800 GB for the family folders" and so on. Its opening also says families "work on the web and in the iPhone and Android apps"; the roadmap, the pricing page and `docs/self-hosting.md` all say web only, and the phones show no families yet (`docs/groups-mobile-plan.md`). That claim is wrong today, whatever happens to storage.

Proposed, in the 1.0 post's style (an italic dated line at the end, and the body fixed to match):

> _Corrected {ship date}: this post first said a family's storage was for its family folders only, with each member's own files on their own plan. From {ship date}, a family's storage covers everyone's own files and the family folders together, and someone who already paid for their own plan stops renewing it when they join. An account can be in one family. It also said families work in the iPhone and Android apps; they are on the web, and the apps follow. The text above now says so._

Today, while families are switched off on hushos.com, the post needs one line at the top so it doesn't sell something nobody can buy: "Family plans are paused while we change how their storage works; this post will say when they're back." The `<Cta>` ("Open Families in Drive and create one") goes until they are back.

### 7.7 The roadmap

The `families` item (`apps/web/src/content/roadmap.ts`) is `shipped`, October 2026, and says "with one storage pool for up to 20 people … On the web now". With families off on hushos.com that is not true. While paused: move it to `now` with "Family plans: one storage pool for everyone's own files and the family folders, for up to 20 people, each newcomer checked with their twelve words before they join." (a planned item carries no date, as the roadmap test requires). When they are back: `shipped`, with the month they came back, the same body plus "On the web; the iPhone and Android apps follow.", still linking the corrected post.

## 8. Self-hosting

- **No new settings.** `GROUP_SEAT_LIMIT_DEFAULT`, `GROUP_AREA_QUOTA_BYTES` and `GROUP_AREA_LIMIT` keep their meaning.
- **One family per account applies everywhere,** billing or not: it is one rule in the database, and a second family would mean two answers to "where do my files live" the day billing is turned on. `GROUP_OWNED_LIMIT` now matters only for company groups; the docs say families are one per account whatever it says.
- **Without billing (`BILLING_PROVIDER=none`) nothing is pooled:** members' own files keep `INITIAL_STORAGE_QUOTA_BYTES` and their grants, and each family folder keeps `GROUP_AREA_QUOTA_BYTES`, as today. A self-hoster who wants one pool per family without Polar is not served by this; that would be a new setting, not proposed.
- **With Polar**, the Family plans section changes from "Every folder of a family draws from the one pool" to say members' own files draw from it too, with 3.1's rule for when, and the personal-plan cancellation in 5.1.
- **Upgrade notes** for the release with the migration: the duplicate-membership query and what to do (section 4). The `GROUPS_ENABLED` row's "hushos.com sets it false until paid family plans exist" is updated when it is switched back on.

## 9. Mobile

The phones show storage (Account → Plan and storage on both) from `/api/auth/storage` and the plan line from `/api/billing`. They show no families yet.

- **Shipped apps, with no update:** `/api/auth/storage` returns the pool's figures when pooled (6.1), so a pooled member's phone shows "312 GB of 800 GB", and uploads are checked against the same numbers. Both decoders ignore fields they don't know (iOS `JSONDecoder`, Android reads by key), so `pool` breaks nothing. The plan line still reads the person's personal plan ("Pro, ends 3 November") until the apps update, a cosmetic mismatch that is accepted.
- **Next app releases:** the storage card says "From Lindqvist family's plan" when `pool` is set, and the plan line reads `family.planName`. Read only, as all phone billing is (groups-design 9).
- **Families on the phones (1d)** inherit everything here: the space list already returns one family at most. The phone's view follows decision 4 (My files, the family folders, Shared, Trash), with no switcher.
- **Personal ↔ family moves on the phones** come with 1d's family folders and use `moveOf`; nothing to build before then.

## 10. Tests that must exist

Billing, quota and membership are money code (AGENTS.md). Each test below fails on a defect a person would notice; none asserts what a mock was told to return. Database tests run on real Postgres (`packages/db`); billing tests against the fake Polar with signed webhooks (`packages/billing`); group tests over the real core (`packages/groups`).

**Pool usage (`packages/db/src/drive.pool.test.ts`):**

- **No double counting:** a family of three, two folders, each member with a personal workspace: the pool's usage is the exact sum. Each folder has three `workspace_keys` rows, and the test fails if a join through them multiplies the folders. A member who left is not counted; a deleted, unpurged folder is.
- **Not pooled without a live plan:** an organizer with a personal Pro entitlement and a family without a plan uploads against Pro; the same family once its plan is live uploads against the pool and ignores Pro; past `expires_at` the organizer is back on their own allowance (with Pro, in a test that hasn't ended it; billing ends it in production, 5.1) and the folders read empty. A newcomer who pays for a personal plan is counted by `pool-full` and pooled once let in.
- **No stacking:** a pooled member with a referral bonus and an operator grant has exactly the pool's free space, and has both again after leaving.
- **`BILLING_PROVIDER=none`:** a family member's own files keep their own allowance (extends `drive.pool-none.test.ts`).

**Races (real concurrency, two connections):**

- **Past the pool:** two members begin uploads into their own My files at once, each 60% of the free space. Exactly one is reserved, the other gets `over-quota`, and the sum never exceeds the pool. The same for one My files and one family folder.
- **A membership change during an upload:** a leave and an upload begin race. The reservation lands on whichever side the membership was on after the pool lock, never on neither, and the leaver's personal check afterwards counts it.
- **No deadlock:** an admit, a leave, a pool write from billing and uploads in three workspaces of one family, interleaved 200 times, all finish.

**One family (`packages/db`, `packages/groups`):**

- An active membership in a second family is refused by the index; an `org` membership beside a family is allowed.
- Create, accept and admit each answer `in-family`. A concurrent admit of one person into two families admits them once, and the other answers `in-family`, not 500.
- **Admit refuses before money moves:** an `in-family` or `pool-full` refusal makes no `subscriptions.update` call to the fake Polar.
- `pool-full`: a newcomer whose own usage exceeds the free space is refused; one byte less is admitted.
- The migration stops when two active family memberships exist for one account, and runs when they don't.

**Billing (`packages/billing`):**

- **Pooling ends the personal plan and refunds the unused part once:** admitting a personal subscriber revokes their subscription at Polar and refunds the prorated unused part of the last paid order, exactly once; the amount is checked against the period (half a period unused refunds half, to the minor unit, rounded down). A retried job or a webhook replay doesn't refund twice; a failed refund is retried and, after repeated failures, listed for operators under Refunds owed. The daily reconcile finds one missed and ends it.
- **No double charge left unseen:** a personal renewal `order.paid` for a pooled person is listed for refund.
- **Refusals while pooled:** checkout answers `in-family`; after leaving it works. The ended personal plan doesn't count again after leaving.
- **Downgrade counts own files:** folders 100 GB plus one member's own 750 GB refuses Family Plus with "free at least 50 GB"; 700 GB is accepted.
- **Move-back below usage:** a reverted upgrade that leaves the family over its pool refuses uploads to My files and the family folders, allows downloads and deletes, and deletes nothing.
- **Leave over quota:** a member with 30 GB leaves to Free; their next upload is `over-quota`, a download works, nothing is purged, and buying a personal plan lifts the allowance.
- **Rounded usage only:** the manager view carries whole gigabytes, rounded up (1 GiB + 1 byte reads 2 GB; under 1 GiB reads "Under 1 GB"). The member view carries no one else's usage, and no response to anyone but the owner carries another member's exact bytes.

**Moves (`packages/db`):**

- A move into a full pool succeeds and leaves usage unchanged.
- A move whose source changed fails `stale`, releases the copy and leaves the source.
- A move across pools (a family with no plan, a future org area) is charged in full and refused for room where there is none, never lowered by what the source frees (as built; first written as "refused as a move").
- After the completion's transaction the source is gone and its bytes freed, with no state in which both count.

**End to end (`e2e/families.spec.ts`, Chromium and WebKit):** a personal account sees no Families item; an organizer creates a family from Plans, pays in the sandbox, and their meter shows the pool; an invitee in another family sees the leave-first notice; a member moves a file from My files into a family folder and the meter doesn't change.

## 11. Implementation plan

One change per PR, squash-merged, each with the independent review and a `verify-hushos` run where the web changes. In order:

1. **docs: this addendum** (this PR).
2. **feat(db): allow one family per account.** Migration (section 4); repository mapping to `in-family`; `in-family` in `GroupErrorCode`; the checks in create, open, accept and admit (before the seat purchase); the web's copy for them (6.2). Tests: one family.
3. **feat(db): pool a family member's own files with the family folders.** `poolUsage`; `freeBytes` resolving the pool for personal workspaces with the 3.6 lock order and re-check; membership changes taking the pool lock; `getStorageAllowance` and the billing summary on `poolUsage`; `pool-full` at admit; `/api/auth/storage`'s `pool`. Tests: pool usage, races, `pool-full`.
4. **feat(billing): end a personal plan when its owner's files join a family.** `billing.end-personal-plan` (revoke, prorated refund, Refunds owed; 5.1); reconcile and webhook checks; refusals while pooled with `BillingError.code`; the management list; the downgrade guard and first purchase counting own files; rounded per-member usage in the manager view. Tests: billing.
5. **feat(drive): move files between My files and family folders without spending storage.** `moveOf` on upload begin and completion; the web's move across spaces with the dialog's losses; the org policy hook as a refusal stub. Tests: moves.
6. **feat(web): give a family member one view.** Sidebar (7.1), `/app/family` with per-member usage and redirects (7.2, 7.3), Plans with the family tiers and Create a family (7.4), the pool meter. E2E.
7. **docs(web): say a family's storage covers everyone's own files.** `FAMILY_POOL_LINE`, the headline, FAQ and lede (7.4); the privacy section (7.5); groups-design 3.5 and 9; `docs/self-hosting.md` (section 8); Polar descriptions through `polar:seed --update` (run by the operator). The post's correction and the roadmap item land in step 9, the day families come back.
8. **feat(ios), feat(android): show where a family member's storage comes from** (section 9). Independent of 6 and 7; can run in parallel with the web steps.
9. **Rollout on hushos.com:** confirm no account is in two families (section 4) and deploy the migration; run `polar:seed --update`; check one sandbox family end to end (a personal subscriber joining, a leave over quota, a downgrade refused); publish the post's correction and move the roadmap item back to `shipped`; then set `GROUPS_ENABLED=true`.

After step 9, once no container older than step 2 runs anywhere that matters: **drop the default of `group_memberships.group_kind`** (`'family'`, added by step 2's migration only so containers of the release before it keep inserting memberships during a rollout). Every write names the kind; the default would otherwise outlive its reason and stand ready to mislabel a company membership the day company groups ship, which the composite foreign key would refuse, but only as a failed write.

Before step 9, the announcement's pause line and the roadmap's move to `now` (7.6, 7.7) go out on their own, as soon as families are switched off.

## 12. Open questions for the owner

Closed on 19 October: one family per account (final), the single view and no family switcher, the entry points, companies kept separate, the switcher arriving with companies.

1. **Personal or family → company moves:** allowed by default, or controlled by company policy like the other direction? If policy, is it per person, per company, or both? (A company may want files brought in freely; a person's own files leaving their pool into a company's custody, where its admins can open them, is the bigger privacy step.) Recommendation: allowed by default with a dialog that says the company's admins can open them, policy able to turn it off.
2. **A personal subscriber joining:** answered by owner decision 2 (below): the plan ends when they're let in and the unused days are refunded, prorated, through Polar (5.1). This question first proposed cancelling at the period's end with no refund, which lost a yearly subscriber who joined a month in eleven months of what they paid.
3. **An invitee already in a family:** confirm refusing at accept as well as at admit (3.2), rather than letting them accept and wait in the other family's pending list.
4. **Grace after leaving or removal:** there is none today, and this proposes none: nothing is deleted, so there is no deadline to soften. The alternative is a 30-day allowance after a removal (which the person didn't choose) so their phone's backups don't stop that day. Any version that lets them keep uploading hands out storage nobody pays for, and what they upload stays theirs, read-only, after it ends. Recommendation: none, and say it in the removal email.
5. **Per-member limits:** confirm later, not milestone 1. The cost of later is the last bullet of section 3.5: one member can fill the pool for everyone.
6. **Rounding:** whole gigabytes, rounded up. Coarser (5 or 10 GB) hides more and tells a manager less.
7. **Extras while pooled:** confirm that referral bonuses and operator grants don't add to the pool and come back on leaving. An operator who grants storage to a person in a family would see it have no effect.
8. **`pool-full` at admission:** confirm refusing someone whose own files don't fit (3.2), rather than admitting them and stopping everyone's uploads.
9. **Accounts already in several families:** confirm that the migration stops and an operator resolves them, rather than a migration that picks one family.
10. **Self-hosted without billing:** confirm the one-family rule applies there too, with no pooling and no new setting.
11. **The announcement:** confirm the pause line now and the correction on the day families return (7.6), and its wording.

## Owner decisions (2026-10-19)

All open questions are answered as recommended:

1. Personal or family files moved into a company workspace: allowed by default, with a dialog saying the company's admins can open them.
2. A personal subscriber who is let into a family with a live plan draws from the family pool at once. Their personal plan ends at that moment, and the unused days are refunded, prorated, through Polar (5.1). (Decided again on 19 October, after the first answer, which kept them on their plan to its end, was shown to leave a family far over its pool when a large plan ended: a member on a 2 TB plan inside an 800 GB family would land the pool about 1.2 TB over.)
3. An invitee already in a family is refused when they accept, not only at "Let them in".
4. No grace period after leaving or removal (nothing is ever deleted).
5. Per-member limits come later.
6. Managers see each member's usage in whole gigabytes, rounded up.
7. Referral bonuses and operator grants don't add to the pool and come back when the person leaves.
8. `pool-full` refuses an admission whose own files don't fit.
9. The migration stops on any account in two families rather than picking one.
10. The one-family rule applies on self-hosted servers without billing.
11. When families return, the rewritten announcement is published (the old one is in drafts), rather than a correction.

## 13. What steps 3 and 4 built (19 October 2026)

`feat(db): pool a family member's own files with the family folders`, with families still off on hushos.com.

- **`packages/db/src/pool.ts`** holds the one implementation: `poolUsage` (3.7), `storageFigures` (what any workspace may take, with the 3.6 locks or read once for display), `admissionFits` (`pool-full`), `lockPool` and `settlingPool` (start over on `PoolMovedError`, at most twice, then the route's 503). `freeBytes` (upload begin and copy), `getStorage`, `getStorageAllowance` (`/api/auth/storage`, now with `pool: { groupId, name } | null`), the family billing summary and the downgrade guard all read it; `getGroupPoolUsage`'s own query is gone (`getPoolUsage` delegates).
- **Membership changes take the pool lock** after the group's row and its areas: admit and remove in `appendChain`, `leaveGroup` (dissolution included); so does billing's pool write. The lock is an advisory lock keyed by the family plus the `group_storage` row (3.6 step 2). Account deletion doesn't take it (3.6, last paragraph).
- **One clock:** every time rule in a check (the family plan's expiry, a grant's) is judged at one instant, the app's clock read once the locks are held, never the database's transaction-start `now()`.
- **What a pooled member may spend** is the pool less every other part counted in whole GiB, less their own part's exact bytes (3.6 step 5, as revised after review): the first build rounded the exact free space down instead, which a member could still probe byte by byte through their own files, since tier quotas are whole GiB. The cost is up to a GiB of the pool per part (each member, and the folders).
- **What members see is counted part by part** (3.9): `/api/auth/storage` while pooled, the billing summary, `over-quota`'s free space and the downgrade refusal. Nothing at all reads 0; any part above it up to 1 GiB counts as 1 GiB.
- **`pool-full`** (409, in `GroupErrorCode`): route 17 asks before the chain checks and again right before `ensureGroupSeat`; `appendChain` asks under the locks, with the newcomer's storage row locked, so an upload of theirs in flight is counted.
- **Decision 2 as built (the second answer):** a member who pays for a personal plan is pooled and counted like everyone else the moment the family's plan is live (3.1); the plan adds nothing meanwhile. `pool-full`, `poolUsage`, `freeBytes`, the account figures, the billing summary and the downgrade guard all read it so. Ending the plan and refunding it is step 4 (5.1).
- **The downgrade guard now counts members' own files**, since it reads the same usage, and its message became 3.5's ("Your family stores 850 GB…"). Its test ("Downgrade counts own files") came with this step rather than step 4.
- **Web, minimal:** the sidebar meter names the family and offers no personal plan while the server's figures are the pool's, and the storage-full dialog drops "Get more room" then; `pool-full` has its copy (6.2). The full meter of 7.1 is step 6.
- **Tests** (`drive.pool.test.ts`, `drive.pool-none.test.ts`, `server.billing.test.ts` in `packages/groups`, the downgrade test in `packages/billing`): section 10's pool usage, races and `pool-full` cases on real Postgres, the races on separate connections ordered by row locks held from a third, each break-checked.

Residuals, not fixed here:

- ~~Until step 4 ships, a pooled member's personal plan keeps billing.~~ Step 4 ends it (below). The earlier gap, a personal plan's end moving someone into the pool with no write and no lock, is gone: a personal plan no longer decides who is pooled.
- **The pool can be overfilled by events nobody can refuse:** a move-back (3.5), members' own files growing past a smaller tier before its renewal, and a first plan bought while the organizer's files grow between the guard and the payment. Uploads then pause for everyone; nothing is deleted.
- **Display only, until the apps and step 6:** Android's Account screen subtracts the person's own Trash and versions from `usedBytes`, which while pooled is the pool's rounded total, so its "files" share includes everyone else's. It affects no check.
- **The family folders are one shared part.** A writer to a folder sees nothing finer than whole GiB of the folders' total, but stepping their own folder bytes across a GiB edge they can still tell when another member's upload into the folders, in flight or landed, moves that edge: the folders' part is everyone's, so its rounding can't separate one writer's bytes from another's. What leaks is that someone is uploading into the shared folders, about how much to the GiB, which the folders' listing shows them once it lands. Accepted; per-writer parts inside the folders would need per-writer accounting of shared files.
- **Shown usage can read up to a GiB per part over the quota.** Each part is rounded up, so a full family's figures can read, say, 803 GB used of 800 GB; the free space shown is clamped to 0. Cosmetic: every check counts the same parts.
- **`pool-full` is a coarse probe** (3.2), now at whole-GiB granularity only: the newcomer's files and every part are counted in whole GiB.
- **Tested after review** (`drive.pool.test.ts`): a member stepping her own files a byte at a time across where the exact total would cross a GiB, and around 1 GiB itself, reads the same figures, upload refusals, family total and `pool-full` answers whether the other member stores 100 MiB or 900 MiB over a whole GiB; a payer stepping the family folders' bytes the same way reads the same family total (the downgrade and first-purchase guards' figure) and folder refusals; and a writer to a folder is refused with the same figure whether someone else's upload into it holds 100 MiB or 300 MiB. Break-checked against counting any of the upload check, the figures, the guards, `pool-full` or the folders' part on the exact total.
- **Up to a GiB per part of every pool can't be used** (members plus one: about 5 GiB of a four-person family's 800 GB), the price of counting each part in whole GiB (3.6 step 5).
- **Operators' account list** (`packages/db/src/admin.ts`, `quotaOf`) still shows each account's own allowance, not the pool it draws from.
- **Not in this step:** `GET /api/billing`'s `family`, rounded per-member usage, the first-purchase guard (step 4, below); the leave answer's `ownBytes` and `allowanceBytes`, and the 7.1 meter (step 6).
- **Live verification of a pooled member** needs a family plan written by billing, which only a Polar sandbox checkout can make; the verify-hushos run (`20261019-110254-7416`, `launch --groups`) used `BILLING_PROVIDER=none`: a family made, a member let in and leaving through the new pool lock, and `/api/auth/storage` answering the member's own figures with `pool: null` before and after an upload and after leaving (section 8's no-pooling path). The pooled path is proven by the database tests only.

### What step 4 built (19 October 2026)

`feat(billing): end a personal plan when its owner's files join a family`, with families still off on hushos.com.

- **`billing.end-personal-plan`** (`packages/billing/src/endings.ts`, worker queue in `packages/jobs`): each ending under a lease on its row, revoke, the stored revoke instant, every order's unused share summed signed (a downgrade's credit against it, an upgrade paid from it for it) and placed on what Polar will refund by card, keyed and matched at Polar, Refunds owed after five failed tries in a row and then tried daily, as 5.1 describes. Two tables, `personal_plan_endings` (one row per ended subscription) and `personal_plan_refunds` (one per order), migration `20261019161551_personal_plan_endings`. Queued after an admission commits (route 17), by `reconcileGroup` for every pooled member with a live personal plan, by `reconcileCustomer` and a personal `order.paid` for a pooled person, and by the daily reconcile (`reconcilePlanEndings`), which also re-checks pending refunds and retries failed ones.
- **Refusals while pooled:** `startCheckout` and `resume` answer 409 with `BillingError.code` `in-family` (passed through by `/api/billing/*`); `GET /api/billing` carries `family: { name, planName }` and no sign-up plan while pooled.
- **First purchase** refuses a tier smaller than what the pool would hold (5.2), with the downgrade guard's rounding.
- **Who stores what:** `getGroupBilling`'s `usage` (5.2): rounded per-member figures for `members` and `billing` holders, the caller's own exact figure, the folders rounded. The family page doesn't show the list yet (7.3 is step 6).
- **Operators:** **Refunds owed** on the management page (`/app/admin`), order, account, amount before tax, failed tries and since when.
- **Tests** (`packages/billing/src/server.test.ts`, against the fake Polar with signed webhooks, each break-checked; one admission test in `packages/groups/src/server.billing.test.ts`). The fake follows Polar as the review read its code: a refund at most `net + applied balance − refunded_amount`, `refunded_amount` moving only when a refund succeeds (so pending refunds don't count), tax on every order, and optional latency. The tests: two runs at once (20 ms latency) refunding once, the second asking Polar for nothing; a run that stalled past its lease, which a retry took, not asking for a refund again; a run whose job signal fired asking Polar for nothing; a downgrade then an upgrade paid from its credit (500) and a plain downgrade (200); an operator's pending refund that fails after HushOS's own landed, owed again; a refund made exactly once across a retried job, a webhook replay and a reconcile; a refund whose answer was lost found by its key; one Polar errored on after the card was refunded (recorded without the key) not made again; an order part-paid by an earlier credit of 300 or 800 on 999 (499, and Polar's cap of 199); a downgrade's credit netted; an order that charged nothing settled without listing; an operator's pending refund allowed for, not stacked on; an owed refund tried at most daily; a failed refund retried from the stored revoke time and listed as owed after five; a pending refund that later fails made again; tax excluded (net less earlier refunds); a mid-period upgrade's two orders prorated; the already-revoked path prorating from `ended_at`; no refund for a plan that had ended before pooling; a member who left before the job keeps their plan; the daily reconcile finding a lost job; a renewal paid while pooled refunded whole; a family's first plan queuing its organizer's; the `in-family` refusals for checkout and resume and the ended plan not coming back after leaving; rounded per-member usage; the first-purchase guard.

- **Live verification** (verify-hushos run `20261019-203857-2433`, `launch --groups`, so `BILLING_PROVIDER=none`): the migration applied, the worker made `billing.end-personal-plan` as a `stately` queue, the management page shows **Refunds owed 0** beside Plan changes stuck, and `GET /api/billing` answers `family: null`; `e2e/contacts.spec.ts` (the management page) and `e2e/families.spec.ts` pass against it. Nothing that needs Polar (a revoke, a refund, the owed table with rows) can run with billing off; those are proven by the tests above only.

What Polar's documentation says, which this relies on (read 19 October 2026): `DELETE /v1/subscriptions/{id}` revokes at once, 403 `AlreadyCanceledSubscription` for one already revoked, 409 `SubscriptionLocked` while an update is pending (polar.sh/docs/api-reference/subscriptions/revoke; Polar's `Subscription.can_cancel` allows an immediate cancel of one set to cancel at the period's end); `POST /v1/refunds/` takes `order_id`, `reason`, `amount` (minor units), `comment`, `revoke_benefits`, `metadata`, answers 403 `RefundedAlready`, and documents no idempotency key (polar.sh/docs/api-reference/refunds/create); `GET /v1/refunds/` filters by `order_id` and lists `status` (`pending`, `succeeded`, `failed`, `canceled`) and `metadata` (…/refunds/list); the most an order can be refunded is its net amount, excluding tax, less what it has refunded, and Polar refunds the tax alongside, prorated, and keeps its fees (polar.sh/docs/features/refunds); `net_amount` is "after discounts but before taxes" (…/orders/get). Where the docs are silent HushOS assumes the worst: no idempotency (its own key, matched before every call); a pending refund may still fail (re-checked daily); whether pending or failed refunds count in `refunded_amount` is unknown (HushOS never infers its own refunds from it, only from the refunds list); the period an order paid for is not read from line items (the SDK pinned here, 1.0.0-alpha.20, has no `start_timestamp`/`end_timestamp` on them), but from the subscription's period and the order's reason and date.

Residuals, not fixed here:

- **Nothing here has refunded real money.** The sandbox token has no refund scopes, so no live sandbox refund was made; the refund path is proven against the fake Polar only, whose rules are the documented ones above. Before families come back (step 9), the owner adds the scopes (below) and runs one sandbox family end to end: a personal subscriber let in, their Pro revoked and refunded, the refund's tax and metadata as Polar shows them.
- ~~The downgrade guard's check is exact, and only its words are rounded (manager-only).~~ Fixed by counting the pool part by part (3.6 step 5): the downgrade and first-purchase guards compare the family's total as the pool counts it, each member's own files and the folders in whole GiB, so a payer stepping a folder's bytes learns another member's usage only to the whole GiB, which managers already see (3.9). The probe test 'a payer stepping the family folders byte by byte…' covers it.
- **The refund starts at the revoke, not the admission.** Between the admission and the job (seconds, longer if the worker is down) the plan adds nothing, yet those seconds are not refunded. An order paid after HushOS saw them pooled is refunded whole; one paid before is prorated from the revoke.
- **Above Polar's cap, operators decide.** What Polar won't refund on the period's orders, nor on the customer's earlier card orders (none left, or refused for good), is never sent; operators must look at **Not refundable through Polar** on the management page (and the warn-level log line `Part of a personal plan’s unused days can’t be refunded`), which names the account, family and amount. Nothing pages anyone.
- **Customer balance:** a credit from a downgrade in this period counts against the refund, and an order it paid counts for it, so the credit is never paid out twice; whatever is left in the balance stays at Polar, which documents no way to pay it out, and the person loses it unless they subscribe again (an operator can refund it by hand against the order that charged it). An order paid from a credit made in an earlier period refunds its unused share by card, on the period's orders as far as Polar takes it, then on the earlier card orders the credit came from; what none can carry is listed for operators. Any downgrade with `invoice` proration leaves such a credit.
- **Polar's fee on each refunded order is HushOS's loss** (5.1).
- **An account deleted while a refund is owed** keeps its row (no foreign key), and the job goes on refunding by order id; the Polar customer is deleted with the account, which Polar's refunds API doesn't need. Untested against Polar.
- **Shipped containers of step 3 don't queue the job.** During a rollout, an admission through an older container is caught by the daily reconcile, up to a day later, and prorated from that later revoke.
- **Web copy is minimal:** the Plans page shows the `in-family` refusal's sentence when a pooled person tries to buy; the join page's and the organizer checkout's "Your Pro plan ends when you're let in…" lines (3.3), the pooled member's Plans page (7.4) and the per-member list (7.3) are step 6.

Production steps for the owner (hushos.com), before families are switched back on:

1. In Polar's dashboard (polar.sh, organisation HushOS), Settings → Developers, open the organisation access token whose value is `POLAR_ACCESS_TOKEN` in production, choose Update, tick `refunds:read` and `refunds:write`, and save. The token's value doesn't change; nothing to redeploy.
2. Check it from the production web container: `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $POLAR_ACCESS_TOKEN" 'https://api.polar.sh/v1/refunds/?limit=1'` answers `200` (a `403` means the scope is missing).
3. Do the same in the sandbox organisation (sandbox.polar.sh, HushOS Inc.) for the sandbox token, and run step 9's sandbox check with a personal subscriber.
4. No new environment variable. The migration ships with the deploy; with split database roles the default privileges in docs/self-hosting.md already cover the two new tables.
5. After the deploy, open `/app/admin`: **Refunds owed** reads 0.

### Refunding what the balance paid (follow-up to step 4, 19 October 2026)

On the owner's request: what the period's orders can't carry (paid from the customer's balance) is refunded on the customer's earlier card-paid orders, newest first, within Polar's cap on each (5.1). Refunds already made count first, wherever they are, so a refill never over-refunds. A disputed order's share is dropped (`disputed`, migration `20261019171449_refund_disputed`) and listed, never moved; other refusals are failures; an earlier order failing five times in a row is given up and listed as owed. Unspent balance is never paid out.

What this relies on: Polar's `Order.refundable_amount` is `max(0, net_amount + applied_balance_amount - refunded_amount)` and its refund service checks no order age, raising `RefundsBlocked`, `RefundedAlready`, `RefundDisputedPayment` and `RefundUnknownPayment` (`server/polar/models/order.py`, `server/polar/refund/service.py`, read 19 October 2026); Polar's refunds guide sets no merchant deadline (only Polar's own right to refund within 60 days); Stripe's refunds guide and error codes set none for cards. The fake models a too-old charge as Polar's 500.

Tests (`packages/billing/src/server.test.ts`, break-checked): the 800-credit case refunds 199 on the period's order and 300 on the earlier card order (with the balance-credit comment), never on a newer order in another currency; each earlier order takes at most what Polar refunds on it; an earlier order too old to refund is asked five times, waiting after each 500, then given up and listed as owed, with nothing moved to an older order and no daily retry; a disputed renewal's 499 is dropped and listed, not moved to the earlier order; a disputed earlier order's 300 is dropped, not moved to an older one; a lifted `RefundsBlocked` is retried on the same order and nothing moves meanwhile; after an operator's pending 900 fails, the second run places only what is owed less the 350 already back (800 in all, not 1,050); a lost write, retries and a reconcile refund the earlier order once.

Residuals:

- **Which earlier order the balance came from isn't known.** Polar doesn't say which order credited the balance; HushOS takes the customer's card-paid orders newest first. The refund lands on a card the customer paid with, not necessarily the one the credit came from.
- **Only the newest 100 of a customer's orders are read.** More than that on a personal customer is not expected.
- **A dispute is known only from Polar's refusal.** HushOS can't see a dispute opened after its refund landed; a lost dispute then returns the charge on top of the refund. Polar's own dispute handling (it refunds proactively on early warnings) is the backstop.
- ~~A succeeded refund that later fails on an ending already settled isn't seen.~~ Fixed below.
- **Polar answering `RefundedAlready`** re-reads, and after four passes counts a failed try (below).

### Refunds that fail after they landed (follow-up, 19 October 2026)

Before families go live: the daily reconcile (`recheckSettledEndings`) lists again the refunds of endings settled in the last 30 days and opens any whose refunds no longer hold what HushOS counted (Stripe failed one after it succeeded, and Polar took it back off the order); the job then places it again. Polar's `refund.updated` for a refund carrying HushOS's key that failed or was cancelled opens its ending at once. `RefundedAlready` four passes running counts a failed try, owed after five. Tests (break-checked): a settled refund failed two weeks on is found by the reconcile and made again, and the reconcile after opens nothing; a `refund.updated` delivery opens it at once; a listing that never shows Polar's "refunded whole" ends on the owed list after five runs.

Residuals:

- **An ending settled more than 30 days ago** isn't read again (Stripe's own limit on a refund failing).
- **The webhook needs `refund.updated`** on the endpoint (docs/self-hosting.md); without it the daily reconcile still finds the failure, up to a day later.

### What step 5 built (19 October 2026)

`feat(drive): move files between My files and family folders without spending storage`, with families still off on hushos.com.

- **`moveOf` on upload begin** (`packages/db/src/drive.ts`, `beginUpload`; route `POST /api/drive/uploads`): `{ workspaceId, nodeId, versionId }`, for a new file only, into a workspace the mover holds (their own files or their family's folders, never through a share), from another one they hold and may delete in (not held ahead of a removal). A company area as the source is `policy` (403): the 6.4 hook, a stub that refuses every company until company policies exist. The source must be a live file at `versionId`, not in the Trash (`stale`). Under the pool lock (3.6), a source in the destination's pool (a member's own files and their family's folders while the plan is live, or two folders of one family) lowers the reservation: `max(0, size − what its ready versions free)`, so a move into a full pool goes. A source in another pool (billing off, no live plan, You → a company) lowers nothing: the copy is reserved in full, as an upload is, and needs the destination's room. The source's change sequence, the bytes it frees and the mover are stored on the upload (`move_*` columns, migration `20261019181225_drive_moves`); one live move per file (`drive_uploads_one_move_idx`, `moving`, 409), so a source's bytes never lower two reservations.
- **Completion and attach** lock both workspaces in the 3.6 order: a family folder first (folders in id order, as `lockAreas` takes them), then a personal workspace, as account deletion takes them (an id-order lock deadlocked with a mover's account deletion when their own workspace's id sorted first). They hold the source to what begin found: its workspace there, its mover still allowed to delete in it and to write to the destination (not left, removed or held: the expiry job completes with no writer, and must not land the copy in a folder its mover lost while deleting their original), not trashed or purged, the same change sequence (no rename, move, new or restored version), the same bytes freed (no earlier version discarded), and no upload of a new version of it under way. A move whose reservation leaned on the source's bytes must also still be within one pool, under the pool lock (a member who left, or a plan that lapsed, makes it two); one reserved in full needs no pool. Then the copy is published, the source purged (shares and links revoked) and the upload's `move_*` columns cleared, so no row links the copy to where it came from, in that one transaction; otherwise `move-stale` (409): the copy is released, its object retired, the source untouched, a new version on its way to it included. The expiry job's completion goes through the same checks.
- **Billing off is not a separate path.** The first build refused a move across pools (`not-pooled`) and fell back on the device to a copy and then a delete (trash, read the current version, delete for good). That fallback could delete a new version that landed between the read and the delete, and between the copy and the delete both counted. With no pool at all there is nothing for the source's bytes to lower, so the only difference a pool makes is the reservation: every move now takes the atomic path, reserved in full across pools, and the fallback, its resumable delete list and `not-pooled` are gone. A move never deletes anything but the file it copied, at the version it read, in the transaction that lands the copy.
- **Web:** Move offers **Places** (My files and each of the family's folders) to someone in a family. Before a move to another place the dialog says what it loses and costs: "Only the current version of each file moves; earlier versions are deleted."; "Moving revokes 3 shares and 1 link." when the moved items (or anything in a moved folder) are shared or linked; out of a family folder, "It’s removed from the family folder for everyone in the family, and it doesn’t go to the family’s Trash." and "Each file is signed as yours from now on, in place of whoever added it."; and either "It uses no more of {family}’s storage." (one pool) or "It needs free space in {folder} for the copy; the original is deleted as it lands." Each file is read whole and re-encrypted on the device under the destination's keys (`apps/web/src/lib/move-across.ts`); a read that comes back short of the file's size, or a file whose size this device couldn't open, is refused rather than uploaded, since its completion deletes the original; queued through the upload engine with its stash, as a saved copy is, so it survives a reload; the journal keeps the move with it. A stale move fails in the transfers list with "This file changed while it was being moved, so it stayed where it was. Nothing was copied." Folders are made at the destination, each file moves on its own (each atomic), and a source folder goes to the Trash (not deleted for good: its listing leaves out what was trashed from inside it) once everything in it has moved; a file that went stale stays in it, and so does the folder.
- **Tests:** `packages/db/src/drive.moves.test.ts` (section 10's four, on real Postgres: a move into a full pool, with an earlier version counted, leaves usage unchanged and a byte more is refused; a new version, a rename, a trashed folder, a deletion, a discarded earlier version, a member leaving, the family's plan lapsing under a move that leaned on the pool, and a new version still uploading when the move completes each fail `move-stale`, release the copy and leave the source, and that new version then lands on it; a lapsed plan, a family never paid for and a company area are charged in full or refused for room, out of a company by policy; a reader on another connection held mid-completion sees the state before, never both counted; one move per file; ten pairs of opposite moves at once finish; a move attached as a sibling after an epoch race removes its source, and is stale if the source changed; a mover held ahead of a removal after begin makes the expiry job's completion stale; a completion racing its mover's account deletion, the two queued on a third connection's lock, both finish; a finished move keeps no `move_*` link), `drive.pool-none.test.ts` (billing off: the folder's room pays, and the original goes in the same transaction; a mover who leaves the family, or is held, while the move completes: the route refuses and the expiry job finds it stale, the original kept), `transfers.test.ts` (a move queued before a reload still names its source), and `e2e/families.spec.ts` (billing off: the copy charged to the folder, byte for byte, original gone and not in the Trash; billing on: a move into a full 1 GB pool and the meter doesn't change). Each was break-checked: the full reservation within a pool, counting only the current version, no completion check, the purge in a second transaction, any pool as one, a reduced reservation across pools, the policy allowing companies, no `moving` answer, destination-first locking (a deadlock, 40P01), no source membership check, no pool, destination, trash, change-sequence, freed-bytes or in-flight-version check at completion, id-order locking (40P01 against account deletion), the `move_*` link kept, the source not removed (at completion or attach), no check at attach, holds ignored, and the client never sending `moveOf`.
- **Live verification:** verify-hushos run `20261019-231109-83f6` (`launch --groups`, billing off, before the fallback was dropped): the dialog (Places, the losses), a move from My files into Family, the copy downloaded byte for byte (sha256 equal), the source purged and its 272 bytes freed, and no plaintext marker in the bucket. After it was dropped, run `20261020-015223-e2fa` (billing off): `e2e/families.spec.ts` on Chromium (18 passed, 3 skipped by design) and on WebKit (16 passed; the removal block timed out once under two workers and passed alone), with both billing-off moves completing through `moveOf` (`move_freed_bytes` 272, the source purged, not trashed); and run `20261020-020608-eb2f` (`launch --groups --billing polar`, the plan row written as billing would): the move into a full 1 GB pool passed, the meter unchanged.

Residuals, not fixed here:

- **Every byte goes down and back up through the device** (3.8), and a file is held whole in memory to be re-encrypted, so files over 256 MiB (`MOVE_MAX_BYTES`, the saved-copy limit) can't be moved this way: the dialog refuses before anything is made and says to download and upload. A streaming re-encryption, or a server-side copy that re-wraps only the content key (3.8), would lift it.
- **Across pools a move needs the destination's room** for the whole copy while it uploads: moving a 1 GB file from My files into a family folder with billing off needs 1 GB free in the folder's own allowance, even though the original's GB is freed the moment it lands.
- **The shown pool can move by a whole GB when a file changes part.** The pool counts each part in whole GiB (3.6 step 5), so moving a small file out of a member's files that hold others into the folders can read 1 GB more (a new part) though no byte was added; usage itself is unchanged, and checks count the same parts. A move can likewise leave the counted pool over its quota by up to a GiB per part (each member's own files, and the folders).
- **A stale move copies nothing.** When the source changed (or a new version of it is uploading), the copy is released, not kept beside it, and the person moves it again; nothing of theirs is lost, but the bytes went up for nothing.
- **A folder's source is trashed by the tab that started the move.** After a reload its files still move, but the emptied source folder stays; when trashed it waits out the Trash's 30 days, holding no bytes.
- **Not moved:** files of someone else's shared folder, and nothing into a shared folder; versions other than the current one; tags (a workspace document per space, so a moved file arrives untagged, which the dialog doesn't say).
- **The pooled e2e doesn't run in CI** (no Polar there, and pooling needs billing on): CI runs the billing-off move, which takes the same atomic path with a full reservation; the pooled reservation is covered by the database tests and the run above.
- **Company → You is refused for every company**: the stub has no policy to consult; the web offers no company places, so only the server's `policy` refusal exists. You → a company is allowed and charged to the company (owner decision 1), with no dialog yet, since the web has no company places.
- **The phones** don't move across spaces yet (section 9: with 1d's family folders).
