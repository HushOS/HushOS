# Families: one storage pool for each member's own files and the family folders

An addendum to `docs/groups-design.md` 3.5 (Storage and the payer), decided by the owner on 19 October 2026, the day families launched on the web with no subscribers. Where this and 3.5 disagree, this wins; 3.5 points here, and is rewritten to match when the docs step (section 11, step 7) lands.

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

- **A personal subscriber who joins a family:** their own files move into the family pool at once, and their personal subscription is set to cancel at the end of the period they paid for. No double charge, no early refund.
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

`expires_at` is the plan's period end plus `BILLING_GRACE_DAYS` (3 by default), and it is null for a family that never had a plan (`createGroup` writes `quota_bytes = 0`, `expires_at = null`). So:

- **An organizer who created a family but hasn't paid yet** keeps their own allowance, a paid personal plan included. Their files join the pool when the family's plan goes live, and only then is their personal plan set to cancel.
- **When a family plan ends** (cancelled, or a renewal never paid, past the grace days), every member's own files go back to their own allowance at the same moment, with no job to run: the rule is computed on every check. The family folders read an empty pool, as today.
- **Family folders always read the pool**, as today: a family without a live plan stores nothing in them.

Nothing else adds to the pool while a person is pooled: not Free's 2 GB ("no stacking of free allowances", groups-design 3.5), not referral bonuses, not an operator's grant, not a personal plan still running out its period. Those rows stay in `storage_entitlements` and count again the moment the person is no longer pooled.

### 3.2 Joining

- **Creating a family while in one** is refused, 409 `in-family`: "You're in Lindqvist family. Leave it before you create another."
- **Opening an invitation while in a family** (route 14) succeeds and returns `inFamily: { name }`, so the join page can say: "You're in Lindqvist family. To join Ortega family, leave yours first, from Account → Family. This invitation stays open until 26 October." The invitation email says nothing about it: the server would be telling the inviter, through the email's wording, that the invitee is in a family.
- **Accepting while in a family** is refused, 409 `in-family`, with the same words. This goes further than the default ("can't be let in"): an accepted membership would sit in the other family's pending list, and its managers would learn that the person is in some family. Refusing at accept leaks nothing and costs the invitee one step, since they must leave first anyway.
- **Letting someone in who has since joined or created another family** is refused at admit, 409 `in-family`, before any place is bought: "They've joined another family since they accepted. They can join yours once they leave it." It does not name the other family.
- **The newcomer's own files must fit.** Admission refuses, 409 `pool-full`, when the newcomer's own used and reserved bytes are more than the pool's free space: admitting them would stop every member's uploads at once. The manager reads: "Their files don't fit in the family's free space. Free up space or move to a bigger plan, then let them in." It gives no figure, so a manager doesn't learn the newcomer's usage beyond "more than what's free". The newcomer's join page says beforehand that their files will count against the family's storage, with their own figure.
- **Admission order:** the `in-family` and `pool-full` checks run before `ensureGroupSeat` charges for a place, and again inside the admitting transaction under the locks in 3.6. A race lost between the first check and the transaction (the newcomer was admitted elsewhere, or the pool filled) leaves a paid place and nobody admitted. The place is not lost: it is open for the next person, and the payer can schedule fewer places for the renewal. It is logged; it cannot be avoided without holding a Polar charge inside a database transaction.
- **The first purchase by an organizer whose own files exceed the tier** is refused, as a downgrade is (groups-design 3.5): "Your files take 950 GB, more than Family Plus's 800 GB. Choose a bigger plan or free at least 150 GB."

### 3.3 A personal subscriber joining

When a person becomes pooled (admitted to a family with a live plan, or their family's plan goes live), their own live personal subscription is set to cancel at the end of its period at Polar. They keep it until then, unused. Nothing is refunded. Section 5 has the mechanics.

- **The join page says so before accepting:** "Your Pro plan stops renewing. It ends on 3 November and isn't refunded; from the moment you're let in, your files use Lindqvist family's storage." The same line is on the organizer's checkout for the family's first plan.
- **The managers are not told** that a newcomer pays for a plan: that is the newcomer's business.
- **While pooled, a personal plan can't be bought or resumed:** 409 `in-family`, "Your storage comes from Lindqvist family's plan. Leave the family to choose a plan of your own." Polar's portal can still resume it. When a webhook shows it resumed while the person is pooled, HushOS sets it to cancel again and the Plans page says why. Never both.
- **Leaving before the old plan's period ends:** its entitlement still counts once they are no longer pooled, until the period end plus the grace days, and the Plans page offers to resume it.

### 3.4 Leaving, removal, and plans ending

Their own files go back to their own allowance: 2 GB plus whatever entitlements they still have (a personal plan still in its period, referral bonuses, operator grants).

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

1. Resolve the pool: an area's own group, or, for a personal workspace, its owner's active family membership with a live plan.
2. Lock `group_storage` for that group (`FOR UPDATE`).
3. For a personal workspace, read the membership again. Admit, leave, removal, dissolution and billing's pool write all take the same lock (below), so under it the membership is settled. If it changed between 1 and 3, start over (at most twice; then answer 503 and let the client retry).
4. Lock the target `workspace_storage` row.
5. Sum the pool's used and reserved bytes (3.7) and compare.

Two members uploading into their own My files at once queue on the pool row, and only one of two uploads that each fit alone but not together gets the reservation. That is what `freeBytes` already does for two family folders, extended to personal workspaces.

**Lock order, everywhere:** the `groups` row, then `workspaces` rows (the change-sequence and area locks), then `group_storage`, then `workspace_storage`. Membership changes in `packages/db/src/groups.ts` take `group_storage` after `lockGroup` and `lockAreas`, and never lock a personal workspace's row after it. Releases and purges only lower `used_bytes` or `reserved_bytes`. They don't take the pool lock: lowering can't overspend, and taking it would add a second lock order.

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
- **Outside one pool** (a family without a live plan, whose folders have no room; a company workspace), a move is an ordinary copy plus a delete and needs the destination's free space.

### 3.9 Who sees what

- **Each member** sees their own usage, the family's total and free space, and the family folders' total. From those they can work out the others' combined usage, never any one person's.
- **The organizer and every `members` or `billing` holder** also see each member's own usage (My files, with its Trash and older versions, which count), rounded up to the whole gigabyte, "Under 1 GB" below that. They never see names, counts, types or dates of anyone's files.
- **Rounding happens on the server.** The manager's response carries the rounded figure only, so the exact byte count never reaches another member's browser. Whole gigabytes keep one photo's upload from showing as a change.
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

- **Trigger:** the admitting transaction commits for a family with a live plan, or `reconcileGroup` writes a pool that turned live (the organizer's first purchase, or a family whose lapsed plan is bought again). Either enqueues `billing.end-personal-plan` with `{ userId }` for each newly pooled member who has a live personal subscription not already set to cancel.
- **The job** calls `subscriptions.update(id, { cancel_at_period_end: true, customer_cancellation_reason: 'other', customer_cancellation_comment: 'Moved to a HushOS family plan' })`, then `reconcileCustomer`. Polar is not told the family's name, as now. It is idempotent: a subscription already set to cancel is left alone. Failures retry with backoff (a `stately` queue keyed by the user, like `billing.reissue-pending`).
- **The daily reconcile** looks for pooled people whose personal subscription is live and not set to cancel, and enqueues the job for each. That covers a lost job and a resume from Polar's portal.
- **Webhooks:** no new subscriptions. `subscription.updated` for a personal customer already runs `reconcileCustomer`, which gains the same check. An `order.paid` that renews a personal subscription while its owner is pooled means the cancel never landed. It is logged at error level and listed on the management page under **Personal plans renewed inside a family**, for the operator to refund in Polar. It should never happen; if it does, the person was charged twice, and HushOS must say so rather than keep the money quietly.
- **`startCheckout` and `resume`** refuse while pooled: `BillingError` 409 with the `in-family` copy (3.3). `BillingError` gains an optional `code`, so the web can tell this refusal apart without matching on words.

### 5.2 What the family side changes

- **`getGroupPoolUsage`** becomes `poolUsage` (3.7). The downgrade guard in `changeGroupPlan` and the summary's `storage.usedBytes` read it, so both now count members' own files.
- **`getGroupBilling`'s manager view** gains `members: [{ userId, ownBytesRounded }]`, already rounded (3.9), plus `foldersBytes`. The member view gains `ownBytes` for the caller only.
- **First purchase** (`startGroupCheckout`) refuses a tier smaller than the organizer's own usage (3.2).
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
- **Not pooled without a live plan:** an organizer with a personal Pro entitlement and a family without a plan uploads against Pro; the same family once its plan is live uploads against the pool and ignores Pro; past `expires_at` the organizer is back on Pro (still within its period) and the folders read empty.
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

- **Pooling ends the personal plan once:** admitting a personal subscriber calls Polar's cancel-at-period-end exactly once. A retried job and a webhook replay call it no more, and a failed call is retried. The daily reconcile finds one missed and sets it.
- **No double charge left unseen:** a personal renewal `order.paid` for a pooled person is listed for refund.
- **Refusals while pooled:** checkout and resume answer `in-family`; after leaving both work, and a plan still within its period counts again.
- **Downgrade counts own files:** folders 100 GB plus one member's own 750 GB refuses Family Plus with "free at least 50 GB"; 700 GB is accepted.
- **Move-back below usage:** a reverted upgrade that leaves the family over its pool refuses uploads to My files and the family folders, allows downloads and deletes, and deletes nothing.
- **Leave over quota:** a member with 30 GB leaves to Free; their next upload is `over-quota`, a download works, nothing is purged, and a personal plan entitlement still in its period lifts the allowance.
- **Rounded usage only:** the manager view carries whole gigabytes, rounded up (1 GiB + 1 byte reads 2 GB; under 1 GiB reads "Under 1 GB"). The member view carries no one else's usage, and no response to anyone but the owner carries another member's exact bytes.

**Moves (`packages/db`):**

- A move into a full pool succeeds and leaves usage unchanged.
- A move whose source changed fails `stale`, releases the copy and leaves the source.
- A move across pools (a family with no plan, a future org area) is refused as a move.
- After the completion's transaction the source is gone and its bytes freed, with no state in which both count.

**End to end (`e2e/families.spec.ts`, Chromium and WebKit):** a personal account sees no Families item; an organizer creates a family from Plans, pays in the sandbox, and their meter shows the pool; an invitee in another family sees the leave-first notice; a member moves a file from My files into a family folder and the meter doesn't change.

## 11. Implementation plan

One change per PR, squash-merged, each with the independent review and a `verify-hushos` run where the web changes. In order:

1. **docs: this addendum** (this PR).
2. **feat(db): allow one family per account.** Migration (section 4); repository mapping to `in-family`; `in-family` in `GroupErrorCode`; the checks in create, open, accept and admit (before the seat purchase); the web's copy for them (6.2). Tests: one family.
3. **feat(db): pool a family member's own files with the family folders.** `poolUsage`; `freeBytes` resolving the pool for personal workspaces with the 3.6 lock order and re-check; membership changes taking the pool lock; `getStorageAllowance` and the billing summary on `poolUsage`; `pool-full` at admit; `/api/auth/storage`'s `pool`. Tests: pool usage, races, `pool-full`.
4. **feat(billing): end a personal plan when its owner's files join a family.** `billing.end-personal-plan`; reconcile and webhook checks; refusals while pooled with `BillingError.code`; the management list; the downgrade guard and first purchase counting own files; rounded per-member usage in the manager view. Tests: billing.
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
2. **A personal subscriber joining:** confirm cancel at period end with no refund. A yearly subscriber who joins a month in loses eleven months of what they paid. The alternative is a prorated refund through Polar, which costs the margin and needs the refund path built.
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
2. A personal subscriber who joins a family keeps their personal plan to the end of the paid period, and their own files stay on it until then; after that they draw from the family pool. No refund and no double charge.
3. An invitee already in a family is refused when they accept, not only at "Let them in".
4. No grace period after leaving or removal (nothing is ever deleted).
5. Per-member limits come later.
6. Managers see each member's usage in whole gigabytes, rounded up.
7. Referral bonuses and operator grants don't add to the pool and come back when the person leaves.
8. `pool-full` refuses an admission whose own files don't fit.
9. The migration stops on any account in two families rather than picking one.
10. The one-family rule applies on self-hosted servers without billing.
11. When families return, the rewritten announcement is published (the old one is in drafts), rather than a correction.
