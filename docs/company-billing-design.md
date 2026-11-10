# Company billing: plans, seats, storage and affiliates

**Status:** a design, written on 10 November 2026 and revised three times the same day: after a first independent review (two critical, ten high and sixteen medium findings, and five false statements about the code in section 1), after a second (four high and ten medium, among them two more statements about code and other documents that were false), and after a third (one high and five medium, each a paragraph's fix, with ten low findings, ten passages of stale text and three more statements about the code that were wrong). All are applied; section 14 says where a revision differs from the reviewer's recommendation. Nothing here is built, and the revision that applied the third review has not itself been reviewed. It is the billing design that `docs/companies-design.md` section 6 and `docs/company-storage-design.md` 4.4 leave a hook for.

It builds on family billing as shipped (`packages/billing/src/groups.ts`, `docs/groups-design.md` 3.5, `docs/families-shared-pool.md`) and on what Polar's sandbox actually did (`docs/archive/polar-group-billing-spike.md` 7 and 8). Where this document and those disagree about companies, this one is the plan.

**What changes for people who are not in a company.** Almost nothing, with one exception said here once: sections 8.4 and 9 change how affiliate commission is recorded, held and withdrawn for every order, personal and family ones included. That code is live today, so those changes sit behind their own switch (`AFFILIATE_V2_ENABLED`), not behind `COMPANIES_ENABLED`.

The owner's decisions of 10 November 2026 are fixed inputs: the two plans and their prices, the minimum of three seats, 50 seats self-serve, one storage total per company, per-member limits as ceilings, seats-only pricing on a company's own bucket, affiliates earning on team plans, and one level of sub-affiliates. Seventeen further questions are the owner's and are not decided here: the document is built on a stated default for each, and section 15 lists them first, with what each costs and what changes if the owner chooses otherwise.

No price in this document reaches Polar's production organisation, and `COMPANIES_ENABLED` stays off at hushos.com, without the owner's OK in that turn.

## 0. Decisions in short

| Question                    | Decision                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans                       | Team: 10 USD a seat a month, or 8 a seat a month billed yearly; every seat adds 1 TB to one total for the company. Team with the company's own storage: 6, or 5 billed yearly, no storage cap. Every feature in both                                                                                                                                       |
| Minimum                     | Three seats. A company of one or two pays for three                                                                                                                                                                                                                                                                                                        |
| Other currencies            | EUR at parity, GBP at 0.8 (own storage rounded to 5.00). INR on the personal plans' ratio, **monthly only**, and at most 31 seats on Team and 53 on own storage, with no way past that in this release (section 2)                                                                                                                                         |
| At Polar                    | One subscription per company on the company's team customer. Four products, each the family shape: a fixed base that is three seats, and a unit price that is free up to three and then the seat price                                                                                                                                                     |
| What a seat is              | A place for one member: active, suspended or under notice. Invitations and join requests take none                                                                                                                                                                                                                                                         |
| Who buys                    | Any `billing` holder, on the web. An Admin letting someone in buys the seat that needs only with an acknowledged quote, where the company allows it. Automatic admissions and the phone apps never buy                                                                                                                                                     |
| Limit                       | 50 seats (`groups.seat_cap`, null for the default). Above it the page says to get in touch. An operator raises one company's limit and may set its price                                                                                                                                                                                                   |
| A custom price              | A discount at Polar with no code and no redemption limit, restricted to the team products, put on that company's subscription. It takes effect at the next billing cycle                                                                                                                                                                                   |
| Discount codes              | Polar's checkout never takes a typed code for a team plan. HushOS resolves a code itself and applies only discounts restricted to the team products: at most 20%, for at most 12 months, never `once`, never for ever                                                                                                                                      |
| The storage total           | Seats paid for × the paid product's 1 TB, counted across the company's areas only, for as long as the plan is live. A plan change that is not paid adds no seat, no storage and no day (4.1). A scheduled cut lowers it at once. Never a member's personal space                                                                                           |
| Over the total              | With a live plan: uploads are refused, Owners and `billing` holders are mailed, operators see it. Never closed for it. Nothing is deleted                                                                                                                                                                                                                  |
| Per-member limits           | A ceiling on a member's own company area, set by an Admin. Not a reservation. Shared folders count against the company's total only                                                                                                                                                                                                                        |
| Own storage                 | Counted, never capped. The lower price only while no company file lives in a HushOS region, judged from the product that is paid                                                                                                                                                                                                                           |
| Trial                       | None at launch. A monthly plan is the way to try it                                                                                                                                                                                                                                                                                                        |
| When payment fails          | A renewal that fails keeps everything for as long as Polar keeps the plan `past_due` and retries it, as for a family (4.1, O16). When Polar gives up the company has no plan: nobody is removed and nothing is deleted, uploads and admissions stop. An unpaid plan change is another matter: it gives nothing                                             |
| A company that stops paying | Closed (`groups.closed_at`) after 90 days with no live plan, with four notices; never inside a paid period. Closed, its data admins can still download and its people can still be removed or suspended; nothing is retired, and paying reopens it whole. Purged 30 days later. Own-storage companies included                                             |
| The contact leaving         | Never blocks, and never ends the plan. The contact on record moves in the same transaction. Every charge made on a click (seats, the dearer plan, the yearly plan) stops until each departed holder who may own the card has said it is the company's, an Owner's saying so has stood 7 days unopposed, or a newer card is the default                     |
| Personal spaces             | Separate. A company pays for none of a member's personal storage and joining or leaving changes no personal plan                                                                                                                                                                                                                                           |
| Affiliates on company plans | One affiliate per company, fixed at its first paid order: who the creator signed up through within 90 days, else a code. It earns on that company's billing cycles for 12 months                                                                                                                                                                           |
| Commission safety           | Refunds withdraw commission pro rata; disputes are read from Polar's disputes list; one function works out what is left of an earning from both. New earnings are held 30 days before they can be paid. A clawback is settled by amount, never written off against a smaller payout. An operator can void an earning. For every order, not only companies' |
| Without billing             | No plans and no pool, as today. The allowances of a company's areas may sum to at most `ORG_STORAGE_CEILING_BYTES` (1 TiB by default)                                                                                                                                                                                                                      |
| Sub-affiliates              | One level, each approved by an operator. A share of the parent's commission on the orders the sub brought. The two parts always sum to the commission. HushOS pays each directly, by hand                                                                                                                                                                  |
| Switches                    | Company billing behind `COMPANIES_ENABLED`. Affiliate changes behind `AFFILIATE_V2_ENABLED`. Team products are seeded only with an explicit flag; production needs the owner's OK                                                                                                                                                                          |

## 1. What the code does today

Checked against the worktree at `7edb7aaf`. Each statement names where it was read. The first draft of this section had five statements that were false or incomplete, the second had two more, and the third review found three in the payer rules (which call reads the group's kind, what `isFamilyPayer` decides, and what a checkout does to the former payer at Polar); each is marked **(corrected)**. The end of the section says which files were read in full and which were not.

**Plans and prices.**

- `packages/billing/src/seed-prices.ts` holds every price in minor units per currency: three personal tiers and three family tiers, each monthly and yearly, in USD, EUR, GBP and INR.
- `priceProblem` (same file) refuses a table whose year is not priced in exactly the month's currencies, does not split into twelve whole units of its currency (`amount % 1200`), or costs more than ten months.
- `packages/billing/scripts/seed.ts` creates the products at Polar by name and, with `--update`, replaces prices that differ. **Its environment is production unless `POLAR_ENVIRONMENT` is `sandbox`,** and a product that is missing is created without any flag. So a table added to it reaches production on the next run by anyone.
- A family product is one `fixed` price (the base) and one `unit_based` price per currency: graduated, free up to `included_members`, then the per-member rate, with `minimum_units` at the included count (`familyPrices`).
- `readFamilyProduct` (`provider.ts`) drops any product whose kind is not `family`, whose currencies disagree on the bound or the minimum, or that carries `quota_bytes_per_member`. The comment in `protocol.ts` names that key "the Business shape". No reader offers it.
- `packages/billing/src/seed-prices.test.ts` pins the largest raise in rupees, with 18% GST, under the 15,000-rupee e-mandate limit for every family tier. No such test exists for a company table.

**The customer and the plan.**

- A family's customer at Polar is a team customer with external id `group:<groupId>` and no email. Its `owner` member is the paying person. `group_billing_customers.payer_user_id` is who HushOS lets raise, cut, cancel and open the portal (`requirePayer`, `groups.ts`).
- `familyOf` refuses every group whose kind is not `family`, so no billing route serves a company today.
- `startGroupCheckout` refuses a first plan smaller than what the family already stores (`firstPlanTooSmall`), and a unit count below the larger of the plan's included members and `seatsUsed`.
- The same function pre-applies the payer's discount (`discountFor`) **and passes `allow_discount_codes: true`,** so anyone may type any live code of the organisation at Polar's checkout. Its metadata is `hushos_group_id` and `hushos_payer`.
- One checkout may be open per family (`group_checkouts`). Two live plans are cured by the reconcile (`supersedeOthers`).
- **A checkout by someone who is not the payer on record takes the customer over, and deletes the former payer at Polar.** `ensureTeamCustomer` calls `takeOverPayer` (`packages/billing/src/groups.ts`) when the checkout's maker is not `payer_user_id`. It refuses while a plan is live, here or at Polar. Otherwise it adds the newcomer to the team customer, makes them `owner`, writes `hushos_payer`, moves `payer_user_id`, and then removes the former payer from the team customer (`customers.members.deleteExternal`), "so they no longer see the family's invoices". **(corrected: the third draft did not know this path, and 5.4 promised a former contact is not deleted)**
- Polar answers a raise or an upgrade before it charges the order the change makes; the order is paid a second or two later. The code waits for it (`SETTLE_DELAYS_MS`, six reads over at most six seconds), and "a charge still unpaid when the wait ends is one the bank holds".
- `reconcileGroup` re-reads Polar's state on every webhook and daily, writes `group_billing_subscriptions`, and in one transaction writes `groups.seat_limit` and `group_storage` (`packages/db/src/billing.ts`, the end of the apply function). `seat_limit` is written **on every run,** null when there is no plan.

**Seats.**

- `seatLimitOf` (`packages/db/src/billing.ts`) is the least of the units, the units paid for, and a cut scheduled for the period's end, never below one.
- **`seatsUsed` counts memberships whose state is `active`, and nothing else** (`packages/db/src/groups.ts`). The admitting transaction counts the same way. `suspended` is a state the company spec adds (`companies-design.md` 3.6); no code has it yet. **(corrected: the first draft said a suspended member was counted)**
- `ensureGroupSeat` runs before an admission. With room, it answers `ok`. Without, only the payer's own admission buys the place (a raise with `invoice` proration, charged at once); anyone else gets `payer`. `mayBuy` false never buys: a full plan is `full`.
- `mayBuy` comes from `mayBuySeatFrom` (`packages/groups/src/server.ts`), which reads the request's `HushOS-Client` header: `web` may, anything else may not. It is a header the client sends. `admit` calls `ensureGroupSeat` inside its `beforeAppend`, with no quote or acknowledgement in the call.
- A raise Polar answers with 402 changes nothing at Polar (spike E8) and nothing here.
- **While a raise waits on the bank, the next admission is answered `confirm`,** with no link: `placesHeld` (`packages/billing/src/groups.ts`) reconciles and, when the seat asked for is still above `paidUnits`, returns `{ status: 'confirm', url: null }`. `busy` is the answer only while another change holds the plan's claim. **(corrected: the second draft said such admissions answer `busy`)**
- A place bought for an admission that then loses a race is not lost and not refunded: "it is open for the next person, and the payer can schedule fewer places for the renewal" (`families-shared-pool.md` 3.2).
- A cut is scheduled for the period's end (`next_period`), never below the members admitted or the plan's included count. **A raise deletes a scheduled cut at Polar, and HushOS drops it on purpose** (`setIntendedUnits(live.id, null)`, with the comment "the payer asked for more places now, so the cut is not put back, or they would pay for places they could not fill"). **(corrected: the first draft said the cut is put back)**
- With billing on and no live plan a group has one seat (`UNPAID_GROUP_SEATS`). `FAMILY_MAX_MEMBERS` (20) is passed to the checkout as `max_units` and checked on every raise; Polar enforces no cap of its own (spike E7).

**Storage.**

- `packages/db/src/pool.ts` is one count for a family: the family's folders together, and each active member's own workspace, joined on `group_kind = 'family'`. Each part is rounded up to a whole GiB.
- The pool's size is **the lesser of the tier that is paid for and the product's `quota_bytes`** (`paidQuotaBytes` against `quotaBytes` in the reconcile's write), until the period's end plus `BILLING_GRACE_DAYS` (3). So an upgrade the bank has not confirmed gives nothing. Tiers are told apart and ordered by `quota_bytes` (`tierStateOf`, `changeGroupPlan`). **(corrected: the first draft said "the plan's `quota_bytes`")**
- **With `BILLING_PROVIDER=none` there is no pool at all:** `storageFigures` skips it and every workspace keeps its own allowance, a group's areas included (`GROUP_AREA_QUOTA_BYTES` each). `planLive` reads a pool with no expiry as no plan.
- Per-member limits are deferred for families. When they come they are "one nullable `own_files_cap_bytes` column on `group_memberships`" (`families-shared-pool.md` section 4): a cap on a family member's own files inside the family's pool.

**The payer.**

- A payer cannot leave, be removed or delete their account **while the plan is live and not set to end** (`listGroupsPaidBy` requires `cancel_at_period_end = false`). A payer whose plan is set to end may go. **(corrected: the first draft left out "not set to end")**
- The portal and cancelling stay open to a payer who has left (`createGroupPortalSession`, `cancelGroupPlan`): "they can always stop paying".
- **Four sets of rules act on a plan because of who pays it, and only one call among them reads the group's kind** (the removal write's `payerHold`, in set 4). **(corrected: the second draft counted three rules and missed the routes and the repository; the third said none of them reads the kind)**
    1. **The reconcile and the worker.**
        - `listAbandonedChargeable` (`packages/db/src/billing.ts`) lists a live plan whose payer on record has no `active` membership, and `billing.cancel-dissolved` (`cancelDissolvedPlan`, `packages/billing/src/groups.ts`) sets it to end.
        - `revokeWithoutPayer` (`packages/billing/src/groups.ts`) revokes at once a live plan whose `payer_user_id` is null (the foreign key's set-null after an account is gone).
    2. **Account deletion** (`packages/billing/src/server.ts`).
        - `revokeForDeletion` refuses with 409 while `listGroupsPaidBy` names any group.
        - It then calls `endLapsedFamilyPlansFor`, which, for every group `listGroupsBilledTo` names, revokes the lapsed plans that person pays for (`endLapsedPlansPaidBy`) or refuses the deletion with 409 when one cannot be ended.
    3. **The group routes** (`packages/groups/src/server.ts`).
        - `removeMember` and `removalPreview` refuse with 409 `payer` while `paysForGroup` is true ("They pay for this family's plan").
        - `removeMember` also runs `endPayersLapsedPlan` before the write: the payer's lapsed plans must be confirmed and are then revoked (`lapsedPlansPaidBy`, `endLapsedPlansForDeparture`), or the removal is refused with `payer` or `ends-lapsed`.
        - `leave` refuses with `payer` while `paysForGroup` is true, then runs `endPayersLapsedPlan` the same way.
        - **Whose plans those are is decided in billing, not by `isFamilyPayer`.** `isFamilyPayer` compares the customer row's `payer_user_id` with the person and reads no kind. In `endPayersLapsedPlan` it gates only the reader's rate limit, and in `removalPreview` only whether the preview comes first. The plans come from `lapsedPlansPaidBy`, which calls `findLapsedFamilyPlans(groupId, { payer })` (`packages/billing/src/groups.ts`): that returns nothing unless the customer row's `payer_user_id` is the person asked about, and reports a live plan of theirs that is not set to end as `charging`, which refuses the change. **(corrected: the third draft had `isFamilyPayer` decide whether the rule runs)**
    4. **The repository, under the group's lock** (`packages/db/src/groups.ts`).
        - `payerHold` answers `busy` while a plan change holds its claim and `pays` while a plan the departing payer pays for renews. It has two callers. `depart` (a leave) calls it for a group of any kind. The removal's roster write calls it only when `group.kind === 'family'`: that one call is already family-only.
        - `billedPlan` makes the last member's leave answer `billed`, and `deletionBlockers` lists the same reason, while a plan is live and not set to end.
- Handover between `billing` holders is not built (`groups-design.md` 9).

**Affiliates.**

- Operators enrol affiliates at `/app/admin/affiliates`. Each has a slug (`/go/<slug>`), a code that is also a percentage discount at Polar, and `commission_bps`. `validate` in `growth.ts` allows 1 to 100 percent and the durations `once`, `repeating` and `forever`. The discount is not restricted to any product.
- A sign-up through the page or the code writes one `referrals` row for the new account. `attributeSignup` refuses a person's own invite code; nothing refuses an affiliate signing up through their own page.
- On `order.paid`, `recordAffiliateEarning` (`server.ts`) pays the affiliate whose discount the order used (`findAffiliateByDiscount`), else the one the customer signed up through (`findAffiliateForCustomer`). For a group's order the customer is the payer recorded on the checkout (`hushos_payer`).
- The commission is `floor(net_amount × commission_bps / 10000)`, one `affiliate_earnings` row per order, under an advisory lock per order (`recordEarning`, `packages/db/src/growth.ts`). The insert is `onConflictDoNothing({ target: order_id })`, so it needs a unique index on `order_id` alone. An order whose net amount is zero or less records nothing. `net_amount` and `commission_amount` are `integer` columns.
- **Commission is withdrawn only for an order HushOS itself refunds whole** (`withdrawEarning`, called from `refundOrder` and `endUnwantedFamilyPlan` in `endings.ts`). It deletes an unpaid earning and keeps the order's id in `affiliate_withdrawn_orders` so no later delivery records one; an earning already paid out is kept and marked `order_refunded_at`. The webhook acts on `order.paid`, and on `refund.updated` only for a refund carrying HushOS's own key that failed or was cancelled (`noteRefundUpdated`). There is no handler for `order.refunded` or `refund.created`. A refund an operator makes in Polar and a partial refund leave the commission as it was.
- **A dispute is not a refund, and HushOS sees one only by accident.** `endings.ts` says so where it names `RefundDisputedPayment`: Polar refuses to refund a disputed charge, and "if the customer wins the dispute the chargeback returns the whole charge". `families-shared-pool.md` records the residual: "A dispute is known only from Polar's refusal. HushOS can't see a dispute opened after its refund landed." So a chargeback returns the customer's money outside the refund path, and nothing in HushOS learns of it. **(corrected: the second draft said Polar records a lost dispute as a refund, and cited `endings.ts` for it)**
- **What Polar offers for disputes.** The SDK pinned in `packages/billing/package.json` (`@polar-sh/sdk` 1.0.2) has `disputes.list({ order_id, status })` and `disputes.get`, behind the `disputes:read` scope. A `Dispute` carries `order_id`, `amount`, `currency`, `created_at` and a `status` of `prevented`, `early_warning`, `needs_response`, `under_review`, `lost` or `won`; the SDK's comment says `prevented` "means we issued a refund before the dispute was escalated". Its webhook types are `order.*`, `refund.created`, `refund.updated`, `subscription.*` and `customer.*`: there is none for a dispute. The organisation's feature settings in the same SDK carry a `disputes_enabled` flag ("the disputes dashboard"), so whether the list answers for an organisation without it is not known (run E22).
- **Pausing an affiliate writes `active = false` and nothing else** (`updateAffiliate`). HushOS then shows no page and pre-applies no discount for them (`resolveCode` and `discountFor` read `active`). The discount stays live at Polar, checkouts take typed codes, and neither `findAffiliateByDiscount` nor `findAffiliateForCustomer` reads `active`. So a paused affiliate's code typed at Polar's checkout still applies and still earns. **(corrected: the first draft said the code is no longer honoured)**
- An affiliate with unpaid commission cannot be deleted (`deleteAffiliate`, 409). Deleting one deletes the attributions that named them and, by cascade, their ledger rows.
- `markEarningsPaid` marks every unpaid row of an affiliate paid at once. Nothing holds an earning back for any time.
- An affiliate whose account is linked sees their figures on Invite friends through `view()`, which also returns the operator's `notes`, `providerDiscountId` and `pendingEmail` to them.

**Currency.** A checkout may be told to use a currency only when it is the currency of the country the request came from (`chargeableCurrency`, `apps/web/src/lib/currency.ts`). It is decided once, from the request, and stays for the life of the subscription.

**The pricing page** (`apps/web/src/routes/pricing/route.tsx`) shows a Team card as "coming", with what teams can already do.

**What was read.** In full for this revision: `packages/billing/src/endings.ts`; `docs/families-shared-pool.md`; `packages/groups/src/server.ts` from `mayBuySeatFrom` through `admit`, `removeMember`, `removalPreview`, `endPayersLapsedPlan` and `leave`; `packages/billing/src/server.ts` from the reward functions through `revokeForDeletion`, `endLapsedFamilyPlansFor` and `handleWebhook`; `payerHold`, `billedPlan`, `depart` and `deletionBlockers` in `packages/db/src/groups.ts`; `recordEarning`, `withdrawEarning` and `markEarningsPaid` in `packages/db/src/growth.ts`; `docs/company-storage-design.md` 10.2 to 10.5; and the SDK's disputes service and `Dispute` type. For the third revision: `endPayersLapsedPlan`, `isFamilyPayer`, `lapsedPlansPaidBy` and `findLapsedFamilyPlans`; `ensureTeamCustomer` and `takeOverPayer`; both callers of `payerHold`; `SETTLE_DELAYS_MS` and its comment; and `docs/companies-design.md` 3.6, 3.7 and 4. **Not read in full:** `packages/billing/src/groups.ts` (3,748 lines) outside the checkout, the seat purchase, the plan change, the payer and lapsed-plan functions and the reconcile's projection; the operator's affiliates page beyond what it calls. Statements above come only from code that was read.

## 2. Plans and prices

### 2.1 The table

Per seat, before tax where tax is added on top (the US, Canada and India; elsewhere it is included, spike 4).

| Plan              | Billed  | USD | EUR | GBP | INR         |
| ----------------- | ------- | --- | --- | --- | ----------- |
| Team              | Monthly | 10  | 10  | 8   | 399         |
| Team              | Yearly  | 96  | 96  | 72  | not offered |
| Team, own storage | Monthly | 6   | 6   | 5   | 239         |
| Team, own storage | Yearly  | 60  | 60  | 48  | not offered |

A year by the month: 8, 8 and 6 for Team; 5, 5 and 4 on own storage.

How each figure follows the personal plans (`seed-prices.ts`):

- **EUR** is at parity with USD, as every personal and family price is.
- **GBP** is at 0.8, as every personal and family price is. On own storage the ratio gives 4.80 a month; the table has 5.00, with the year unchanged at 48 (4.00 a month). Section 15, O10.
- **INR** follows the personal ladder, not an exchange rate. Personal Pro is 10 USD and 399 rupees; a Team seat is the same. Personal Plus is 5 USD and 199 rupees; 6 USD at that ratio (39.8) is 239.
- **No yearly price in rupees.** A yearly charge for four or more Team seats is above what an Indian card may be charged without the cardholder present (2.4). When a real-card run shows such renewals succeed, the yearly prices by the same ratio are 3,900 for Team and 2,400 for own storage (200 a month; the first draft's 1,980 followed 33 to the dollar, not the ratio).
- **A year** splits into twelve whole units in every currency it is priced in and costs at most ten months: 9.6 months for Team in USD and EUR, 9 in GBP; 10 on own storage in USD and EUR, 9.6 in GBP.

The tables as `seed-prices.ts` will hold them, in minor units, with the base being three seats:

| Product                     | Base (three seats)       | Each seat past three   |
| --------------------------- | ------------------------ | ---------------------- |
| Team (monthly)              | 3000, 3000, 2400, 119700 | 1000, 1000, 800, 39900 |
| Team (yearly)               | 28800, 28800, 21600      | 9600, 9600, 7200       |
| Team, own storage (monthly) | 1800, 1800, 1500, 71700  | 600, 600, 500, 23900   |
| Team, own storage (yearly)  | 18000, 18000, 14400      | 6000, 6000, 4800       |

Columns are USD, EUR, GBP, INR. Checked by script: every yearly amount, base and seat, divides by 1,200; none exceeds ten months; every base is exactly three seats.

**What `priceProblem` must allow.** Today it requires a year in exactly the month's currencies. It gains one option, `yearIn: 'subset'`, used by the team tables only: the year may leave out currencies the month has, never add one, and the default currency must be in both. Personal and family tables keep `'same'`. `seedPriceProblems` gains the per-seat tables, the rule that a base is exactly three seats, and the rupee rule of 2.4.

### 2.2 The products at Polar

Four products, each a monthly or a yearly one, since Polar fixes the interval when a product is made (spike 1).

Each is the family shape, which the sandbox has already accepted in all four currencies (spike E2):

- one `fixed` price per currency: the base, three seats;
- one `unit_based` price per currency, graduated: `{ bound: 3, unit_amount: 0 }` then `{ bound: null, unit_amount: <seat price> }`, with `minimum_units: 3` and the unit label "seat" / "seats".

So n seats cost exactly n times the seat price for every n from three up, and Polar refuses a checkout or a scheduled cut below three (`BelowMinimumUnits`, E3).

Metadata:

| Key                      | Team                             | Team, own storage |
| ------------------------ | -------------------------------- | ----------------- |
| `hushos_plan`            | `team`                           | `team-own`        |
| `hushos_group_kind`      | `org`                            | `org`             |
| `included_members`       | `3`                              | `3`               |
| `quota_bytes_per_member` | `1099511627776` (1 TB, in 1024s) | absent            |
| `hushos_storage`         | absent                           | `own`             |

- `readCompanyProduct` is a new reader beside `readFamilyProduct`. It takes kind `org` only, requires exactly one of `quota_bytes_per_member` and `hushos_storage: own`, and applies the same checks: every currency agrees on the bound and the minimum, the bound is `included_members`, the default currency is present, unit amounts parse as decimal strings.
- It also requires the base to equal three times the seat price in every currency. A product where it does not would sell seats at two prices, so it is dropped and logged.
- `readFamilyProduct` and the personal reader are unchanged: each already ignores a product of another kind.

**The seed never makes a team product unasked.** `seed.ts` creates and updates the four team products only when run with `--team`. With `--team` it refuses to run unless `POLAR_ENVIRONMENT` is set explicitly, to `sandbox` or to `production`: the default that sends a forgotten variable to production does not apply to them. A test runs the script's planning step with no flag against a catalogue that lacks them and asserts nothing is created.

**Why not a unit price alone.** A product with only a unit price and a minimum of three would give a cleaner invoice (one line, "5 seats"). No sandbox run has made one. The family shape is proven, and the catalogue reader, the quote arithmetic (`quoteUnitsChange`) and the reconcile already speak it. The cost is an invoice with two lines. Run E9 looks at the invoice; its result changes no decision here.

### 2.3 What the spike says will happen

Every point below was seen in the sandbox on the family shape (spike 8), and holds for seats because the shape is the same:

- A raise is one call, `subscriptions.update(id, { units, proration_behavior: 'invoice' })`. It makes a `subscription_update` order and charges it off-session at once, by the second over the real period, truncated to the minor unit.
- Each raise is its own order with its own tax and its own fixed fee at Polar.
- A declined raise (402 `PaymentFailed`) leaves the units, the status and the orders untouched. HushOS lets nobody in before the 200.
- A cut with `next_period` waits for the renewal and credits nothing. **Any later raise deletes it at Polar, and HushOS does not put it back** (section 1): whoever asked for more seats is not then cut at the renewal.
- A plan set to cancel refuses every quantity change (403) until it is resumed.
- Polar has no preview. HushOS quotes "about" from `quoteUnitsChange` and takes the amount charged from the order.
- **A discount on the checkout reaches every raise in the period it covers** (spike, second card round: a 100% `once` discount made a raise free, with no order at all). Section 3.5 is built on that.
- A mid-period change to a dearer product with `invoice` keeps the anniversary and charges the prorated difference at once (spike 8, T2, with a card).

**What the spike did not show, though the second draft said it had.** A change from a monthly to a yearly product was run once, on a free subscription (spike E4 part 2). What that run showed:

- the call passes, and the units stay;
- **a new period starts at the moment of the switch,** and ends a year later;
- Polar made a `subscription_update` order one second later, even though `prorate` was asked for. Its total was 0, because the plan was free.

So what such a switch charges a paying company has never been seen, nor what the subscription looks like while that charge waits on a bank. Section 6.5 is built so that neither can give a company a year it has not paid for, and its part of PR 12 waits for runs E19 and E20.

### 2.4 Rupees

Two facts, both from the spike:

- An off-session card charge above 15,000 rupees needs the cardholder to authenticate, and the sandbox declined one outright, leaving nothing to pay in the portal (E8). With 18% GST that is any charge above 12,711 rupees before tax.
- A subscription's currency is fixed at its checkout, from the country the request came from (section 1).

So, for a company billed in rupees:

- **Monthly only.** A year of four Team seats (15,600 before tax) or seven own-storage seats is already over the limit, and a renewal cannot be split.
- **At most 31 seats on Team and 53 on own storage** (`INR_SEAT_MAX`, derived in `seed-prices.ts` from the seat price and the limit, not typed). 31 × 399 with GST is 14,595.42 rupees; 32 is 15,066.24. 53 × 239 with GST is 14,947.06. A raise past it, and a checkout above it, is refused (402 `seats`, reason `rupees`): "Plans billed in rupees can have up to 31 seats, because banks in India refuse larger automatic payments."
- A test pins both: the largest monthly renewal and the largest single raise in rupees, with GST, stay under 1,500,000 paise on both plans, as the family test does.

**There is no way past the ceiling in this release.** Said plainly, because the second draft implied one:

- A company that pays by Indian card stops at 31 seats and 31 TB on Team, or 53 seats on its own storage. An operator raising `seat_cap` changes nothing for it: the lesser of the two applies.
- A subscription's currency cannot be changed, and a checkout's currency follows the country of the request (section 1). So "bill it in another currency" is not something an operator can do from the management pages, and another currency would not lift a limit that belongs to the card.
- A rupee company on its own storage with more than 31 seats cannot switch to Team.
- What would lift it is a payment the cardholder authorises each time (an invoice paid by hand, or a mandate above the limit). Polar's public calls offer neither. It needs a real Indian card to find out what is possible, and is section 15's O1 and O2.
- The refusal does not send people to support, since support has nothing to offer them.

**Why a ceiling and not split raises.** The first review suggested splitting a large raise into charges under the limit. That works for the raise and fails at the next renewal, which is one charge for every seat: a company grown to 40 seats by four small raises would fail every renewal from then on and lose its uploads. The ceiling is the only rule that keeps a rupee plan renewable.

**Anyone can reach rupee prices through an Indian address.** The currency follows the request's country and stays for good. The ceiling bounds what that is worth: 31 seats for 12,369 rupees a month, about 140 USD against 310. Beyond that:

- every reconcile compares the billing country on the subscription's newest paid order with the country its currency belongs to, and writes a mismatch to `group_billing_customers.currency_mismatch_at` (cleared when they agree again);
- the operators' Companies page lists them. Nothing is changed automatically: a travelling founder is not a fraud;
- whether an order carries the billing country has not been read from Polar (run E17 looks). If it does not, the comparison uses the customer's billing address.

Whether Polar itself refuses rupees for a billing address outside India is not established (run E17).

## 3. Seats

### 3.1 The rules

- **A seat is a place for one member of the company.** One predicate, `holdsSeat`, says who holds one: a membership whose state is `active` or `suspended`. A member who has given notice (`companies-design.md` 3.6) is still `active` until the notice ends, so they hold theirs.
- **Every count uses it:** `seatsUsed`, the count in the admitting transaction, the floor of a cut, and the floor of a checkout. It is one exported SQL fragment in `packages/db/src/groups.ts`, and a test fails if any of the four counts another way. Without it a company could suspend ten members, admit ten more into the freed seats and resume the first ten: twenty members on ten seats.
- For a family nothing changes: a family has no suspended state.
- **Invitations and join requests take none.** A seat is counted in the admitting transaction, under the group's lock, as today.
- **A seat is freed** when the removal's roster lands or the departure is recorded at the end of a notice. It is not refunded: the company keeps the seat it paid for until the period ends, and may let someone else into it.
- **People a file was shared with from outside the company never count.**
- **A cut never removes anyone.** It is refused below `seatsUsed` and below three, and from the moment it is made it stops admissions past the new count and lowers the storage total (4.1).

### 3.2 Who buys a seat

Three ways a seat is bought, all on the web:

1. **At checkout,** by a `billing` holder: any number from the larger of three and `seatsUsed`, up to the company's limit, and never fewer than what is stored needs (4.4).
2. **Ahead of need,** by a `billing` holder on the company's Billing page ("Add seats"), with the amount Polar will charge shown first.
3. **When someone is let in and no paid seat is free,** by whoever lets them in, where the company allows it and only with an acknowledged quote (3.3).

The third is what "billing starts when someone is let in" means, and it differs from a family, where only the payer's own click spends the payer's money.

- **The setting:** `groups.seats_on_admission`, null, true or false. Null follows the plan: on for a monthly plan, off for a yearly one, where one click costs most of a year and nothing can be handed back. A `billing` holder changes it.
- **A ceiling:** `groups.admission_seat_limit`, the most seats that may be bought at admission in a calendar month (default 10, null for none), set by a `billing` holder. Past it an Admin without `billing` is told a billing holder must add seats.
- **The ceiling is counted from purchases that happened, not from quotes.** Every seat purchase writes a row in `group_seat_purchases` (the group, the subscription, `from_units`, `to_units`, how it was bought: `checkout`, `add` or `admission`, and when) in the transaction that records Polar's answer. The month's count is the sum of `to_units − from_units` over that month's `admission` rows, read under the group's lock. A quote lives ten minutes and proves nothing was bought; the second draft had nowhere else to count. The row names no account: who bought is in the mail and, later, the ledger (11.1).
- **A raise whose answer was lost still gets its row.** A call to Polar that times out after the raise happened records nothing in that transaction, and the third draft left such a raise out of the month's count for good. So:
    - the row carries the raise's order id at Polar, unique, so the call's own transaction and the reconcile can never both write it;
    - a quote is marked `spending_at` before the call to Polar and is deleted only once its purchase row exists;
    - the reconcile, when it reads a paid `subscription_update` order that raised the units and has no row, writes one: `from_units` and `to_units` from the step it sees, the order's `created_at`, and how it was bought from the quote marked as being spent for that step (`admission` or `add`). A raise no quote accounts for (one made in Polar's dashboard) is written as `add` and counts toward no Admin's ceiling.
- Off, or past the ceiling, an Admin without `billing` is told every seat is taken and who can add one; nothing is charged.
- Every seat bought this way sends the `billing` holders one email: who let whom in, the amount, the new count.
- **An automatic admission never buys** (`companies-design.md` 3.2), and that is decided by the server from the roster, not from the client: a call whose roster carries the `auto` field passes `mayBuy: false` whatever `HushOS-Client` says, and the claim route for automatic admissions (C25) takes no `buySeat` at all: one sent with it is refused as malformed. An Admin's open web tab that claims an automatic admission is a web client; the header alone would let it spend.
- **The phone apps never buy,** as for families (`mayBuySeatFrom`): a phone's admission into a full plan says every seat is taken, with no link out.

`ensureGroupSeat` gains the company's rule beside the family's:

| Group   | Buys when                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family  | The admitter is the payer, from the web (unchanged)                                                                                                                                                           |
| Company | The call carries a valid quote (3.3), is from the web, is not automatic, the card rule of 5.4 allows it, and the admitter holds `billing`, or holds `members` with the setting on and the ceiling not reached |

### 3.3 The quote a purchase must carry

A click that spends money names what it agreed to, and the server checks it.

- `POST /api/groups/:id/billing/quotes` answers `{ quoteId, units, added, about: { amount, currency }, then: { amount, currency, interval }, expiresAt }`. `units` is the total after the purchase. The amount is `quoteUnitsChange`'s, with any discount on the subscription applied. Its body is one of two:
    - `{ units }`, from a `billing` holder, for "Add seats": any total up to the limit;
    - `{ admitting: [userId, …] }`, from whoever is letting those people in. **It names people, not a number.** Each must be waiting to be let in at that moment (an accepted invitation or a filed join request), or the call is refused as malformed. **The server works `units` out itself:** the seats held (`holdsSeat`, 3.1) plus the people named, and only when that is more than the seats paid for. An Admin without `billing` cannot name a total, and cannot name more people than are waiting. The third draft took a bare count, `{ admitting: n }`, tied to nobody: an Admin could ask for ten with one person waiting and buy ahead up to the monthly ceiling.
- A quote is a row (`group_seat_quotes`: id, group, the account it was made for, the subscription, `from_units`, `units`, the people it is for (`admitting`, null for "Add seats"), the subscription's `current_period_end` as read, the amounts, `spending_at`, `expires_at` ten minutes on). It is spent once, and deleted when spent or expired.
- **An admission that needs a seat** carries `buySeat: { quoteId }`. The server buys only if the quote is that admitter's, unexpired, unspent, for this subscription and its current period, `from_units` is still what is paid for, the person being admitted is one the quote names, and **`units` equals the seats held plus the people the quote names who are still waiting**, counted again under the group's lock. Otherwise the answer is 402 `seats`, reason `quote`, with a fresh quote in `data`, and nothing is charged.
- **A quote does not straddle a renewal.** One made in a period that has since ended is refused the same way: what it showed was the rest of a period that is over.
- So the two races the review named end without a charge nobody saw: an Admin whose dialog showed a free seat that a colleague then took gets the quote to accept; a resent kept call carries a spent quote.
- "Add seats" on the Billing page carries a quote the same way.
- **Many at once.** Letting in several people from the requests queue asks for one quote (`admitting`, naming them) and makes one raise, then admits each into the room it made: one order, one fee at Polar, one mail, and no run of small charges for a bank to decline. The raise is its own call (`POST /seats` with the quote), made before the first admission.
    - **Who may make that call.** A `billing` holder, with any quote of theirs. A `members` holder without `billing`, only with a quote that names people (`admitting`), and only where 3.2 lets them buy: the setting on, the month's ceiling not passed by this raise, from the web. The third draft had an Admin make this call in one place and kept the route to `billing` holders in another.
    - **The same check as one admission's,** under the group's lock: every person the quote names must still be waiting, and `units` must equal the seats held plus them. If one has been let in by someone else or has withdrawn, the answer is `quote` with a fresh quote for those who remain, and nothing is charged.
    - Its purchase row is an `admission` one and counts toward the month's ceiling, whoever made it.
- **If the device stops part-way,** some of the seats it bought have nobody in them. They are not refunded and not lost: they are paid seats, open to the next admission, and a `billing` holder can schedule fewer for the renewal. That is what a family's place bought for a lost race does today (section 1).

A refusal is 402 `seats` with the reasons family admissions already use (`no-plan`, `cap`, `canceling`, `declined`, `confirm`, `payment`, `full`, `busy`, `unconfirmed`), and for a company also `quote`, `payer` (buying at admission is off or past its ceiling), `card` (5.4) and `rupees` (2.4).

**A charge the bank wants confirmed.** A `billing` holder who gets `confirm` is sent to Card and invoices, as a family's payer is. An Admin without `billing` is not a member at Polar and has no portal. For them:

- the answer is `confirm` with no link and the names of the `billing` holders;
- every `billing` holder is mailed "Sam asked to let Priya into Acme. Your bank wants the charge for the seat confirmed", with the way to Card and invoices, and the Billing page shows the same line until it is settled;
- the Admin sees "Waiting for {names} to confirm the charge with the bank";
- a raise nobody confirms is cut back after `STALE_RAISE_DAYS`, as for families, and meanwhile its seat does not count (`paid_units`). Other admissions that need it are answered `confirm` again, as the code does today (`placesHeld`, section 1), and are never charged a second time.

Where such an order goes at Polar has never been seen (spike, still untested); this path is built on Polar's documentation.

### 3.4 The limit, and past it

- `ORG_SEAT_LIMIT_DEFAULT` is 50 (`companies-design.md` 3.11).
- **`groups.seat_cap`** is the limit for one company; null means the default. It is passed to the checkout as `max_units` and checked on every raise and admission, as `FAMILY_MAX_MEMBERS` is for a family. A rupee plan's limit is the lesser of it and `INR_SEAT_MAX`.
- **This is a new column, not `groups.seat_limit`.** The company spec has the operator set `seat_limit`. That column is the seats paid for, which the reconcile rewrites on every run (section 1). Two meanings cannot share it, so the operator sets `seat_cap`, and `companies-design.md` needs correcting in four places: the `groups` row of its table in 1.4, the Seats bullet of 3.11, route C28's body, and the billing row of its section 6.
- At the limit the Billing page says: "Acme has 50 seats, the most a company can add here. To add more, write to {support address}."
- An operator raises it on the Companies page of the management area (C28), which is recorded. The new limit takes effect under the group's lock.
- **A typo cannot buy a thousand seats:** one raise never passes the limit, and the quote shows the charge before it is made.

### 3.5 Discount codes on a team plan

Today a group checkout pre-applies the payer's discount and lets anyone type any code at Polar. For a seat plan that is a hole: a discount on the checkout covers every raise in the period it covers (2.3), and affiliate discounts may be up to 100% and `once`. A "50% once" code on a yearly plan would halve three seats today and forty-seven more tomorrow; a 100% one would give fifty seats and 50 TB for a year for nothing.

- **A team checkout always passes `allow_discount_codes: false`.** Polar's page offers no code field.
- **HushOS takes the code,** in a field on its own checkout step, and resolves it itself. It applies a discount only if all of these hold:
    - it is restricted at Polar to the team products and to nothing else (`productIds` non-empty and a subset of the four);
    - it is a percentage of at most `TEAM_DISCOUNT_MAX_PERCENT` (20);
    - its duration is `repeating`, for at most `TEAM_DISCOUNT_MAX_MONTHS` (12).
- **Never `once`, and never `forever`.**
    - `once` is refused on every team product, monthly ones included. Polar's page says "Once covers the first billing cycle after it's applied, so its value follows the length of that cycle". A company could check out monthly with a `once` code and switch to yearly the same day (6.5): the "first cycle" would then be a year, and every seat added in it would be discounted too. The second draft allowed `once` on monthly products and so had that hole.
    - `forever` is refused because it compounds with commission for as long as the company exists.
- Anything else is "That code can't be used for a team plan", and no discount is sent. A discount an operator makes at Polar for a promotion follows the same rules or is ignored; nothing depends on remembering to restrict it. Whether it carries a code at Polar does not matter, since Polar's checkout takes none for a team plan.
- **An affiliate's own discount is never used for a team plan.** Each affiliate who may sell team plans gets a second discount at Polar, the team discount (section 8.2), made to those rules and with no code at Polar.
- `discountFor` gains a `kind: 'team'` branch that returns only such discounts. The family and personal branches are unchanged.
- **A `repeating` discount shorter than a year still covers a whole yearly charge. That is a stated cost, not a refusal.** A discount takes its percentage off every charge made while it runs, and a yearly charge is one charge. So on the yearly product a discount of any length is worth up to a year, and a company that switches to yearly (6.5) in a 12-month discount's eleventh month has had eleven discounted months and then a discounted year.
    - **The bound:** one yearly period at the discount, beyond the months the discount was meant for: at most 20% of what the company pays in that period, once for each discount. On fifty seats in USD from its first day that is 960. It is stated for the worst reading, in which seats added later in that year are discounted too, as a discount on a checkout reaches every raise in the period it covers (2.3); run E13 shows whether they are once the discount's months have run.
    - **Why the switch is not refused while a discount runs.** A first checkout on the yearly product with a three-month discount gets the same year at 20% off, so refusing the switch would close one door and leave the one beside it open. And it would keep every discounted company off the yearly plan for up to twelve months, when a year paid ahead is what HushOS wants from them.
    - Commission does not grow with it: 8.3 pays for the part of an order inside the term and no more. Section 15, O11, carries the cost.

**What HushOS keeps.** On 100 of list price, a 20% discount leaves 80. An affiliate's 20% commission on that is 16. HushOS keeps 64, before Polar's fees, for the twelve months both run, and 100 after. With the second draft's 30%, allowed for ever, it was 56 for twelve months and 70 from then on. The two caps are the owner's to set (section 15, O11).

### 3.6 A custom price

Polar has no price per customer. Two ways to give one company another price:

|                  | A discount on the subscription (recommended)                                                                                      | A product of its own                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| What it is       | A percentage discount with no code, duration forever, restricted to the four team products, with no redemption limit              | A fifth product, "Team (Acme)", with its own prices, offered to one company            |
| Precision        | Basis points: 7.25 a seat on a list price of 10 is 2,750                                                                          | Any amount in any currency                                                             |
| Starts           | New company: on its checkout. Existing plan: "the change will be applied on the next billing cycle" (Polar's subscription update) | At a product change, prorated                                                          |
| Renewals         | Stay discounted: "once applied to a subscription, the discount stays on through plan changes" (Polar's discounts page)            | Naturally                                                                              |
| Cost             | One subscription holds one discount, so it replaces an affiliate's team discount on that plan                                     | The catalogue, the seed and the reader all learn a product that belongs to one company |
| Above list price | Not possible                                                                                                                      | Possible                                                                               |

The discount is enough for what was asked (a lower price for a company that needs more than 50 seats). It is a price, not a promotion: it lasts for ever by design, only an operator can set it, and 3.5's caps on codes do not apply to it.

- **No redemption limit.** The first draft limited it to one use. Putting it on a subscription is a use, so the next checkout that company ever needs (after a lapse, say) would be refused. It has no code, so only HushOS can apply it, through the API; a limit protects nothing.
- **In the database:** `group_billing_customers` gains `custom_discount_id`, `custom_bps` (1 to 9,000 basis points off the list price), `custom_note`, `custom_set_by` and `custom_set_at`.
- **Setting it** (an operator, on the Companies page): HushOS creates the discount at Polar, stores it, and puts it on the live subscription if there is one; otherwise the next checkout carries it as `discount_id`. A checkout that carries it takes no typed code (3.5), so a customer cannot swap a larger public code in.
- **Changing it** makes the new discount, puts it on the subscription, and deletes the old one only once a reconcile has read the subscription back with the new one on it. Deleting first would leave a company at list price if the second call failed. **Removing it** sets `discount_id: null`: the company is then at list price. An affiliate's team discount it replaced does not come back; the screen says so before the operator confirms.
- **At renewal** the discount is still on the subscription. If someone deletes it in Polar's dashboard, the reconcile sees a subscription whose discount is not the one on record and lists the company for operators; it changes nothing by itself.
- **What it cannot do, said on the operator's screen:** a price agreed today with a company already paying starts at its next renewal. A yearly company growing from 50 to 200 seats in the middle of its year pays list price for the 150 new seats until then (at an agreed 72 a seat that is up to 3,600 USD more over a full year), unless run E11 shows a discount put on a live subscription reaches raises at once. Until that is seen, the operator has two honest routes, and the screen names both:
    - set the price, let the company add its seats, and refund the difference on that order by hand in Polar. Section 8.4's refund handling then lowers any commission to match;
    - or agree that the price starts at the renewal.
- **An affiliate's team discount and a custom price cannot both apply.** The custom price wins. The affiliate still earns, on the lower amount, because the company is tied to them and not to the discount (section 8).

## 4. The storage total and per-member limits

### 4.1 The total

- **The company's total is the seats that count × the paid product's `quota_bytes_per_member`:** 1 TB a seat on the Team plan. Five seats are 5 TB for the company. The pages never say "1 TB each".
- **The seats that count** are `seatLimitOf`: the least of the plan's units, the units paid for (`paid_units`), and a cut scheduled for the renewal. So a raise the bank has not confirmed adds nothing, and **a scheduled cut lowers the total from the moment it is made,** as it already stops admissions.
- **The paid product, not the product.** The reconcile already works out which product the newest paid order paid for (`tierStateOf`). For a company it carries two things from that product and nothing from the one merely asked for: the storage class (a region, or the company's own) and the per-seat quota. A switch from own storage to Team that waits on the bank gives no region storage.
- **How long it lasts: for as long as the plan is live, and a plan change that is not paid adds nothing to it.** This is said here once; sections 0, 6.2 and 6.5 follow it.
    - **A renewal that fails keeps everything.** While Polar holds the subscription `past_due` and retries the renewal's payment, the company keeps its seats and its total, as the family rule has it (`groups-design.md` 3.5: "`past_due` is Polar retrying a renewal, so it keeps them"). They end when Polar gives up (`unpaid`), from the reconcile that sees it, as 6.2 says.
    - **The third draft ended them at the last paid cycle plus three grace days,** while Polar was still retrying. A fifty-seat company whose card had expired would have been refused every upload and every admission on day 4, with its plan live. How long Polar retries is Polar's setting and not HushOS's; that length is the cost of this rule, and it is the owner's to accept (section 15, O16).
    - **A plan change that is not paid gives nothing,** by three rules, one for each thing a change can add:
        - a seat raise adds no seat until its order is paid (`paid_units`, above);
        - a product change gives the paid product's storage class and quota, not the new one's (above);
        - a change that moves the period, which is the interval switch of 6.5 and nothing else, adds no day (`paid_through`, below).
    - A renewal in retry is not a plan change. None of the three touches it, and `paid_through` never ends a company's service because a renewal is late.
- **`paid_through`** is the end of the period the newest paid cycle order (`subscription_create` or `subscription_cycle`) paid for, moved on by a paid interval change and by nothing else.
    - **It is stored, not worked out.** An order at Polar carries no period, so nothing read from the order later says what it paid for. `group_billing_subscriptions` gains `paid_through` and `paid_through_order_id`. The reconcile that first sees a cycle order paid writes the subscription's `current_period_end` as read in that same pass, with the order's id. It is written once for an order, and replaced only when a newer cycle order, or an interval change's order, is first seen paid (the same read).
    - **When the period read is not the paid one.** If an interval change's order waits unpaid in the pass that first sees a cycle order paid, the period Polar shows already belongs to the change. The value stored is then the cycle order's `created_at` plus one interval of the product it paid for.
    - A family has no such column and needs none: it has no interval switch.
- **What the reconcile writes** is the total, to `group_storage.quota_bytes`, with an expiry, in the transaction that writes `groups.seat_limit`. The expiry is one of three:
    - **Nothing waits for payment:** `current_period_end` plus `BILLING_GRACE_DAYS`, exactly a family's.
    - **An interval change's order is unpaid** (waiting on a bank, or failed, whatever status the subscription shows): `paid_through` plus the grace days. A change of interval starts a new period at once (2.3), so a monthly company whose switch to yearly waits on its bank shows a period ending a year away with nothing paid for it.
    - **`past_due`, and the order that waits is a cycle order:** the later of `current_period_end` plus the grace days and the reconcile's own time plus the grace days, written again by every reconcile while it lasts.
- **Why the third case does not rest on `current_period_end`.** What that field reads while a renewal is in retry has not been seen (run E24). If Polar moves it on at the cycle, the family rule already covers the whole retry window. If Polar leaves it at the cycle that was paid, the period's end plus three days would cut a company off on day 4, which is the failure above. The reconcile runs daily and on every delivery, so the expiry stays ahead for as long as the status is `past_due`. A reconcile that cannot reach Polar for longer than the grace days lets it run out, and the first one that succeeds puts it back. For a family the same unknown decides whether its pool really outlasts day 4 of a retry today; that is family billing's to check with E24's result, and nothing here changes it.

Why the cut bites at once. If the total stayed until the renewal, a company could buy fifty monthly seats, schedule a cut to three, upload 50 TB before the renewal, and then pay for three seats while holding fifty seats' worth, for as long as it liked. The cost of the rule is real and the cut dialog says it: "Acme keeps 50 seats for its people until 1 March. Its storage total drops to 3 TB now."

### 4.2 What counts against it

- **Every company area:** each shared folder and each member's own company area (`employee`), with their earlier versions and Trash, until purged.
- **Never a personal space.** `poolParts` counts a personal workspace only through a membership whose `group_kind` is `family`. A company membership pools nothing, and the one-family index is not touched.
- **On the server it is counted in bytes,** without the family's rounding to whole GiB. That rounding exists so no figure gives away one person's private usage; a company's areas are the company's, and its Admins can open them.
- **What is shown is another matter.** The exact count is for the check and for Admins. A member without a role is shown no figure for the company's use, exact or rounded, on any page or in any answer (4.3).
- Drive's free-space check for a company area reads the total under the pool lock, as for a family.

### 4.3 Per-member limits

- `group_memberships.company_area_cap_bytes`, nullable. Null is no limit. It is not the column a family's limits will use: that one, `own_files_cap_bytes` (section 1), caps a family member's personal files inside the family's pool. A company's limit caps a company-owned area and never touches a personal space, so the two are different columns with different names.
- **A ceiling on that member's own company area,** nothing else: an upload into it is refused when the area's used and reserved bytes would pass the limit, or the company's total would be passed, whichever comes first.
- **Not a reservation.** A limit of 100 GB holds nothing aside. Limits may sum to more or less than the total.
- **Shared folders count against the company's total only,** whoever uploads.
- An Admin sets it, in whole GB, from the member's row. A limit below what the area holds is allowed: nothing is deleted, and that member's uploads to their own area stop until they make room.
- It is a server rule, like a policy, and it is recorded in the company's activity ledger (`member-limit-changed`). So it is built only once the ledger exists (section 13).
- **Who sees what:** a member sees their own area's use and limit, and whether the company has room ("Acme's storage is full" when it does not). They see no figure for the company's use: an exact total moves with every upload into folders they are not on. Admins and `billing` holders see the total and every area's use, rounded up to the whole GB for a `billing` holder who is not an Admin.
- **An upload's refusal follows the same rule.** Drive's refusal says how much room is left, and for a company area that figure was the company's exact room, shown to whoever uploaded. For a caller who is neither an Admin nor a `billing` holder:
    - when the company's total is what refused the upload, the answer carries no free figure at all. It says which limit refused it (the company's), and the message is "Acme's storage is full", with the `billing` holders' names (6.2);
    - when their own limit is what refused it, the figure is their own area's room, which they may see.
    - **Withheld, not rounded.** A rounded figure still moves when a colleague uploads into a folder the member is not on, and two refusals a day apart give the size of what was uploaded, to within the rounding.
    - An Admin and a `billing` holder get the figure, rounded for the second as above.

### 4.4 When the total is too small

- **A checkout is refused** when the seats asked for give less than the company already stores (409 `too-small`, with the seats needed), as a family's first plan is (`firstPlanTooSmall`). The first draft floored a checkout by seats alone, so a company could lapse and come back on three seats over fifty seats' worth of files.
- **A cut is refused** while the company stores more than the total would be after it, with how much to free.
- **Stored more than the total anyway, with a live plan.** With the two rules above a company cannot get there through HushOS. What can put it there is somebody else's doing: a cut made in Polar's dashboard, an operator's whole refund, or HushOS lowering `quota_bytes_per_member`, which reaches every existing subscriber at the next reconcile. Then:
    - nothing is deleted. Reading, downloading, deleting, offboarding and key changes all work;
    - uploads to company areas are refused until the company frees space or adds seats;
    - Owners and `billing` holders are mailed on the first day and weekly while it lasts, with how much to free or how many seats would cover it;
    - the company is on the operators' Companies page under "over the total", with since when;
    - **it is never closed for this.** The second draft ran the closure clock here, so a company paying 4,800 USD a year could have been closed on day 90 and lost the rest of its year for something a dashboard click did. Section 15, O4.
- **A plan that lapsed** is 6.3's case, not this one.
- **Seats for storage.** A company that needs more room than its people give it buys more seats than it has members. That is allowed, up to the limit, and the page says what it is doing: "Each seat adds 1 TB."

### 4.5 On the company's own storage

- The lower price applies only while every company file is in the company's own bucket (section 7).
- `GET /api/groups/:id` reports `storage: 'own'` (`company-storage-design.md` 4.4) when the paid product says so. Then the free-space check answers "enough" for the company's areas; used bytes are still counted and shown. Per-member limits still apply. The per-file limit still applies.
- **Uncapped is not unlimited for HushOS.** Every item is still a row in HushOS's database, with envelopes and versions. Section 14 says what that costs and section 15 asks for an item ceiling.

### 4.6 Without billing

A self-hosted server with `BILLING_PROVIDER=none` has no plans and, as the code stands, no pool (section 1). This design keeps that:

- a company's seat limit is `ORG_SEAT_LIMIT_DEFAULT`, or its `seat_cap`;
- each company area has its own allowance, `GROUP_AREA_QUOTA_BYTES`, exactly as a family's folders do today. Nothing is pooled;
- an own bucket is uncapped, as with billing;
- per-member limits still apply, to the member's own area.

The first draft invented `ORG_POOL_BYTES`, a company total without a plan. That contradicts `storageFigures`, which skips every pool without billing, and `planLive`, which reads a pool with no expiry as no plan (`families-shared-pool.md` section 8 says the same of families: "a self-hoster who wants one pool per family without Polar is not served by this").

**A ceiling on what a company's areas may be allowed, without a pool.** Left there, the defaults add up badly: `ORG_AREA_LIMIT` is 500 and each area's allowance is `GROUP_AREA_QUOTA_BYTES` (10 GiB), so one company could be allowed 5,000 GiB, and an account may create three. A family's ten folders come to 100 GiB.

- **`ORG_STORAGE_CEILING_BYTES`,** default 1 TiB (1,099,511,627,776), read only when billing is off.
- **Checked when an area is made,** under the group's lock, in the roster transaction that creates it: the sum of the allowances stored on the company's live areas, plus the new area's, must not pass the ceiling. Otherwise 409 `area-limit` with `data.reason: 'storage'`, and nothing is written. That includes the area an admission makes for the newcomer.
- **The sum is of what each area was given,** read from its own row, not the number of areas times today's `GROUP_AREA_QUOTA_BYTES`. An area keeps the allowance it was made with. Multiplying by the setting, as the third draft did, miscounts the day an operator changes it: lowered, a company holding 1 TiB of promises reads as half that and is allowed as much again; raised, a company well inside the ceiling is refused its next area.
- At the defaults that is 102 areas: fifty people's own areas and fifty shared folders. It needs no pool and no new count of bytes: it bounds what is promised, as `GROUP_AREA_LIMIT` does for a family.
- An operator who wants more raises it; one who wants more people in the same space lowers `GROUP_AREA_QUOTA_BYTES`, which applies to areas made from then on. A company on its own bucket is not held to it.
- Three companies an account is then 3 TiB at the defaults: bounded, not solved, which is where `groups-server.md` section 7 leaves families. Section 15, O15.

## 5. The payer

### 5.1 Billing is the company's

A family's plan is one person's: their card, their click. A company's is the company's:

- **Any active `billing` holder** may choose the plan, add and cut seats, cancel, resume and open Card and invoices. Every Owner holds `billing`; the Billing role holds only that (`companies-design.md` 1.2).
- So `payer_user_id` stops being the gate for a company. It stays as the record of who the contact at Polar is.
- The chain keeps at least one Owner (rule 4), so a company always has a `billing` holder.
- **Every plan change emails every Owner:** a new plan, a cancel, a resume, a cut, a switch between the two plans, a switch of interval, and the revert of one the bank did not confirm (6.5). A `billing` holder who is not an Owner cannot quietly cancel the company's plan.
- **A change made outside HushOS is mailed too, by the reconcile.** A cancel, a resume or a cut made in Polar's portal or dashboard is no call of HushOS's, so no route sends its mail. The reconcile does: when it reads a subscription whose `cancel_at_period_end`, units, scheduled cut or product differ from what it last recorded, and no HushOS call made that change, it mails every Owner what changed, once for each change (keyed by the subscription and the value it read). A former holder's cancel from the portal (5.4) reaches the Owners this way and no other, and O13 relies on it.
- Two holders acting at once meet the rules families already have: one open checkout (`group_checkouts`), one plan change at a time (`withPlanChange`), and a second paid plan cured by the reconcile.

### 5.2 What Polar holds

- The company's team customer, `group:<groupId>`: billing name, address, tax id, the card, the invoices.
- Its `owner` member: the contact.
- A `billing_manager` member for each other `billing` holder who has opened Card and invoices or made a checkout, and for a holder who has left while their card may still be the one charged (5.4). Polar's portal sessions are per member, so opening it adds them. Polar's documents say a billing manager can manage payment methods and cancel the subscription; 5.4 says what that costs.
- The number of seats. **Never who the members are,** and never who let whom in: no admission writes anything to an order's metadata.

### 5.3 The family payer rules a company is exempt from

Section 1 lists four sets of rules that act on a plan because of who pays it. Left as they are, a company's finance contact suspended on a Friday has the plan set to end by the next webhook, a contact who gives notice is refused, and removing one revokes the company's lapsed plan on the way. For a group of kind `org`, every one of them steps aside:

| Set                 | Rule (file)                                                                                                | For a family (unchanged)                                                                      | For a company                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Reconcile        | `listAbandonedChargeable` (`packages/db/src/billing.ts`), acted on by `cancelDissolvedPlan`                | A live plan whose payer is not an active member is set to end                                 | Not listed: the query gains `groups.kind = 'family'`                                                                                                                                                                                                                                                    |
| 1. Reconcile        | `revokeWithoutPayer` (`packages/billing/src/groups.ts`)                                                    | Revokes at once a plan whose `payer_user_id` is null                                          | Never revokes: a company with no contact on record has one chosen by the same reconcile (5.4's rule), and is listed for operators if it has no Owner at all                                                                                                                                             |
| 2. Account deletion | `revokeForDeletion` through `listGroupsPaidBy` (`packages/billing/src/server.ts`, `packages/db`)           | Refuses to delete the account of a live plan's payer                                          | Never refuses for a company: `listGroupsPaidBy` gains the family filter                                                                                                                                                                                                                                 |
| 2. Account deletion | `endLapsedFamilyPlansFor` through `listGroupsBilledTo` and `endLapsedPlansPaidBy`                          | Revokes the lapsed plans they pay for, or refuses the deletion                                | Skips companies: `listGroupsBilledTo` gains the family filter. A company's lapsed plan is the company's, and stays                                                                                                                                                                                      |
| 3. Group routes     | `removeMember` and `removalPreview`: `paysForGroup` (`packages/groups/src/server.ts`)                      | 409 `payer`: "They pay for this family's plan"                                                | Not asked: `paysForGroup` answers false for a company                                                                                                                                                                                                                                                   |
| 3. Group routes     | `removeMember` and `leave`: `endPayersLapsedPlan` (with `lapsedPlansPaidBy`, `endLapsedPlansForDeparture`) | The payer's lapsed plans are confirmed and revoked, or the change is refused (`ends-lapsed`)  | Not run: `findLapsedFamilyPlans` answers nothing for a group of kind `org`, so no plan is found to confirm or revoke and no live plan is reported as `charging` to refuse the change. `isFamilyPayer` also answers false for one, which only keeps the preview and the reader's rate limit from running |
| 3. Group routes     | `leave`: `paysForGroup`                                                                                    | 409 `payer`: "You pay for this family's plan"                                                 | Not asked                                                                                                                                                                                                                                                                                               |
| 4. Repository       | `payerHold`, in `depart` and in the removal's roster write (`packages/db/src/groups.ts`)                   | `busy` while a plan change holds its claim, `pays` while their plan renews                    | Returns null for a company. The removal write already calls it for a family only; `depart` does not, so the kind is read inside it. The contact's move (5.4) locks the customer's row in the same transaction, so a plan change in flight is not left half-read                                         |
| 4. Repository       | `billedPlan`, in `depart` and `deletionBlockers`                                                           | The last member cannot leave or be deleted while a plan is live and not set to end (`billed`) | Not refused: the only member's leaving dissolves the company (`companies-design.md` 3.6) and the dissolved company's job sets its plan to end (5.5)                                                                                                                                                     |

- The first draft knew none of these; the second found the first two sets and built on them as if they were all. Sets 3 and 4 run before any departure is written, so with them in place a contact's leave, removal and deletion were still refused, or went through only after revoking the company's lapsed plan.
- **The lapsed-plan row was wrong in the third draft.** It had `isFamilyPayer` answering false be what stops the rule. That function gates only the rate limit (section 1). Whose plans they are is read from the customer's row in `findLapsedFamilyPlans`, so with only that change a company's contact with a live plan would still have been refused (`charging`), and one with a lapsed plan would still have had it revoked.
- **A fifth rule, in the checkout, is not in the table because it is not about leaving:** `takeOverPayer` makes whoever checks out the payer and deletes the former payer at Polar (section 1). It is not called for a company; 5.4 says what happens instead.
- `organizer` and `last-holder`, which the same functions also answer, are rules about roles, not about who pays. They are the company spec's to change (it replaces them with notice, `companies-design.md` 3.6) and are not touched here.
- **A test per row:** each rule still does for a family exactly what it does today, and does nothing for a company.

These exemptions and the move below are part of the change that first brings companies into the reconcile (section 13, PR 5), not a later one: a reconcile that knows companies and still has these rules cancels their plans.

### 5.4 When the contact leaves

In a family the payer must cancel before leaving. A company cannot work that way: finance staff change, and a role holder's notice cannot be held (`companies-design.md` 3.6).

- **Leaving, removal, a role change and account deletion never wait on billing,** and never end or revoke the plan.
- **The contact on record moves in the same transaction** that records the departure, the removal or the loss of `billing`: `payer_user_id` becomes the Owner who signed the change, else the longest-standing active Owner. `former_payer_user_id` and `contact_moved_at` record who it was and when. A suspension moves nothing: it is meant to be undone, and other `billing` holders can act meanwhile.
- **Polar follows, later.** A job adds the new contact as a member and makes them `owner`, which demotes the old one to `billing_manager` (spike 3, steps 1 and 2). **The old contact is not deleted at Polar** while a card they may own is on file.
- **A checkout by another holder takes nothing over.** For a family, a checkout by someone who is not the payer makes them the payer and deletes the former payer from the team customer (`takeOverPayer`, section 1). Left as it is, a company's second `billing` holder buying a plan after a lapse would delete the contact at Polar, and with them the one way a departed person has to stop a charge on their own card. For a group of kind `org`, `ensureTeamCustomer` does not call it:
    - any `billing` holder may check out. One who is not yet a member of the team customer is added to it as a `billing_manager`, as opening Card and invoices adds them (5.2);
    - the contact on record does not move. It moves only by the rule above: a departure, a removal or the loss of `billing`;
    - nobody is removed from the team customer by a checkout. `hushos_payer` on the checkout still names who made it, which 8.1's rule 2 reads;
    - **a former holder is taken off the team customer only when no card of theirs can be the one charged:** when their hold below is closed and they no longer hold `billing`. The job that follows the contact's move does it then, and never before.
- **The card stays with the customer.** That is right for a company card and wrong for a personal one, and Polar gives HushOS no way to tell them apart or to remove one. The rule is about whose card is the default, not about who the contact is: **it applies to any departing `billing` holder who may have put that card there:** the contact, whose checkout it came from, and any billing manager for whom HushOS ever opened Card and invoices (it records each session it opens). Any billing manager can add a card, so the contact is not the only person whose personal card may be the one charged. **A card already confirmed as the company's starts no hold:** when the default card is the one a standing confirmation names, a departure changes nothing. Otherwise the departure starts a hold.
- **Where a hold is kept: a row for each person.** `group_card_holds`: the group, the departed holder, `departed_at`, the card it is about (Polar's `default_payment_method_id` at that moment), when they were last told, and `closed_at` with how it closed (`own-yes`, `owner-yes`, `new-card`). The third draft kept one `card_hold_since` and one `card_hold_user_id` on the customer's row, which holds one person: when two holders left in turn, the second overwrote the first, who was then never told of an Owner's confirmation about what may be their card. **The company is under a hold while any row is open,** and every person with an open row is told everything below.
- **While a hold stands:**
    - **nothing is charged to that card on anyone's click.** That is every action that charges the card on file at once, not only seats:
        - "Add seats", a raise for people being let in, and buying at admission (3.2, 3.3);
        - a change to the dearer plan, from own storage to Team (7.2);
        - a change from monthly to yearly (6.5).

        Each answers 402 `seats`, reason `card`: "The card on file was added by someone who has left Acme. Add a card in Card and invoices first." The third draft held only the first group. During a hold, an Owner switching fifty seats to yearly would have put 4,800 USD on the departed person's card with one click;

    - **what is not held,** because the click charges nothing: a cut, a cancel, a resume, and a change that waits for the renewal (to the cheaper plan, to monthly). And a checkout, which is paid on Polar's page with a card the buyer gives there. Whether that page offers a card already on file to another member has not been seen (run E10 looks); if it does, a checkout during a hold is refused the same way;
    - **the departing person's own yes closes their own row at once,** and nobody else's. Someone who leaves by choice is asked in the leave flow: "Is the card on file Acme's?" Yes records `card_confirmed_at`, `card_confirmed_by` (them) and the card it was said of (`card_confirmed_method`, Polar's `default_payment_method_id` at that moment). It is their card or their employer's, and they are the one person who knows. If no other row is open, the company is under no hold;
    - **a newer default card closes rows at once:** every row whose `departed_at` is earlier than the day the card Polar's `default_payment_method_id` names was created. A card added between two departures closes the first person's row and not the second's;
    - **an Owner's yes closes them after 7 days, not at once.** An Owner is an interested party: their yes would otherwise put new charges on a departed person's personal card on the company's word alone (47 yearly seats is 4,512 USD). So an Owner's confirmation is recorded as pending and **every person with an open row** is mailed: "{Owner} says the card on file for Acme is the company's. If it is yours, say so within 7 days: {link}." If any one of them objects (a signed link, no sign-in needed, or the same button in Card and invoices), the confirmation is cancelled and only a new card or that person's own yes closes their row. If none does, it takes effect on the eighth day, for the card it named, and closes every open row;
    - **where that notice goes.** To the former holder's verified addresses that are not at one of the company's verified domains (the company spec's routes C22 and C27). A mailbox at the company's domain is the company's: an Owner's side can read it, or delete the mail before anyone does, so a notice sent only there tells nobody who could object;
    - **if any former holder with an open row cannot be mailed that way** (their account is deleted, or their only addresses are at the company's domains), an Owner's yes is not offered at all (409 `card`): a new card is the only way, apart from that person's own yes;
    - a confirmation is for one card. If the default later becomes a different card that is not newer than those departures, the rows the confirmation closed are open again;
    - renewals go on. Stopping them would end a company's plan because a person left, which is the failure 5.3 removes. Section 15, O9;
    - each former holder keeps a way to stop paying, as a family's does: HushOS opens Card and invoices for them (as a `billing_manager`) for as long as their row is open, and mails them when it opens and seven days before each renewal until it closes. These reminders go to every verified address they have: they say only that a card may be charged, and a copy the company can read costs nothing;
    - the new contact and every Owner are told to check the card, when a row opens and weekly while any is open.
- **The cost of keeping that portal open, said plainly.** Polar's documents say a billing manager can cancel the subscription. So a person who has left the company, and whose card may be paying for it, can set the company's plan to end from the portal. That is the price of letting them stop a charge on their own card, and it is bounded: every Owner is mailed by the reconcile that sees the cancel (5.1: it is made at Polar, so no route of HushOS's sends that mail), a cancel can be undone until the period ends, and adding the company's own card ends their access. Whether a billing manager's cancel really works is run E10's to show. Section 15, O13.
- If the job fails at Polar it is retried with backoff. Nothing in HushOS waits for it: raises go through HushOS's own token, and any `billing` holder can open the portal as a billing manager.
- **Unverified:** the ownership transfer has never been run, and the one time a billing manager added a card it did not become the default (spike 8, E6). Run E10 does both. If the transfer does not work, the old contact simply stays `owner` at Polar while HushOS's record has moved; the card rule above does not depend on it.

### 5.5 A company with nobody to pay

- A dissolved company's live plan is set to end at its period's end by the existing job (`billing.cancel-dissolved`), never revoked or refunded.
- A closed company's plans are handled by 6.3.

## 6. Lifecycle

### 6.1 Before a plan

- Making a company is free. It has one seat and no storage: its Owner can set it up, invite people and choose roles. Nobody can be let in and nothing can be uploaded to it.
- **No trial at launch.** Polar's trials collect a card and can refuse a second trial by email or card fingerprint ("Prevent trial abuse"), so one is possible later. Not now, because:
    - a trial of 3 TB or more is real storage given to anyone with a card;
    - a seat added during a free period is charged nothing and makes no order (spike 8), so the seat arithmetic and the affiliate records would need a second path;
    - a monthly plan at three seats is a small, honest way to try it.

### 6.2 While it runs

| Polar says                                                                       | The company has                                                                                          | What people see                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `active`                                                                         | Its seats and its total                                                                                  | Nothing                                                                                                     |
| `past_due` (Polar is retrying a renewal)                                         | The same, for as long as Polar keeps retrying (4.1). Never cut short by `paid_through` or the grace days | `billing` holders and Owners: "A payment for Acme didn't go through. Update the card." Members: nothing yet |
| A plan change whose order is unpaid (a raise, another product, another interval) | What was paid for: no added seat, the paid product's storage, no added day (4.1)                         | `billing` holders and Owners: what waits on the bank, and the way to confirm it                             |
| `unpaid`, `incomplete`, `paused`                                                 | No plan: one seat, no total. Nobody is removed, nothing is deleted. Uploads and admissions stop          | Everyone: "Uploads to Acme are paused." `billing` holders and Owners also see why and the way to fix it     |
| Set to cancel                                                                    | Everything until the period's end. No seat can be added until it is resumed (Polar refuses, 403)         | `billing` holders and Owners: the date it ends                                                              |
| Ended                                                                            | No plan, as above                                                                                        | As above                                                                                                    |

- For Polar's statuses these are the family's rules and the family's code (`planStanding`), with other wording. What a company has of its own is the row for an unpaid plan change and the expiry a renewal in retry is given, both 4.1's.
- **What never depends on payment:** reading and downloading, deleting, removing a member, suspending, key changes, the admin browser, the activity ledger, security policies. A company that stops paying can still offboard someone that day. Closure (6.3) stops most of these and never removing or suspending: a closed company can still offboard too.
- A member whose upload is refused is told who can fix it (the `billing` holders' names), not shown a way to pay.

### 6.3 A company that stops paying

"Nothing is deleted" cannot mean for ever. A company could pay one month, fill several TB, cancel, and keep it all for nothing. On its own storage it could pay once and have HushOS sign its downloads for good.

**The clock.** `groups.unpaid_since` is set by the reconcile on the first day the company has no live plan and holds at least one item, in a HushOS region or in its own bucket. It is cleared the moment a plan is live again.

- **It never runs while a plan is live.** A company that pays is never closed, whatever it stores. One that is over its total has its uploads refused and nothing more (4.4). The second draft ran the clock there too. With 4.1's and 4.4's rules a customer can no longer get over the total by their own doing, so that clock would only ever have closed a paying company for something Polar, an operator or HushOS did. Section 15, O4.
- "No live plan" is 6.2's: ended, `unpaid`, `incomplete` or `paused`. `past_due` is live.
- A company with no plan and nothing stored is left alone.

**The notices.** Owners and `billing` holders are emailed on day 1, 30, 60 and 83. Each mail says the date the company closes and what stops it: a plan. From day 60 every member also sees it in the app, and the mails say the same: "Acme closes on {date}. Download anything you need before then." No mail and no screen calls anything an export or a way to leave.

**Day 90: the company is closed.** `groups.closed_at` is set. This is a new state, and it is not a dissolve:

|                           | Dissolved (`dissolved_at`, today) | Closed (`closed_at`, new)                                                                                                                                                       |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folders                   | Retired at once (`deleted_at`)    | Untouched                                                                                                                                                                       |
| Shares and links          | Revoked                           | Kept; a link answers as a link that does not exist while the company is closed                                                                                                  |
| The chain, members, roles | Frozen for good                   | Nobody is added and no role is given. Leaving, account deletion, removal and suspension still go through                                                                        |
| Who is served             | Nobody, ever                      | Data admins (Owners and Admins): open and download only. Whoever may remove or suspend in an open company: that. `billing` holders: the Billing page. Nobody else, nothing else |
| Coming back               | Never                             | A paid checkout before the purge clears `closed_at`: everything is as it was                                                                                                    |

- The first draft said the company's folders were "retired as a dissolve retires them" and that paying "reopens it whole". Both cannot be true: a dissolve revokes every share and link and nothing reopens it (`groups-design.md` 3.3).
- **Closed means read-only for the people who can already open everything.** Owners and Admins hold `data_admin` (`companies-design.md` 1.2). While the company is closed they can list, open and download in every company area, through the admin browser, with each session recorded as it always is. They cannot upload, change, share, delete, make a folder or let anyone in. That is how files come out of a company that will not pay again: the people entitled to them download them, in the 30 days before the purge.
- **The second draft promised something else, and it was false.** It said an Owner could still "run and download the export … so a company that will not pay again can leave with its data". `docs/company-storage-design.md` 10.4 says: "Until they are built, no page, mail or post calls an export a way to leave", and that work is after this release. An export is ciphertext and metadata written to a bucket the Owner names; it holds no account, and nothing in this release reads one back. A scheduled export a company already has keeps what it wrote. It is a backup, and every page calls it that.
- **What a data admin's download needs, by what each route does.** "Open and download" is not one route. The third draft exempted leaving alone from "not closed", which left a data admin unable to reach a single file. These answer a data admin of a closed company as they do in an open one (numbers are `companies-design.md` section 4's):
    - reading the company, its people and its rosters, and the list of spaces (routes 3, 5 and 25);
    - reading the company key and the kit's public keys (C1), an area's list (C2), its share log (C32) and the heads (C34);
    - reading an area's custody seal (C5), the seals still to check (C6), and recording that they were checked (C7);
    - opening a browse session (C13 with `purpose: 'browse'`), which writes its notice and its ledger fact as it always does, and reading an area's notices (C14);
    - registering the device's audit key and sending its app reports (C15, C16), without which no recorded request is accepted;
    - the device's own approval where the company requires one (C20);
    - reading the ledger (C17);
    - Drive in the company's areas: listing, opening and downloading, each request recorded as it always is.
- Every other route of the company answers a data admin `closed`, the Drive routes that write among them: an upload, a rename, a move, Trash, a share, a link, a new folder.
- **Offboarding does not stop at closure.** The third draft stopped removal and suspension with everything else. A data admin dismissed on day 91 would then have kept open-and-download in every area for the 30 days, with nobody able to stop them. So, in a closed company:
    - **suspending and resuming** (C26) work as in an open one, for whoever may do them there. Resuming adds nobody: it gives back what a member already had;
    - **removing** works: the hold that comes first (route 27, as 3.6 of the company spec has it), the removal's roster (route 19) with the company key replacement it carries when the person held `data_admin`, the roster that marks a departed person left (route 7), and the seals the new company key needs before the remaining data admins can go on opening areas (C8, C30). The server ends the person's access in the removal's transaction, as always;
    - **what stays owed until the company reopens:** the hand-over of what they shared (C12) and the area key changes that follow a removal (C31, route 24, and C13 with `purpose: 'key-change'`). Reading goes on while a key change is owed (the company spec's 3.6), and nothing is written in a closed company, so nothing is written under a key the leaver holds. A company that never reopens is purged with those changes still owed;
    - nothing that adds a person or gives a role: an invitation, an admission, a join request's approval and a role given are each `closed`. A role taken away is allowed where a removal would be.
- **Recovery with the kit** (C10, C11, C29) is this design's to leave open by default, since an Owner who has lost their keys has no other way to the files, and the company spec's to settle in the change below.
- **Members without `data_admin`** get 403 `closed` on the company's routes and on Drive in its areas, with "Acme is closed. Ask {Owners' names}." Their personal spaces and other memberships are untouched.
- **Leaving and deleting an account are never answered `closed`.** A notice that is running runs out, a member can leave, and an account can be deleted, exactly as in an open company, where a role holder's notice runs 7 days and only a last Owner with colleagues still active is refused (`companies-design.md` 3.6 and its route 20). Only the company's content, and anything that adds to its people or their roles, is stopped.
- **At closure, a lapsed plan is revoked at Polar** (`unpaid`, `incomplete`, `paused`), by the path that already revokes a lapsed plan before a new checkout (`revokeLapsed`, `endings.ts`), whose ending refunds whole any payment Polar takes afterwards. So a late payment cannot land on a closed company and revive a plan nobody chose. There is never a live plan to end at closure: the clock does not run with one.
- **Coming back.** A paid checkout before the purge clears `closed_at` and `unpaid_since`, in the reconcile that sees the plan live. Folders, shares, links and the member list are as they were. The checkout is refused if its seats give less than what is stored (4.4), like any other.
- **Day 120: the purge, in one step.** `groups.purge-closed` takes companies that have been closed for 30 days. It queues every object of the company's areas for deletion and deletes the company's rows that day. It does not go through a dissolve: that path retires the folders and then waits 30 days of its own before purging them, which would make it day 150. The 30 days a company has spent closed are that wait.
- **On a company's own bucket** HushOS deletes its own rows and never an object in the company's bucket. Without those rows the bucket's ciphertext cannot be opened, and the mails say so.
- A report hold keeps reported items, as it does through any purge.
- **This needs a change to `docs/companies-design.md`** before it is built, made and reviewed in that PR: `closed_at` on `groups` in 1.4; a "Closed" paragraph in 3.6 beside suspension, saying data admins may still open and download, that leaving, removal and suspension still work, and which key changes wait; 403 `closed` in its error table; `company-closed` and `company-reopened` in 3.8; and every route's "who" column read with "not closed", except the routes listed above: leaving (route 20), the reads a data admin's download needs, and removal and suspension with the calls they need. Whether recovery with the kit stays open is settled there too.

The same gap exists for a family's folders today and is not this design's to close.

### 6.4 Cancelling, refunds

- Cancel sets the plan to end at the period's end; resume undoes it. Both are the existing calls.
- **Nothing is refunded for unused time or freed seats,** as for families. Polar credits a cut to a wallet no public call can pay out (spike 1).
- A plan bought twice (two holders, two checkouts paid) is cured as for a family: one is kept, the other revoked and refunded whole.
- A refund for another reason is an operator's, in Polar. The page does not promise one. Section 8.4 makes commission follow it.

### 6.5 Monthly and yearly

The first draft said a company that wants the other interval cancels and buys again; a checkout is refused while a plan is live, so that guaranteed a stretch with no plan and no uploads. The second made it a product change and said the sandbox had shown what it charges. It had not (2.3): the one run was on a free plan.

- **Monthly to yearly** is a product change with `invoice` proration. A 402 changes nothing. It charges the card on file at once, so it is refused during a card hold (5.4).
- **Yearly to monthly** is a product change scheduled for the renewal (`next_period`).
- Seats carry over: a product change keeps `units`.

**What keeps an unpaid switch from giving a year away.** The period restarts at the switch (2.3). If Polar leaves the subscription active with the yearly order unpaid, a company that paid 500 USD for a month of fifty seats would show a period ending a year on, with 4,800 USD owed. Nobody has seen whether Polar does that. Three rules make the answer not matter:

- **`paid_through`** (4.1). While the switch's order is unpaid, seats and storage are valid to the end of the last cycle that was paid, never to the new period's end. An unpaid switch adds no day.
- **An unpaid interval change is reverted, after a wait and not in the pass that makes it.**
    - **Unpaid at once is not unpaid.** Polar answers the call before it charges, and the order is paid a second or two later (section 1, `SETTLE_DELAYS_MS`). The third draft reverted "in that same pass", which would have undone every switch Polar had not yet charged. The switch waits for its order as a raise does; an order still unpaid when that wait ends is one the bank holds.
    - **The bank's question gets time to be answered.** An order the bank holds waits `INTERVAL_CONFIRM_HOURS` (24 by default) from the order's `created_at`, and never past `paid_through`. The `billing` holders are mailed at once with the way to confirm it in Card and invoices, and the Billing page shows the line until it is settled. A card that asks its holder to authenticate would otherwise be reverted before the holder had seen the question. Nothing is given away meanwhile: `paid_through` holds. The length is the design's choice (section 15).
    - **Then the revert.** A job set for the end of the wait (and the daily reconcile behind it) reads the order again. Paid, it does nothing. Still unpaid or failed, it sets the product back to the monthly one and tells every Owner and `billing` holder: "Your bank did not confirm the yearly payment within a day, so Acme stays on monthly." It is not left for `STALE_RAISE_DAYS` or for the period's end, which is now a year away. If Polar refuses the revert, the company is listed for operators, and `paid_through` still holds.
    - **The revert is itself an interval change, and nobody has seen what one does.** The one switch the spike ran restarted the period and invoiced at once (2.3). A revert may do the same the other way: start a new monthly period at that moment and charge a second month on top of the one already paid, or credit the year that was never paid to Polar's wallet, which no public call pays out (6.4). So nothing ships on a guess. Run E20 records what the revert charges, what it credits, which orders it makes and what becomes of the unpaid yearly one, and what the period reads afterwards.
    - **The switch is turned on only if E20 shows a revert that charges nothing and credits nothing.** If it charges a second month or leaves a credit, the mid-period switch is not turned on at all, and yearly stays what the page offers today (below).
- **No `once` discount exists on a team plan** (3.5), so none can stretch across the switch into a year. A `repeating` one does reach the yearly charge; 3.5 states that cost.

Also:

- Not for a rupee plan, which has no yearly product (2.4).
- Families still cannot switch; this is the company's rule only.
- **Held back until it has been seen.** The switch is built with the two plans (section 13, PR 12) and turned on only after two sandbox runs: E19, a paid monthly plan moved to yearly (what is charged, which order, what the period reads), and E20, the same with a card that asks its holder to authenticate (what the subscription and the order look like while it waits, then the revert after the wait: whether it is accepted, and what it charges and credits). Until then the Billing page offers the other interval the old way: cancel at the period's end, and buy yearly then. That way does leave the company with no plan from the period's end until the yearly checkout is paid, and the page says so before the cancel.

## 7. The two plans and where the files are

### 7.1 The rule

**The own-storage price is paid only while no company file lives in a HushOS region.** Every check reads the product that is **paid** (4.1), never one a change merely asked for:

- a checkout or a switch to Team, own storage is refused (409 `storage`) unless the company's own bucket is in use and nothing of the company's is left in a region;
- a move from the company's bucket back into a region is refused (402 `plan`, the storage design's S25) until the paid product is Team **and no order of the subscription waits for payment** (reason `unpaid`). Without the second half, a fifty-seat yearly company could switch to Team, have the 1,800 USD difference held by its bank, and start moving into a region on a plan nobody had paid for;
- while a switch to own storage is scheduled, a move back into a region is refused (409 `storage`, reason `switch-pending`), and the switch is checked again when it applies, not only when it was asked for;
- a switch that charges at once, which is the one to Team, is refused during a card hold (402 `seats`, reason `card`, 5.4): the difference would go on a card that may be a departed person's. The switch to own storage waits for the renewal and charges nothing on the click, so a hold does not stop it;
- the reconcile gives no region storage to a company found on the own-storage product with files in a region, and lists it for operators. It should never happen; it is the backstop.

A company on Team may keep its files in its own bucket. It pays for storage it does not use, and nothing is wrong.

### 7.2 Switching

**From HushOS's storage to the company's own:**

1. An Owner sets up the bucket and passes its test (the storage design's company settings).
2. The move starts. Billing's check for it is only that a plan is live.
3. When the move has finished, a `billing` holder may switch to Team, own storage. It is the cheaper plan, so it starts at the renewal (`next_period`) and nothing is credited, as a smaller family tier does.

**From the company's own storage back to a region:**

1. A `billing` holder switches to Team. It is the dearer plan, so it starts now with `invoice` proration: the difference for the rest of the period is charged at once, and a 402 changes nothing. During a card hold it is refused with reason `card`, as every charge made on a click is (5.4).
2. Once that order is paid, the move may start, and only if what the bucket holds fits the total the seats give (the storage design's `over-quota`). If it does not, the company adds seats first.

Seats carry over in both directions: a product change keeps `units` (spike 1).

**A new company that wants its own storage from the start** sets up the bucket before its first checkout and buys Team, own storage directly: it has no files anywhere, so the rule holds.

## 8. Affiliates on company plans

### 8.1 Which affiliate a company belongs to

Today an order earns for the affiliate whose coupon it used, else the one its payer signed up through, decided again on every order. For a company that moves with whoever pays that month, and a coupon from a coupon site would decide twelve months of a fifty-seat company. Three things could decide it:

| By                                | Can be gamed by                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The account that made the company | Asking a referred friend to press "Create" and then hand the company over. Stable afterwards                              |
| Whoever pays                      | Making an affiliate's own referral a `billing` holder for one checkout                                                    |
| A code typed at checkout          | Coupon sites: anyone who searches for a code gets the discount, and the affiliate earns for a customer they never brought |

**One affiliate per company, fixed once,** at the company's first paid order whose net amount is above zero (the tying order). `group_billing_customers.affiliate_id`, `affiliate_tied_order_id` and `affiliate_tied_at` are set, and **`affiliate_tied_at` is that order's `created_at` at Polar,** never the time the webhook ran or the row was written. The affiliate comes from, in order:

1. the affiliate the account that created the company signed up through, if that sign-up was within 90 days before the company was created (`AFFILIATE_SIGNUP_WINDOW_DAYS`);
2. the affiliate the person who made the checkout signed up through, within 90 days before the checkout;
3. the affiliate whose team discount the checkout carried, typed as a code, when neither of the first two exists.

- The first draft put the code first. The review was right that the most gameable signal should not win: a sign-up through an affiliate's page is that affiliate bringing a person; a typed code is anyone who found it.
- **The window** stops an attribution from years ago tying a company its affiliate had nothing to do with. Section 15, O6.
- **A typed code ties for the same 12 months as a sign-up does.** Most companies will be created by people no affiliate brought, so for most of them rule 3 is the only rule that can apply, and a code found on a coupon site then earns its affiliate a year of that company's orders. That is the residual of taking codes at all. A shorter term for code-only ties, or none, is section 15's O12.
- **The discount follows the tie, unless the company has a custom price.** A checkout by someone rule 1 or 2 ties carries that affiliate's team discount, and a typed code is refused ("Acme already has an offer from {affiliate's name}"). Only an untied company may type one. Where an operator has set a custom price, it wins (3.6): the checkout carries the custom discount and not the affiliate's, takes no code, and the company is tied to the affiliate all the same, who earns on the lower amount.
- After the tie nothing moves it: not who pays, not a later code, not a custom price.
- **The edges:**
    - a first order whose net is zero ties nothing; the next paid one does;
    - a tying order refunded whole within 30 days, with no other paid order since, undoes the tie, and the next paid order ties again by the same rules;
    - an affiliate who is paused when the tying order is paid is not tied (8.5).

### 8.2 The team discount

- `affiliates` gains `team_provider_discount_id`, `team_percent_off` (1 to `TEAM_DISCOUNT_MAX_PERCENT`, 20) and `team_duration_months` (1 to `TEAM_DISCOUNT_MAX_MONTHS`, 12). The duration is always `repeating` (3.5). All null for an affiliate who does not sell team plans.
- An operator sets them when enrolling or later. HushOS makes the discount at Polar restricted to the four team products, **with no code at Polar.** The second draft gave it the affiliate's code with a suffix (`<CODE>-TEAM`); Polar refuses that, since a code may hold only letters and digits (spike 8: `exp-free` is refused, `EXPFREE` accepted), and no code is needed: Polar's team checkout takes none, and a discount without one "can only be applied through a Checkout Link or the API" (Polar's discounts page), which is exactly what HushOS does.
- The affiliate has one code, the one they have today. Typed into HushOS's own field for a team plan, HushOS finds the affiliate by it and applies their team discount by id.
- The affiliate's `/go/<slug>` page shows the team plans with that discount once `COMPANIES_ENABLED` is on and the affiliate has one.

### 8.3 What earns

- **Every paid order of that company within the term:** the first, each renewal, each seat added, a switch to the dearer plan or the yearly one. `order.paid` is the only trigger, as today.
- **On the order's net amount** (after any discount, before tax), by the affiliate's `commission_bps`, and then by the part of the order that falls inside the term. The formula is stated once, here; 8.4 and 9.3 use `pot` as it is defined here and never work it out again:

    ```
    full = floor(net × bps / 10000)
    pot  = floor(full × inside / span)
    ```

    - `span` is the seconds the order pays for, from its creation to the end of the period it starts or tops up, and `inside` is how many of them fall before the term's end (below).
    - For an order wholly inside the term `inside` equals `span`, so `pot` is `full`. That is every personal and family order, which have no term, and nearly every company order.
    - `pot` is what `affiliate_earnings.pot_amount` stores (8.4).

- **For 12 months of billing cycles, not 12 months of seconds** (`affiliates.company_months`, default 12, null for no end). The term ends at `affiliate_tied_at` plus 12 calendar months. Renewals are created on the anniversary to within moments, so a rule that compares seconds would be decided by the order in which two deliveries happened to be handled. The rule is by cycle:
    - **A cycle order** (`subscription_create`, `subscription_cycle`) earns when the cycle it pays for begins more than a day before the term's end. A monthly plan's cycles begin at 0, 1, … 11 months, which all earn; the thirteenth begins at 12 months and does not. A yearly plan's first cycle earns; its second, at 12 months, does not.
    - **A change order** (`subscription_update`: seats added, a dearer plan) earns when it is created inside the term.
    - **An order whose period runs past the term's end earns for the part inside it.** A monthly company that switches to yearly in its eleventh month would otherwise earn its affiliate a second year. That is the second line of the formula above: the pot of such an order is `floor(full × inside / span)`, and the pot is all that is ever paid or split for it.
    - **When an order is paid does not matter.** A renewal that begins inside the term and is paid late still earns.
- Personal and family orders keep today's rule, which has no end.
- A custom price lowers the net and so the commission.

**The arithmetic, per seat.** An affiliate with a team discount of 20% for twelve months and 2,000 basis points:

| Order                                    | Net                                           | Commission |
| ---------------------------------------- | --------------------------------------------- | ---------- |
| Ten seats, monthly, USD                  | 10 × 10.00 × 0.8 = 80.00                      | 16.00      |
| Two seats added with half the month left | floor(2 × 1000 × 0.5) = 1000, less 20% = 8.00 | 1.60       |
| The next renewal at twelve seats         | 12 × 10.00 × 0.8 = 96.00                      | 19.20      |

### 8.4 Holding, refunds, disputes and voiding

These change live code and apply to every earning, personal and family orders included. They are built first (section 13, PR 2) and are a condition for earning on company orders at all, where one order can be thousands of dollars.

**The pot.** `affiliate_earnings` gains `pot_amount`: the commission as first recorded for the order (8.3's `pot`, already cut to the part inside the term), which nothing later changes. Everything below is worked out from it. It is written in PR 2, with the refund handling. The second draft listed it only with sub-affiliates; without it a second delivery about one order recomputes from an amount the first already lowered, and 2,000 becomes 1,000, then 500.

**Holding.** `affiliate_earnings` gains `payable_at`: the order's paid time plus 30 days (`AFFILIATE_HOLD_DAYS`), for earnings recorded after the switch is turned on (the cut-over, below, and section 15, O14). `markEarningsPaid` marks only rows whose `payable_at` has passed and that are not voided or flagged. The operator's page shows "owed" and "held until" apart. Most refunds and disputes arrive inside that window.

**Refunds.** Today only a whole refund made by HushOS itself withdraws a commission.

- The webhook handles `order.refunded`, and every `refund.created` and `refund.updated`, not only those carrying HushOS's own key.
- Each delivery only triggers a re-read: HushOS lists the order's refunds at Polar and takes `refunded` as the sum of those that are `succeeded`, capped at the order's net. A refund's amount excludes tax, as the net does (`families-shared-pool.md` 5.1). It is stored on the earning (`refunded_amount`), as last read.
- The earning is recomputed from what is left, never adjusted by the delivery's own figure, by the one function below.
- A refund that later fails raises it again by the same re-read. Stripe can fail a refund it reported succeeded for up to 30 days (`endings.ts`, `SETTLED_RECHECK_DAYS`), so the daily run reads again the refunds of every earning lowered in the last 30 days.
- **HushOS's own whole refunds** (`withdrawEarning`) become the same recompute with everything refunded: the row is kept at 0, so the ledger shows the order, where today an unpaid row is deleted. `affiliate_withdrawn_orders` still stops a late first recording.

**What is left of an earning: one function.** Two things lower an earning, a refund and a lost dispute, and they are read from two different lists at Polar. One function, `earningLeft`, works out `left` from both, from what is stored on the earning:

```
left = 0                                           when the order's dispute is `lost`
     = floor(pot × (net − refunded) / net)         otherwise
```

- **A lost dispute gives 0 whatever the refunds say.** A chargeback returns the whole charge and is not in the order's refunds list (section 1), so the second line alone would give the whole pot back.
- **Every path that changes an earning calls it and writes its answer, and none writes `left` any other way:** the refund deliveries, the daily re-read of refunds, the dispute read, HushOS's own whole refund, and the cut-over. A path first stores what it read (`refunded_amount`, or `dispute_status`) and then calls it.
- **The third draft had two writers.** The refund re-read computed `left` from refunds only, and the dispute read set it to 0 on `lost`. The daily run re-reads the refunds of every earning lowered in the last 30 days, which includes one a dispute lowered. So a 768 USD pot went to 0 on `lost` and back to 768 the next morning; on an earning already paid, the clawback appeared and vanished with it.
- A whole refund leaves 0. So does a lost dispute on an order that was half refunded first.
- An unpaid earning is lowered to `left`. One already paid out keeps its amount and gains `clawback_amount = paid − left`, with `order_refunded_at` when a refund is why.
- With two parts (9.3), `left` is worked out for the pot and split again; neither part is computed on its own.

**Disputes.** A chargeback is not a refund, and no delivery announces one (section 1). The refund re-read alone would never see a lost dispute. So:

- **The daily run reads Polar's disputes list** (`disputes.list`, newest first, down to the newest one it has already seen, and again every dispute it holds as not closed) and matches each to an earning by `order_id`.
- **Every dispute read is kept, whether or not its order has an earning yet** (`affiliate_disputes`: Polar's id, the order's id, the status, when it was opened and when it was last read). An earning can be recorded after its order's dispute was first seen: the job that grants kept rewards writes one late, and so does a delivery that was delayed. The third draft matched only in the dispute read, so such a dispute found no earning and was never looked at again.
- **So the match is made from both sides.** The dispute read matches each dispute to the earnings of its order. And whoever records an earning reads `affiliate_disputes` for that order, under the order's lock, before the insert: an earning whose order has an open dispute starts flagged, one whose order's dispute is `lost` starts at 0, and one whose order's dispute is `prevented` has its refunds read before it is written.
- The earning records `dispute_id`, `dispute_status` and `disputed_at`.

    | Polar's status                                    | The earning                                                                                                                                                                                                 |
    | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `early_warning`, `needs_response`, `under_review` | Flagged `dispute`: not payable until it closes                                                                                                                                                              |
    | `lost`                                            | `left` is 0 by the function above, for both parts, and stays 0 through every later refund re-read. Unpaid, it is lowered to 0; paid, it gains a clawback of all of it                                       |
    | `won`                                             | The flag is cleared; the earning stands                                                                                                                                                                     |
    | `prevented`                                       | That order's refunds are read again at once. Polar refunded before the dispute escalated, and it is the refund that lowers the earning; nothing is taken for the dispute itself, which would count it twice |

- **This is what the 30-day hold is for.** With no delivery for a dispute, the daily read is the only way HushOS learns of one. Most are opened within 30 days of the charge, so the earning is still unpaid when `lost` arrives. One that arrives after a payout becomes a clawback.
- **The token needs `disputes:read`,** added to `docs/self-hosting.md` with this PR. Without it the listing fails: logged at error level once a day and shown on the operator's Affiliates page ("Disputes can't be read: the Polar token has no disputes:read scope"). Refunds are still handled.
- **Not known:** whether the list answers for an organisation that does not have Polar's disputes dashboard (section 1). Run E22 looks. If it does not, this covers refunds and `prevented` disputes only, the hold is the only defence against a chargeback, and the operator's guide says so.

**Clawbacks.** A `clawback_amount` is money an affiliate was paid and should not have been. It gains a state: `clawback_settled_amount` (how much of it has been taken back so far, 0 at first), `clawback_settled_at` (set when nothing of it is left open), `clawback_settled_by` and `clawback_note`. The second draft had no such state, so a clawback would have shown at every payout for ever.

- **A clawback is settled by amount, never as a whole.** What is open on one is `clawback_amount − clawback_settled_amount`. The payout view nets an affiliate's open clawbacks against what they are owed in the same currency and shows the net, which is never below zero.
- **Marking earnings paid takes back only what was netted,** in the same transaction: the amount netted is applied to the open clawbacks, oldest first, each up to what is open on it. One that is covered in full is settled. One that is covered in part stays open with the rest.
- **The third draft settled "the clawbacks netted" whole.** With 50 USD owed and a 768 USD clawback, the payout was 0, the clawback was marked settled, and 718 USD disappeared from the books. Now 50 is applied, the payout is 0, and 718 stays open against later earnings.
- An operator can also settle one by hand, in full or in part: repaid (an amount), or written off (what is open, with a note). Only that writes anything off.
- **If a later re-read lowers a clawback below what was already taken back** (a refund that failed after all), the difference is owed to the affiliate again and shows as owed.
- **A clawback the cut-over creates is not netted until an operator says yes to it.** It is marked as the cut-over's (`clawback_origin`) and carries `clawback_confirmed_at` and `clawback_confirmed_by`, null until an operator confirms that one clawback. Unconfirmed, it is listed and counted in no net. That is what "nothing is taken back automatically" means below; the third draft said it there and netted every clawback here. A clawback that arises after the switch needs no confirmation.

**Voiding.** An operator may void one earning with a reason (`voided_at`, `voided_by`, `void_reason`). A voided earning is owed to nobody and no longer blocks removing the affiliate. It is the tool for fraud that neither a refund nor a dispute shows.

**Flags.** An earning may carry a flag that keeps it out of "mark paid" until an operator releases or voids it:

- `member`: the affiliate's linked account, or their sub's or parent's, is a member of the company when the order is paid. This is either an affiliate referring their own company or a consultant added to a client's; the two cannot be told apart by a rule. Section 15, O7.
- `self`: the affiliate's linked account is the customer of a personal or family order.
- `dispute`: above. It clears itself when the dispute closes.

The first draft paid nothing in the `member` case. The first review was right twice over: the check is evaded by a second account or by leaving before a yearly renewal, and it takes commission from an honest consultant. A flag makes both visible and leaves the judgement with the person who pays.

**The cut-over, when `AFFILIATE_V2_ENABLED` is turned on.** Earnings exist today, some unpaid, some paid. For rows written before the switch:

- `part` is `main` and `pot_amount` is `commission_amount` (the migration fills both).
- **`payable_at` is the row's `created_at`.** An earning from before the switch is not held: it may be paid when it could be before. The hold is for earnings recorded afterwards. **Its amount is another matter:** the reach back below can lower it.
- A paid row already marked `order_refunded_at` (HushOS refunded its order whole) gains a clawback of its whole amount, open and unconfirmed, so it is listed once where today it is only a log line.
- `affiliate_withdrawn_orders` is unchanged: those orders have no earning and never get one.
- **The reach back.** Refunds and disputes from before the switch that nothing acted on: the first daily run after it reads them for every unpaid earning, whatever its age, and for every earning paid in the last 120 days (`AFFILIATE_CUTOVER_DAYS`).
    - An unpaid one is lowered by `earningLeft`: it was never owed. **The affiliate is owed less the day after the switch than their page showed the day before.**
    - A paid one gains a clawback. **Nothing is taken back automatically:** a clawback made here nets against a payout only once an operator has said yes to that clawback (above), and until then it is only listed.
    - Paid earnings older than that are left alone.
    - So the switch changes what today's affiliates get, not only when. How far back it reaches is the owner's to confirm (section 15, O17).
- Turning the switch off again stops the new handling and removes nothing it wrote.

**The unique index, during the rollout.** `recordEarning` inserts with `onConflictDoNothing({ target: order_id })` (section 1), which needs a unique index on `order_id` alone, and containers of the release before PR 2 run beside the new ones during a deploy. So PR 2 adds `part` (default `main`) and unique `(order_id, part)`, **and keeps unique `order_id`.** Until sub-affiliates exist an order has one row at most, so both hold, and new code names `(order_id, part)` as its conflict target from PR 2 on. PR 14, which writes a second row, drops unique `order_id`; its release note says it must not deploy while a container older than PR 2's release runs.

**Amounts as `bigint`.** `net_amount`, `commission_amount` and the new amount columns become `bigint`. They are `integer` today, which a large rupee order could one day exceed.

**What an affiliate may read.** `view()` hands the affiliate the operator's notes, the Polar discount id and a pending email today. The affiliate's page gets a view of its own with none of them.

### 8.5 Pausing and removing

- **Pausing** today leaves the code alive at Polar and the earning path blind to it (section 1). After this change:
    - **`affiliates.paused_at`** is set beside `active`, and cleared on resume. "Brought before the pause" is judged against it: a customer whose attribution, or a company whose `affiliate_tied_at`, is earlier goes on earning; anything later ties nothing and earns nothing. A boolean could not say which side of the pause an order's customer was on.
    - `findAffiliateByDiscount`, `findAffiliateForCustomer` and rule 3 of 8.1 make no **new** tie for a paused affiliate, even if a stale code got through.
    - **HushOS asks Polar to end both discounts now, and never deletes one.** It sets an end date of now on the personal discount and on the team discount. If Polar refuses to change a discount that has been used (it fixes a used discount's terms; run E15 shows whether the end date is one of them), the discount is left as it is. The second draft's other way, deleting it and making it again on resume, is not taken: a new discount has a new id, so customers who only ever used the code would stop being found by `findAffiliateByDiscount`, and deleting may strip the discount from subscriptions that carry it.
    - **What that leaves.** For a team plan, nothing: Polar's checkout takes no code and HushOS applies none for a paused affiliate. For a personal or family plan, a stale code typed at Polar may still give its discount if Polar would not end it. It earns the affiliate nothing. The discount given is the residual, and the operator's guide says so.
    - Customers and companies already tied go on earning, as today. To stop that too, an operator voids or removes.
- **Removing** is refused while anything is owed, held or flagged, or a clawback is unsettled. With voiding and settling, an operator can clear a fraudulent affiliate's ledger and then remove them.
- **Removing no longer deletes the ledger.** Today deleting an affiliate's row deletes their attributions and, by cascade, their earnings (section 1). That would now take dispute records and settled clawbacks with it. With `AFFILIATE_V2_ENABLED`, removing sets `removed_at`: the page and the code go, the discounts are ended as a pause ends them, nothing ties or earns from then on, and the row and its ledger stay. An operator may delete the row itself only once nothing on it is owed, held, flagged or unsettled, and the ledger is then exported first by the page's own download.

## 9. Sub-affiliates

### 9.1 What it is

- **Operators still enrol the main affiliate,** by hand, as today.
- A main affiliate may invite sub-affiliates from their own page: a name, an email, a slug and a code, and **a share of their own commission.**
- **A sub is live only after two more steps:** the invited person accepts (signed in, agreeing to the affiliate terms), and an operator approves them. Until then there is no page, no code and nothing to earn. HushOS pays these people, and a parent could otherwise put any name and slug on hushos.com and make HushOS owe money to someone nobody checked. Section 15, O8.
- A live sub has their own `/go/<slug>` page and discounts, made with the parent's terms as they stood that day.
- When an order comes through a sub, the commission is the parent's rate on that order, and it is split in two. **HushOS never pays more for an order than the main affiliate's commission.**
- HushOS pays each of them directly, by hand, as today: an operator marks each one's earnings paid.

### 9.2 The schema

`affiliates` gains:

| Column              | What                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `parent_id`         | The main affiliate, null for a main one                                                        |
| `is_main`           | True exactly when `parent_id` is null (a check)                                                |
| `parent_is_main`    | Always true on a sub's row, null on a main one's                                               |
| `share_bps`         | The sub's share of the commission on orders they brought, 0 to 10,000. Null on a main one's    |
| `pending_share_bps` | A lower share on its way, and `pending_share_at`, the day it takes effect. Both null otherwise |
| `sub_state`         | `invited`, `accepted`, `approved`, `ending`, `ended`. Null on a main one's                     |
| `ending_at`         | The day a removal by the parent takes effect (9.4)                                             |
| `company_months`    | 8.3's term, on a main affiliate. A sub's companies use the parent's                            |
| `paused_at`         | When the pause began, null while active (8.5). On main and sub rows alike                      |
| `removed_at`        | Set by a removal, which keeps the row and its ledger (8.5)                                     |

- **One level, held by the database:** a foreign key from `(parent_id, parent_is_main)` to `(id, is_main)`. A sub's row has `is_main` false, so nothing can name it as a parent. A test inserts a third level to prove it is refused. The composite key is designed here and not yet tried in Drizzle.
- A sub's `commission_bps` is null: the rate is always the parent's at the time of the order.
- **A sub's discount terms are fixed when it is made.** Polar refuses to change the terms of a discount that has been used (the existing 422 message says so), so a parent's change of terms cannot be pushed to every sub, as the first draft had it. A change applies to subs made after it. **Replacing the discount of a sub that exists is not offered.** The third draft said an operator could, "which gives it a new code": the team discount has no code (8.2), and a replacement is a new discount with a new id, which 8.5 refuses for the reason it gives (customers who only ever used the old one would no longer be found by it). A sub keeps the terms it was made with.
- At most 50 subs to a parent (`AFFILIATE_SUB_LIMIT`).
- One account is tied to at most one sub row, and never to both a main row and a sub row.

`affiliate_earnings` changes from one row an order to at most two:

- a new column `part`, `main` or `sub`, with **unique `(order_id, part)`.** PR 2 adds both and keeps unique `order_id` beside them; PR 14, which writes the second row, drops unique `order_id` (8.4 says why it cannot go sooner). The first draft's unique `(order_id, affiliate_id)` would have let two attribution paths (the delivery and the job that grants kept rewards) pay two different affiliates for one order; with `part`, a second `main` row for an order is impossible whatever path writes it;
- before inserting, under the order's lock, the writer reads any rows the order already has and writes nothing if there are any;
- `via_affiliate_id` (the sub the order came through, on both rows) and `share_bps` (the share used, as it stood when the order was paid). `pot_amount` and the rest of section 8.4's columns are there already, from PR 2.

### 9.3 Splitting one order

Under the order's lock (`lockOrder`, as today), with the company's or the customer's affiliate being an approved sub:

```
pot    = 8.3's pot, at parent.commission_bps: floor(floor(net × bps / 10000) × inside / span)
sub    = floor(pot × sub.share_bps / 10000)
parent = pot − sub
```

- **The pot is 8.3's, cut to the part of the order inside the term, and it is not worked out again here.** The third draft wrote it as `floor(net × bps / 10000)`, which is the pot only for an order wholly inside the term. For one that runs past it, the two rows would have summed to more than the order earns.
- Both rows are written in one transaction, or neither.
- **The parts always sum to the pot,** prorated or not, because the parent's is the remainder. Checked by script over a range of nets, rates, shares, parts inside the term, refunds and lost disputes (400,000 orders, each split before and after): no case loses or makes a minor unit, and no part is below zero.
- On a small pot the sub's part can round to 0. It is still written, so the order is visibly accounted for.
- After a refund or a lost dispute, 8.4's `earningLeft` gives `left` for the pot, and it is split again by the same two lines with the share the order was paid at, so the two rows still sum.
- A replayed delivery finds the rows and writes nothing.

### 9.4 Changes, pauses, removals

- **The share:** a parent may raise it at once. A cut is written to `pending_share_bps` and takes effect 30 days later. Every earning keeps the share it was paid at.
- **The mail to the sub** on a cut says what they earn now and from when, as one figure each ("You earn 6% of what customers pay. From 12 December, 4%."). It never states the share: the share and that figure together give away the parent's rate, which 9.5 says a sub never sees.
- **A parent removing a sub is a cut to nothing, so it takes the same 30 days.** The first draft let a parent remove a sub the day after a payout and keep everything that sub's customers paid from then on. Now: the sub becomes `ending`, their page and code stop at once, and for 30 days orders of customers they already brought still split at the share. On `ending_at`:
    - the customers and companies tied to the sub are tied to the parent, explicitly, in one transaction (`referrals.affiliate_id` and `group_billing_customers.affiliate_id` are rewritten);
    - **orders that reach the sub by its discount are tied to the parent too.** A personal or family customer who only ever used the sub's code is found by `findAffiliateByDiscount`, through the discount's id, and has no `referrals` row to rewrite. So the ended sub's discount ids stay on its row, and the lookup answers the parent for a discount whose affiliate is `ended`: such an order earns one `main` row for the parent and no `sub` row. Without this, those customers' orders would have gone on splitting with a sub who was removed, or earned nobody anything;
    - the sub's row becomes `ended` and **is kept,** with its ledger. Deleting an affiliate's row deletes their ledger by cascade today; a sub's row is deleted only by an operator, and only when nothing is owed, held or flagged.
- **A sub pausing themselves or being paused:** 8.5 applies, with the sub's own `paused_at`. Orders of customers they brought before it go on earning for both.
- **A parent paused by an operator:** the parent's and every sub's page and codes stop, and each row's `paused_at` is set. Orders already tied go on earning.
- **A parent removed:** refused while they have subs that are not `ended`, or anything owed, held, flagged or unsettled (8.5). An operator first promotes each sub to a main affiliate (giving them a rate of their own) or ends them.
- **An operator** can end a sub at once, without the notice, for cause.

### 9.5 What each sees

| Who      | Sees                                                                                                                                                                                                                         | Never sees                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A sub    | Their link and code; sign-ups and monthly totals through them; what they are owed, held and were paid, and why any of it is held or was taken off (below); the rate they earn of what customers pay; the parent's name       | The share, the parent's rate, the parent's earnings, other subs, any customer's identity                                            |
| A parent | The same for themselves; each sub's name, state, sign-ups and monthly totals, the commission those made and how it was split; each sub's share and any cut pending                                                           | A sub's email after the invitation; what HushOS has paid a sub, holds back from one or takes back from one; any customer's identity |
| Operator | Everything, on the Affiliates page: the tree, both parts of every order, flags, disputes, clawbacks open and settled (and the cut-over's awaiting a yes), what is owed and held to each, the queue of subs awaiting approval |                                                                                                                                     |

A sub's page shows one figure, "You earn 6% of what they pay", which is the parent's rate times the share.

**What each sees of holds, flags, disputes and clawbacks.** These now change what a person is paid, so a payout smaller than the page's "owed" must be explained on the page, without giving away an order or a customer.

- **An affiliate and a sub each see, for their own part, by currency:** what is held and until when (the 30 days); what is under review (earnings flagged `member` or `self`, as one total, with "HushOS is checking these before they can be paid"); what is disputed (the total on payments a customer's bank is questioning, with "These are paid if the bank decides the payment stands"); what was taken off after refunds and chargebacks, by month; what is to be taken back from future payouts (their open, confirmed clawbacks, as one total) and what has been; and what HushOS withdrew (voided earnings, as one total, with the way to write to HushOS).
- **Never:** which order, which customer or company, a date finer than the month, which flag an earning carries, the operator's reason for a void, or an unconfirmed clawback from the cut-over (it is not a debt until an operator says so).
- **A parent sees of a sub** only what the table gives: the commission the sub's orders made and how it was split, after refunds and lost disputes. Not what is held, flagged, disputed, taken back or withdrawn on the sub's part: that is between HushOS and the sub, as what HushOS has paid a sub is.
- **A sub sees nothing of the parent's.**
- An operator sees every one of these for each earning, with the order.

### 9.6 The affiliate's page

Today an affiliate's figures are a block on Invite friends. It becomes a page of its own, `/app/affiliate`, for an account tied to an affiliate:

- the link and the code;
- sign-ups, and what is owed, held and paid, by currency;
- **what stands between "earned" and "paid", as 9.5 lists it:** held until a date, under review, disputed, taken off after refunds and chargebacks, to be taken back from future payouts, and withdrawn. Each is a total, by currency, so the figures on the page add up to the payout the affiliate receives. None names an order or a customer;
- **totals by calendar month,** never a list of orders. The first draft listed each order with its date and net amount. For a company that is a record of every admission as it happens (each seat added is an order), shown to someone outside the company. A month's total says what was earned and no more. Orders of personal and family plans are folded into the same monthly totals;
- for a main affiliate: their subs, with Invite, Change share, Pause and End.

Invite friends keeps the storage referrals and links to it.

### 9.7 Is this multi-level marketing

It has one feature of it: someone earns from sales another person made. It is kept from becoming it by five rules, each enforced, not promised:

- **One level.** The database refuses a third.
- **No payment for recruiting.** Nothing is earned when a sub joins, only when a customer pays.
- **No buy-in.** A sub pays nothing, and neither does an affiliate.
- **No new money.** A sub's earnings come out of the parent's commission on that same order; HushOS's cost per order is unchanged.
- **Nobody is a sub without an operator's approval.**

Affiliate terms must say all five, and that affiliates disclose the relationship where they promote. Those terms are a document this design needs and does not write.

### 9.8 Abuse

| Case                                                      | What stops it                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing up through one's own link                         | The `self` flag: the order's earning waits for an operator                                                                                                                                                                   |
| An affiliate referring their own company                  | The `member` flag, and a second account by the hold and voiding                                                                                                                                                              |
| A stolen card, then a chargeback                          | 8.4: the daily read of Polar's disputes flags both parts while it is open and zeroes them if it is lost; most land inside the 30-day hold. Where the disputes list cannot be read (run E22), only the hold stands against it |
| A parent enrolling themselves as their own sub            | Refused: a sub's email and account may not be the parent's, nor any main affiliate's. It would gain nothing anyway (the pot is fixed)                                                                                        |
| A parent putting a well-known name on a page              | No page exists until the named person accepts and an operator approves                                                                                                                                                       |
| A parent enrolling a customer as a sub, to pay a kickback | Allowed by the mechanism; it is a discount the parent funds. The `member` flag shows it                                                                                                                                      |
| A parent cutting or removing a sub after a big sale       | 9.4's 30 days, for both                                                                                                                                                                                                      |
| A sub chain by renaming                                   | The foreign key                                                                                                                                                                                                              |
| A coupon site's code                                      | A typed code ties a company only when no sign-up does (8.1), and is at most 20% for at most 12 months, never `once` (3.5). It still ties that company for the term: the stated residual (O12)                                |
| A paused affiliate's code still in circulation            | 8.5                                                                                                                                                                                                                          |

## 10. Routes and errors

Under `/api/groups/:id/billing`, all behind `COMPANIES_ENABLED`, all for a group of kind `org`. "Holder" is an active `billing` holder.

| Route                                                 | Who                                                                                                          | Body → answer                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                               | Holder: everything. Admin: plan, seats, total, the setting. Member: the standing only                        | → the plan, seats used and paid, the total, the states of 6.2, what waits on a bank                                                                                                                                         |
| `POST /quotes`                                        | Holder; a `members` holder where 3.2 lets them buy                                                           | `{ units }` (a holder only) or `{ admitting: [userId, …] }`, each a person waiting to be let in → the quote of 3.3                                                                                                          |
| `POST /checkout`                                      | Holder                                                                                                       | `{ productId, units, currency?, code? }` → `{ url }`; 409 `too-small`, 409 `storage`, 409 `discount`, 402 `seats` (`cap`, `rupees`)                                                                                         |
| `POST /seats`                                         | Holder. A raise whose quote names people being let in: also a `members` holder where 3.2 lets them buy (3.3) | `{ quoteId }` (a raise) or `{ units, seen }` (a cut, a holder only) → the plan; 402 `seats` (`card` during a hold, `quote` when someone named no longer waits), 409 `too-small`                                             |
| `POST /plan`                                          | Holder                                                                                                       | `{ productId }` (the other plan or the other interval) → the plan; 409 `storage`, 402 `seats` (`card` when the change charges at once during a hold, 5.4)                                                                   |
| `POST /cancel`, `POST /resume`                        | Holder                                                                                                       | → the plan                                                                                                                                                                                                                  |
| `POST /portal`                                        | Holder; a former holder while their hold is open (5.4)                                                       | → `{ url }`                                                                                                                                                                                                                 |
| `PATCH /settings`                                     | Holder                                                                                                       | `{ seatsOnAdmission?, admissionSeatLimit? }`                                                                                                                                                                                |
| `POST /card-confirmed`                                | The departing holder, in the leave flow: at once. An Owner: pending for 7 days (5.4)                         | → the plan, with `cardHold: { since, confirmation: null \| { by, effectiveAt } }`, `since` being the earliest open hold; 409 `card` when a former holder with an open hold cannot be mailed away from the company's domains |
| `POST /card-objection`                                | Any former holder with an open hold: signed in, or by the signed link in the mail                            | → `{ ok }`; cancels a pending confirmation                                                                                                                                                                                  |
| `PATCH /api/groups/:id/members/:userId/storage-limit` | Admin                                                                                                        | `{ bytes \| null }`                                                                                                                                                                                                         |
| `PATCH /api/admin/groups/:id` (C28)                   | An operator                                                                                                  | `{ seatCap?, customBps?, customNote? }`                                                                                                                                                                                     |

Route 17 (`admit`) gains `buySeat?: { quoteId }`. C25, the claim for an automatic admission, does not: it never buys (3.2), and a call that carries one is refused as malformed.

**In a closed company** (6.3) these are never answered `closed`: route 20 (leave) and account deletion; the reads a data admin's download needs (routes 3, 5 and 25, C1, C2, C5, C6, C7, C13 with `purpose: 'browse'`, C14, C15, C16, C17, C20, C32, C34, and Drive's listing, opening and downloading in the company's areas); removal and suspension with what they need (routes 7, 19 and 27, C8, C26, C30); and this section's `GET /`, `POST /checkout`, `POST /portal`, `POST /card-confirmed` and `POST /card-objection`, which are the Billing page and the way back.

| Code         | Status | When                                                                                                                                                                                           |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seats`      | 402    | With `data.reason`: the family's reasons, and `quote` (with a fresh quote), `payer`, `card` (any charge made on a click during a card hold: seats, the dearer plan, the yearly plan), `rupees` |
| `too-small`  | 409    | A checkout or a cut whose seats give less than is stored; `data.seatsNeeded`                                                                                                                   |
| `storage`    | 409    | Section 7's rule; `data.reason` is `region-files`, `no-bucket` or `switch-pending`                                                                                                             |
| `plan`       | 402    | The storage design's move back into a region; `data.reason` is `own-storage` or `unpaid`                                                                                                       |
| `discount`   | 409    | A code that cannot be used for a team plan, or a company already tied to another offer                                                                                                         |
| `closed`     | 403    | The company is closed (6.3): for anything but a data admin's open and download, removal and suspension, the Billing page, leaving and account deletion                                         |
| `card`       | 409    | `POST /card-confirmed` by an Owner when a former holder with an open hold has no address outside the company's verified domains to be told at, or no account                                   |
| `area-limit` | 409    | With `data.reason: 'storage'`: without billing, one more area's allowance would take the sum past `ORG_STORAGE_CEILING_BYTES` (4.6). On the company spec's area routes                         |

## 11. What the server learns, and threats

### 11.1 What is learned

**HushOS's database, beyond what families already hold:**

- each company's plan, seats, seat limit, custom price, the two purchase settings, and whether it is closed;
- each member's storage limit and the use of each area;
- quotes, for ten minutes each: which account was offered which purchase, and for which waiting people; then deleted;
- seat purchases (`group_seat_purchases`): how many seats were bought, when, how, and by which order at Polar, with no account named;
- which card a departing holder or an Owner said was the company's, by Polar's id for it, and who said so;
- which departed holders may own the card on file (`group_card_holds`), by account, with when each was told and how each hold closed;
- for each subscription, the end of the last cycle that was paid (`paid_through`) and the order that paid it;
- disputes read from Polar's list, for any order whether it has earned commission yet or not: Polar's id, the order's id and the status. No amount, no customer and no reason is kept;
- which affiliate each company is tied to, and the parts of each order's commission;
- the country of each paid order's billing address, for 2.4's comparison.

**Who bought which seat** is in the company's activity ledger (`seats-changed`, with a detail record only the company's admins read) and in the mail to its `billing` holders. It is not written to Polar: the first draft put the admitter's id on the order's metadata, which contradicts "Polar never learns who the members are" and rests on a raise being able to carry metadata, which nobody has seen.

**Polar:** 5.2's list. Seat counts, never members.

**An affiliate:** monthly totals, and the totals of what is held, under review, disputed, taken off and to be taken back (9.5). Never who a customer is, that a given company exists, when it adds a seat, or which order a hold or a clawback is about.

**A member without a role:** their own area's use and limit, and whether the company has room. No figure for the company's use, on a page or in an upload's refusal (4.3).

### 11.2 Threats

| Threat                                                               | What happens                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More members than seats paid for                                     | Not reachable through HushOS: the count is taken under the group's lock, by `holdsSeat`, against the limit the reconcile wrote from Polar's paid units                                                                                                                                                  |
| Suspend, admit, resume                                               | `holdsSeat` counts the suspended (3.1)                                                                                                                                                                                                                                                                  |
| A seat count changed in Polar's dashboard, below the members         | The reconcile lists the company for operators and stops admissions. Nobody is removed. If that leaves it over its total, uploads stop and its Owners are told (4.4); it is not closed                                                                                                                   |
| A switch to yearly the bank never confirms                           | `paid_through` gives it no day past the last paid cycle, and the switch is reverted after a day's wait for the bank, if run E20 shows a revert costs the company nothing; otherwise the switch is never turned on (6.5)                                                                                 |
| A company runs on a card that has expired                            | Allowed for as long as Polar retries the renewal, which is the default's stated cost (4.1, O16). It can fill its total in that time. When Polar gives up it has no plan, and 6.3's clock starts                                                                                                         |
| A renewal in retry cuts a paying company off                         | Not possible: `paid_through` and the grace days never end a plan that is `past_due` on a renewal (4.1)                                                                                                                                                                                                  |
| A raise the bank never confirms                                      | Its seats and storage never count (`paid_units`); after `STALE_RAISE_DAYS` it is cut back at the period's end, as for families                                                                                                                                                                          |
| Storage filled, then seats cut                                       | A scheduled cut lowers the total at once (4.1); a checkout smaller than what is stored is refused (4.4). What neither stops is somebody else's doing, and ends in refused uploads, never a closure                                                                                                      |
| A switch to Team the bank holds, used to move into a region          | The paid product decides, and the move waits for every order (7.1)                                                                                                                                                                                                                                      |
| A large code on a seat plan                                          | 3.5: no typed codes at Polar; 20% at most, for 12 months at most; never `once`, never for ever; only discounts restricted to the team products                                                                                                                                                          |
| One seat shared by several people                                    | Not preventable. One account is one roster entry; the company's Admins see which devices open its space, and can require the second step and device approval (`companies-design.md` 3.9)                                                                                                                |
| A `billing` holder who is not an Owner cancels or cuts               | Every Owner is emailed at once (5.1). A cut cannot go below the members; a cancel can be resumed until the period ends. They can read no file and remove nobody                                                                                                                                         |
| An Admin lets people in to run up the bill                           | Each purchase needs a quote that Admin was shown, for people who are waiting to be let in and nobody else (3.3); off by default on yearly plans; a monthly ceiling counted from purchases, a raise whose answer was lost included; each purchase mails the `billing` holders                            |
| An automatic admission buys a seat                                   | The server reads `auto` from the roster and never buys, whatever the client header says (3.2)                                                                                                                                                                                                           |
| A departed holder's personal card                                    | No charge on anyone's click (seats, the dearer plan, the yearly plan) until they say it is the company's, an Owner's saying so has stood 7 days with them told, or a newer card is the default; they keep the portal and are reminded before each renewal (5.4). Renewals on it are the stated residual |
| An Owner says a departed person's card is the company's              | It takes effect after 7 days, the person is mailed and can object with one click, and which card it was said of is recorded (5.4)                                                                                                                                                                       |
| The Owner's side reads or deletes that notice in a company mailbox   | The notice goes only to addresses outside the company's verified domains. With none, an Owner's confirmation is not offered (5.4)                                                                                                                                                                       |
| Two holders leave in turn, and the first is forgotten                | A hold row for each; an Owner's confirmation mails every one of them, and any one's objection cancels it (5.4)                                                                                                                                                                                          |
| A second holder's checkout deletes the contact at Polar              | `takeOverPayer` is not called for a company; a former holder leaves the team customer only when their hold is closed (5.4)                                                                                                                                                                              |
| A former holder cancels the company's plan from Polar's portal       | Possible while their card may be the one charged: the price of letting them stop it. Every Owner is mailed by the reconcile that sees it, and it can be undone until the period ends (5.1, 5.4, O13)                                                                                                    |
| The contact suspended, removed, leaving or deleted                   | The plan is untouched and the change is not refused: companies are exempt from all four sets of family payer rules (5.3)                                                                                                                                                                                |
| A replayed or forged webhook                                         | Deliveries are verified and recorded by id (`billing_webhook_events`), and every delivery only triggers a re-read of Polar's own state                                                                                                                                                                  |
| A client sending its own seat count or price                         | A client sends a quote id or a target number of seats; prices and limits are the server's                                                                                                                                                                                                               |
| An operator sets a custom price or a seat limit                      | Recorded with who and when; needs the second step once the operator pages have it. An operator with the Polar token could do the same in Polar                                                                                                                                                          |
| Rupee prices from outside India                                      | Bounded by the rupee seat ceiling; mismatches listed for operators (2.4)                                                                                                                                                                                                                                |
| The own-storage price with files in a region                         | 7.1's checks                                                                                                                                                                                                                                                                                            |
| A company fills its total, or its own bucket, then stops paying      | 6.3, for both kinds of storage: closed after 90 days with no live plan, its data admins able to download for 30 more                                                                                                                                                                                    |
| A data admin dismissed after the company is closed keeps downloading | Removal and suspension work in a closed company, and the server ends the person's access in the removal's transaction (6.3)                                                                                                                                                                             |
| A paying company closed for something it did not do                  | Not possible: the clock never runs while a plan is live (6.3)                                                                                                                                                                                                                                           |
| A commission kept after a refund                                     | 8.4: recomputed from Polar's refunds, pro rata, from the stored pot, both parts; held 30 days; voidable                                                                                                                                                                                                 |
| A commission kept after a chargeback                                 | 8.4: read daily from Polar's disputes list, since a chargeback is not a refund and sends no delivery. Unreadable there (run E22), the 30-day hold is the only defence                                                                                                                                   |
| A lost dispute undone by the next refund re-read                     | One function works out what is left from both; `lost` gives 0 whatever the refunds say (8.4)                                                                                                                                                                                                            |
| A dispute seen before its earning is recorded                        | Disputes are kept by order, and whoever records an earning reads them first (8.4)                                                                                                                                                                                                                       |
| A clawback larger than what is owed, written off by one payout       | Settled by amount: only what was netted is taken back, and the rest stays open (8.4)                                                                                                                                                                                                                    |
| The cut-over takes money back from today's affiliates unasked        | Each clawback it creates nets only after an operator's yes to it; what it lowers on unpaid earnings is the owner's to confirm (8.4, O17)                                                                                                                                                                |
| A member reads the company's room from an upload's refusal           | No figure in the refusal for a caller without a role when the company's total refused it (4.3)                                                                                                                                                                                                          |
| A self-hosted company allowed thousands of GiB without billing       | `ORG_STORAGE_CEILING_BYTES`, checked when an area is made against the sum of the allowances its areas were given (4.6)                                                                                                                                                                                  |
| A commission recorded twice                                          | The order's lock, unique `(order_id, part)`, and a read of the order's rows before any insert                                                                                                                                                                                                           |
| Two parts that do not sum                                            | 9.3: the parent's part is the remainder of 8.3's pot, prorated or not, before and after a refund or a lost dispute                                                                                                                                                                                      |
| The seed run against production with the new tables                  | Team products are made only with `--team` and an explicit environment (2.2)                                                                                                                                                                                                                             |

## 12. Tests that must exist

This is money and quota code, so each of these is a Vitest suite beside the code, against real Postgres where rows matter, and none asserts what a mock was told to return.

**Prices and products**

- The team tables pass `priceProblem` with a year in fewer currencies than the month; a year in a currency the month lacks, a base that is not three seats, a year over ten months, a year that does not split into twelve each fail. Personal and family tables still require the same currencies.
- In rupees the largest monthly renewal and the largest single raise, with GST, stay under the e-mandate limit on both plans; a raise or a checkout past `INR_SEAT_MAX` is refused, also when an operator has raised `seat_cap` above it.
- A subscription whose newest paid order's billing country is not its currency's sets `currency_mismatch_at`, and one that agrees again clears it; nothing else about the company changes either way.
- `readCompanyProduct`: a product with both storage keys, with neither, with a bound of 3 in one currency and 4 in another, with a base that is not three seat prices, or of kind `family`, is dropped; the family and personal readers still drop every `org` product.
- The seed plans no team product without `--team`, and refuses `--team` with no explicit environment.

**Seats**

- An invitation and a join request take no seat; an admission takes one; a suspended member and one under notice still hold theirs; the notice's end frees it.
- **Suspend ten, admit ten, resume ten is refused at the first admission past the paid seats.** The checkout floor, the cut floor, `seatsUsed` and the admitting count give the same number for a company with suspended members.
- Two admissions racing for the last paid seat: one gets it.
- Buying at admission: nothing is charged without a quote; a quote for another admitter, an expired one, a spent one, and one whose `from_units` no longer holds each answer `quote` with a fresh quote and charge nothing; a valid one buys exactly its seats.
- **An Admin without `billing` cannot buy ahead:** a quote asked for two named people who are waiting is for the seats held plus two and nothing else; one that names someone who is not waiting, or the same person twice, is refused; they cannot ask for `units`; with one person waiting they cannot get a quote for ten; and an admission whose quote does not name the person, or whose `units` is not the seats held plus the people it names who still wait, is answered `quote` and charges nothing.
- **The raise for several people:** an Admin without `billing` may make it with a quote that names them, where the setting is on and the ceiling allows, and is refused with a `units` quote, with the setting off, past the ceiling, and from a phone. If one of the people named was let in by someone else meanwhile, the answer is `quote` for those who remain and nothing is charged. Its seats count toward the month's ceiling.
- **A raise whose answer was lost:** with the call to Polar timing out after the raise happened, the next reconcile writes one purchase row for it, as `admission` when the quote being spent named people, and it counts toward the month's ceiling; the call's own transaction arriving late writes no second row; a raise made in Polar's dashboard is written as `add` and counts toward no ceiling.
- A quote made in a period that has since renewed is answered `quote` and charges nothing.
- An admission whose roster is `auto` never buys, sent with `HushOS-Client: web`; the claim route refuses a body that carries `buySeat`.
- **The monthly ceiling counts purchases, not quotes:** ten seats bought at admission this month refuse the eleventh for an Admin without `billing`; twenty quotes asked and never spent refuse nothing; a seat bought with "Add seats" does not count toward it; the count starts again with the calendar month.
- The setting: null is on for a monthly plan and off for a yearly one; an Admin without `billing` buys only when it is on and the monthly ceiling is not reached; a phone never does; a 402 lets nobody in and changes no count.
- Letting several people in makes one raise and one order; when only some of them are then admitted, the seats bought stay paid and open, and the next admission takes one without a charge.
- A raise past `seat_cap` is refused; an operator's raised cap takes effect under the lock; the default applies when it is null.
- A cut below the members, or below three, is refused; **a raise after a scheduled cut leaves no cut** (the code's rule, section 1).
- `seat_cap` and `seat_limit` are written by different paths and neither overwrites the other.
- A charge to confirm, asked for by an Admin without `billing`: no link in the answer, one mail to each `billing` holder, and the next admission that needs the seat is answered `confirm` again, as the code does today, and never charged a second time.

**Discounts**

- A team checkout is always created with `allow_discount_codes: false`.
- A code is refused when its discount is unrestricted, restricted to a personal product as well, above 20%, `repeating` for more than 12 months, `forever`, or `once` (on a monthly product too); a 100% `once` code never reaches a team checkout. A discount that passes is sent as `discount_id`.
- A switch to yearly is not refused because a `repeating` discount runs; and no discount that passes 3.5's rules is above 20%, which is what bounds the yearly charge it then covers.
- A checkout of a company with a custom price that rule 1 or 2 ties to an affiliate carries the custom discount and not the affiliate's, takes no code, and still ties the company.
- An affiliate's team discount is made at Polar with no code, and their one code typed into HushOS's field resolves to it by id.
- A custom price change puts the new discount on the subscription before the old one is deleted: with the second call failing, the company still has the old price.
- A custom price: set before a checkout, the checkout carries it and takes no code; set on a live plan, it is put on the subscription; it has no redemption limit, so a second checkout after a lapse still carries it; removing it leaves no discount; a discount deleted at Polar is flagged, not healed; the quote uses it.

**Storage**

- The total is the seats that count × the paid product's per-seat quota: an unpaid raise adds nothing; five seats are exactly five times one.
- **A scheduled cut lowers the total at once:** an upload that fits the old total and not the new one is refused the moment the cut is made.
- **A checkout whose seats give less than is stored is refused,** with the seats needed.
- **An unpaid switch from own storage to Team gives no region storage,** and the move back is refused while any order waits.
- A personal workspace of a company member is never counted and never draws on the company's total, with the member also in a family and not.
- A per-member limit refuses the upload that would pass it, in that member's own area only; an upload to a shared folder ignores it; limits summing past the total reserve nothing.
- A cut refused while more is stored than it would leave; uploads refused over the total; nothing deleted in either case.
- **A paying company over its total is never closed:** made so by a cut in Polar's dashboard, and by a lowered per-seat quota, it has uploads refused, its Owners mailed once and then weekly, a row on the operators' list, and `unpaid_since` stays null however long it lasts.
- **An unpaid interval change adds no day:** a subscription whose `current_period_end` is a year away because of an unpaid interval change gives seats and storage only to the end of the month that was paid, plus the grace days.
- **A renewal in retry keeps everything:** a company whose renewal failed, `past_due` with a cycle order unpaid, still has every seat and its whole total on day 4, day 10 and day 20 after the paid cycle's end, with `current_period_end` left at the paid cycle's end and with it moved on; an upload and an admission both succeed; the reconcile that sees `unpaid` ends both at once. `paid_through` is never the expiry while the order that waits is a cycle order.
- **`paid_through` is stored once for an order:** the reconcile that first sees a cycle order paid writes the period end it read, and a later reconcile that reads another period end for the same order changes nothing; a paid interval change moves it; a cycle order first seen paid while an interval change waits unpaid stores the order's `created_at` plus one interval of the product it paid for, not the year-long period Polar shows.
- A member's view carries no figure for the company's use, checked on the response body; an Admin's does.
- **An upload's refusal gives a member no figure for the company:** refused by the company's total, the answer to a member without a role carries no free figure and names the company's limit; refused by their own limit, it carries their own area's room; the same upload by an Admin carries the figure. Checked on the response body.
- On own storage: no cap, bytes still counted, the per-member limit still applied.
- With `BILLING_PROVIDER=none` a company area has its own allowance and no pool is read; the area that would take the company past `ORG_STORAGE_CEILING_BYTES` is refused `area-limit` with reason `storage`, the one before it is made, an admission's own area counts, and a company on its own bucket is not held to it. **The sum is of the allowances the areas were given:** with `GROUP_AREA_QUOTA_BYTES` halved after a company reached the ceiling, its next area is still refused; with it doubled after a company reached half the ceiling, its next area is still made.

**The two plans and the interval**

- Team, own storage refused with a file in a region; the move back refused on the own-storage plan; a move back refused while a switch to own storage is scheduled, and the switch checked again when it applies; the reconcile's backstop.
- A switch to the dearer plan, and monthly to yearly, charge now and change nothing on a 402; the reverse of each waits for the renewal. Through a switch between the two plans, and through an interval switch once that is turned on, no moment has no plan.
- **An unpaid switch to yearly is reverted after the wait, and not before:** an order unpaid two seconds after the call and paid at the fourth is not reverted; one the bank holds is not reverted at hour 23 and is at hour 24, or at `paid_through` when that comes first; one paid at hour 12 is never reverted. On the revert the product is the monthly one again and every Owner and `billing` holder is told. At no point in the wait did the company hold a seat or a byte past its paid month. A revert Polar refuses lists the company for operators and still gives nothing.
- With the interval switch not yet turned on (runs E19 and E20 outstanding, or E20 showing a revert that charges or credits), the route refuses it and the page offers the other interval at the period's end, saying that the company has no plan between the period's end and the yearly checkout.

**The payer and lifecycle**

- Each `billing` holder can do each action; a member without it cannot.
- **Every Owner is mailed each plan change,** the interval switch and its revert among them. A cancel, a resume and a cut made at Polar and first seen by the reconcile each mail every Owner once, and a second reconcile that reads the same state mails nobody; a change HushOS's own call made is not mailed a second time by the reconcile.
- **A checkout by a holder who is not the contact** (a company with no live plan): the contact on record is unchanged, the holder is a `billing_manager` at Polar, and no member is deleted from the team customer. The same checkout in a family still takes the customer over and deletes the former payer, as today. A former holder is removed from a company's team customer only once their hold is closed.
- **The contact suspended, removed, leaving, without the role, or with a deleted account leaves the company's plan exactly as it was:** not set to end, not revoked, and the change itself is not refused. One test for each row of 5.3's table: with a live plan and with a lapsed one, a company's contact is removed (no `payer`, no `ends-lapsed`, no preview), leaves (no `payer`, no `pays`, no `busy` from a plan change in flight), is the only member and leaves (the company dissolves; its plan is set to end by the dissolved job, not `billed`), and deletes their account (not refused, and the company's lapsed plan is not revoked). The same cases for a family still answer exactly as today.
- The contact on record moves in the departure's transaction; a failed job at Polar is retried and blocks nothing.
- **The card hold:** after a contact, or a billing manager for whom the portal was ever opened, departs without saying the card is the company's, **every action that charges on a click answers `card` and charges nothing:** "Add seats", the raise for several people, buying at admission, the switch to Team from own storage, and the switch to yearly. A cut, a cancel, a resume and a change that waits for the renewal are not refused. The departing person's own yes lifts it at once. An Owner's yes lifts nothing for 7 days, mails the former holder, is cancelled by their objection (by the signed link, without signing in), and takes effect on the eighth day for the card it named and no other. A newer default card lifts it at once. A departure while the default card is one already confirmed starts no hold. The former holder can still open the portal.
- **Where the notice goes:** it is sent to the former holder's addresses outside the company's verified domains and to none inside them. An Owner's confirmation is refused `card` when the former holder's account is gone, and when their only verified addresses are at the company's verified domains; it is offered again once they have one elsewhere.
- **Two holders who leave in turn:** each has a hold row. An Owner's confirmation mails both, either one's objection cancels it, and it is refused `card` if either cannot be mailed. One's own yes closes their row and leaves the hold standing for the other. A card added between the two departures closes the first row and not the second.
- Each of Polar's statuses gives exactly 6.2's seats and storage; removal, suspension and a key change work with no plan.
- The clock: it starts with no live plan and one item; it never starts, and stops at once, with a live plan, `past_due` included; it does not start for an empty company; each mail goes once; a plan on day 89 stops it.
- Closure: on day 90 `closed_at` is set, nothing is retired, no share or link is revoked, and a lapsed plan is revoked at Polar. An Owner and an Admin can list, open and download in every company area and can do nothing else there (an upload, a rename, a share, a delete and an admission are each `closed`); a member without `data_admin` gets `closed`; a `billing` holder reaches the Billing page. **A member can still leave, a running notice still ends, and an account can still be deleted.** A checkout paid on day 100 clears `closed_at`, and every folder, share and link works as before.
- **A closed company can offboard:** on day 91 an Admin is suspended and is refused the next listing and download; a data admin is removed by an Owner's roster with a new company key, is refused from that transaction on, and the remaining data admins still open and download every area after the re-seals. The hand-over and the area key changes stay owed and are done after reopening. An invitation, an admission and a role given are each `closed`.
- **Each read 6.3 lists answers a data admin of a closed company,** one test a route, down to a file's bytes downloaded inside a browse session; the same routes answer a member without `data_admin` `closed`; a key-change session is refused.
- No mail, page or response of a closed or closing company contains the word "export" as a way out; the notices say to download.
- The purge runs on day 120 and not before, in one step and not through a dissolve (nothing of the company is left on day 121; nothing waits for day 150); on an own bucket no object is deleted; a held item survives.

**Affiliates** (with `AFFILIATE_V2_ENABLED`)

- A refund made in Polar, whole or partial, lowers an unpaid earning pro rata and marks a paid one with what is to be clawed back; a refund that later fails raises it again; with two parts, both, and they still sum.
- **The pot is stored and never recomputed from a lowered amount:** two deliveries about one half-refunded order leave half the pot, not a quarter; a third, after the rest is refunded, leaves nothing.
- **Disputes, from Polar's list:** an open one flags the earning and keeps it from being paid; `lost` zeroes an unpaid earning and gives a paid one a clawback of all of it; `won` clears the flag and leaves the amount; `prevented` has that order's refunds read again in the same run and takes nothing beyond the refund. A dispute first seen days after it was opened is still found. With the scope missing the run fails loudly and refunds are still handled.
- **A refund re-read after `lost` leaves 0.** An unpaid earning with a 768 USD pot whose dispute is lost is 0, and is still 0 after the daily re-read of its order's refunds, which finds none; a paid one keeps its clawback of the whole amount through the same re-read. A half refund, then `lost`, then the re-read, is 0.
- **A dispute seen before its earning exists:** with the dispute read first and the earning recorded afterwards by the delivery, and by the kept-rewards job, the earning starts flagged for an open dispute and at 0 for a lost one.
- **A clawback is settled by amount:** with 50 owed and a 768 clawback, marking paid pays 0, applies 50, and leaves 718 open, which the next payout view still nets; a clawback smaller than what is owed is settled and never shown again; two clawbacks are taken oldest first; one settled by hand in part leaves the rest open, and a write-off needs a note. A re-read that lowers a clawback below what was taken back shows the difference as owed to the affiliate.
- **The cut-over's clawbacks wait for a yes:** one it created is listed and is counted in no net and no payout until an operator confirms that clawback; confirmed, it nets as any other. A clawback that arises after the switch nets without one.
- An earning cannot be marked paid before `payable_at`, while flagged, or when voided; a voided one no longer blocks removal.
- **The cut-over:** an earning from before the switch is not held, and one recorded after it is held 30 days; a paid row already marked refunded gains a clawback once, unconfirmed; an unpaid old earning whose order was refunded in Polar is lowered by the first run, whatever its age; a paid one from 100 days back gains an unconfirmed clawback and one from 200 days back is untouched.
- **During the rollout** the insert of the release before PR 2 (`ON CONFLICT (order_id)`) still works against the migrated table, and so does the new one; with unique `order_id` dropped, the old insert fails, which is why PR 14's migration is what drops it.
- A paused affiliate's code ties no new customer or company; a customer attributed before `paused_at` still earns and one after it does not; HushOS asks Polar to end both discounts and, refused, leaves them and deletes neither.
- A removal keeps the row and its ledger, with its dispute records and settled clawbacks; it is refused while a clawback is unsettled.
- The affiliate's own view carries no notes, discount id or pending email, checked on the response body.
- One pot per order whatever the path: the delivery and the kept-rewards job, run in both orders and at once, leave one `main` row.
- A company is tied once, in 8.1's order; a sign-up older than the window ties nothing; a tied company cannot type another code; no later code or payer moves it; a zero-net first order ties nothing; a tying order refunded whole within 30 days unties it.
- The term: `affiliate_tied_at` is the tying order's `created_at` at Polar, whenever its delivery was handled. For a monthly plan the twelfth cycle order earns and the thirteenth does not, with the thirteenth created a second before, at, and a second after the anniversary; for a yearly plan the second does not, the same three ways; an order created inside the term and paid after it earns.
- A monthly company that switches to yearly in its eleventh month earns its affiliate only the part of that year that falls inside the term (8.3's `pot`, `floor(full × inside / span)`, checked with the switch one month and two months before the term's end), not `full`; and `pot_amount` stores that prorated figure.
- An order of a company the affiliate's account is a member of is flagged, not withheld.
- The split: for a range of nets, rates, shares, refunds and lost disputes, the rows always sum to 8.3's pot or to what is left of it, for an order wholly inside the term and for one that runs past it (where the pot is less than `floor(net × bps / 10000)`); both are written or neither; a replay writes nothing.
- A third level cannot be inserted. A sub cannot be the parent, nor a main affiliate. A sub earns nothing before an operator approves them.
- A cut share applies only from its date; a raise at once; each earning keeps its share. A parent's removal of a sub splits for 30 more days, then ties the sub's customers and companies to the parent, and keeps the sub's ledger. After it, an order that carries the ended sub's discount earns the parent one `main` row and no `sub` row.
- A sub's page carries nothing of the share, the parent's rate or the parent's earnings, and no single order, checked on the response body.
- **What an affiliate sees of what is held and taken back:** with one earning held, one flagged, one disputed, one lowered by a refund, one voided and one confirmed clawback, their page's totals account for the difference between earned and paid, and its body carries no order id, no customer, no flag's name and no void reason; an unconfirmed cut-over clawback is not on it; a parent's page carries none of a sub's held, flagged, disputed or clawed-back totals.

## 13. Implementation plan

One change per pull request. Company billing is behind `COMPANIES_ENABLED`; the affiliate changes are behind `AFFILIATE_V2_ENABLED`, because they change code that is live for personal and family orders. "Needs" names what must be merged first; C is `companies-design.md` section 8, S is `company-storage-design.md` section 16.

| PR  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Clients                                                                     | Needs                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `chore(billing)`: the sandbox runs of 13.1, recorded in the spike document. No product code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | None                                                                        | Nothing                                        |
| 2   | `feat(billing)`, `feat(db)`: commission safety, for every order: `pot_amount`, the refund re-read, the daily read of Polar's disputes kept by order and matched when an earning is recorded too, `earningLeft` as the one writer of what is left, the 30-day hold for new earnings, clawbacks settled by amount, the cut-over's clawbacks waiting for an operator's yes, voiding, flags, `part` with unique `(order_id, part)` beside unique `order_id`, amounts as `bigint`, `paused_at` and pausing, removal that keeps the ledger, the cut-over, the affiliate's own view; `disputes:read` in the guide | Web (operators)                                                             | Nothing                                        |
| 3   | `feat(billing)`: the team tables in `seed-prices.ts` with `yearIn: 'subset'`, the rupee ceiling and their tests, the seed's `--team`, `readCompanyProduct` and the company catalogue. Sandbox only                                                                                                                                                                                                                                                                                                                                                                                                         | None                                                                        | 1 (E9)                                         |
| 4   | `feat(db)`: `seat_cap`, and `holdsSeat` in all four counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None                                                                        | C4 (the `suspended` state)                     |
| 5   | `feat(billing)`: companies in the reconcile: the paid product's class and quota, `paid_through` stored when a cycle order is first seen paid, the three expiries of 4.1 (a renewal in retry keeps everything), `seat_limit`, the total with a scheduled cut, the mail to Owners for a change made at Polar, the exemptions from all four sets of family payer rules (5.3) and from `takeOverPayer`, and the contact moved in the departure's transaction                                                                                                                                                   | None                                                                        | 3, 4                                           |
| 6   | `feat(db)`, `feat(drive)`: the company branch of the pool (company areas only, in bytes), the checkout and cut floors on what is stored, the mails and the operators' list for a company over its total, an upload's refusal without the company's figure for a member, and `ORG_STORAGE_CEILING_BYTES` without billing, summed from each area's allowance                                                                                                                                                                                                                                                 | None                                                                        | 5                                              |
| 7   | `feat(billing)`: the contact at Polar: billing managers, the move's job, the record of portal sessions opened, the former holder's portal, the card hold (a row for each departed holder, against every charge made on a click) with its two confirmations, the notice sent only outside the company's domains, the objection link and their mails                                                                                                                                                                                                                                                         | Web                                                                         | 5, run E10                                     |
| 8   | `feat(apps)`: the company's Billing page: plan, checkout with HushOS's own code field, quotes, `group_seat_purchases`, add and cut seats, cancel and resume, Card and invoices, every state of 6.2, the purchase settings, buying at admission with a quote, several admissions as one raise; the phones' read-only plan line and refusals                                                                                                                                                                                                                                                                 | Web; iOS and Android (read only)                                            | 6, 7, C5                                       |
| 9   | `feat(apps)`: per-member limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Web, iOS, Android                                                           | 8, C13                                         |
| 10  | `feat(web)`: operators: the Companies page gains the seat cap, the custom price, and the lists (currency and country, seats past what is paid, a missing discount, over the total, a refused revert)                                                                                                                                                                                                                                                                                                                                                                                                       | Web (operators)                                                             | 5, C4's page                                   |
| 11  | `feat(billing)`, `feat(jobs)`, `docs`: closure: `closed_at`, the clock's mails, closing, read-only for data admins by the routes 6.3 lists, removal and suspension in a closed company, reopening, the one-step purge, and the change to `companies-design.md` that 6.3 lists                                                                                                                                                                                                                                                                                                                              | Web (the notices and the closed screen); iOS, Android (the `closed` answer) | 8, and that change reviewed                    |
| 12  | `feat(apps)`: Team, own storage: 7.1's checks and the two switches. Monthly to yearly and back with the wait and the revert, built and left switched off until runs E19 and E20, and for good if E20's revert charges or credits anything                                                                                                                                                                                                                                                                                                                                                                  | Web; one line on the phones                                                 | 8, S10                                         |
| 13  | `feat(billing)`: affiliates on company plans: team discounts with no code, the tie and its window, the term by cycle, the `member` flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Web (operators)                                                             | 2, 5, run E23                                  |
| 14  | `feat(db)`, `feat(billing)`: sub-affiliates on the server: the columns and the foreign key, the states and approval, two rows an order (dropping unique `order_id`), the split, shares and their notice, ending and re-tying                                                                                                                                                                                                                                                                                                                                                                               | None                                                                        | 13, and no container older than PR 2's release |
| 15  | `feat(web)`: the affiliate's page and the sub-affiliate controls; the operators' Affiliates page shows the tree, flags, holds, clawbacks and the approval queue                                                                                                                                                                                                                                                                                                                                                                                                                                            | Web                                                                         | 14                                             |
| 16  | `docs`, `feat(web)`: the pricing page's Team plans, `/teams`, the terms (seats, the 90 days, fair use on own storage), affiliate terms, `docs/self-hosting.md`, the roadmap. Seeding production and the switch-on need the owner's OK                                                                                                                                                                                                                                                                                                                                                                      | Web                                                                         | The rest                                       |

**What is ready to build from this document as it stands, and what each of the others waits for.**

| PR  | Ready?         | Waits for                                                                                                                                                                                                                                                                                                                       |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Yes, now       | Nothing. It has grown: E20 now records what the revert charges and credits and the period after it, E10 looks at whether a checkout offers a card on file, and E24 reads what `current_period_end` shows at a failed renewal and how long Polar retries                                                                         |
| 2   | Yes, now       | Nothing to build it: the two things the third review held it for are in 8.4 (one function for what is left of an earning, and clawbacks settled by amount). To switch it on: the owner's OK (O14 and O17: it changes when today's affiliates are paid and how much), and run E22 for how much the dispute read can be relied on |
| 3   | Specified      | An owner decision: the table (O1, O2, O10). A sandbox run: E9                                                                                                                                                                                                                                                                   |
| 4   | Specified      | Another PR: C4                                                                                                                                                                                                                                                                                                                  |
| 5   | Specified      | Other PRs: 3 and 4. An owner decision built on by default: O16. Run E24 says which of 4.1's expiries a renewal in retry ever needs; the PR builds all three and does not wait for it                                                                                                                                            |
| 6   | Specified      | Another PR: 5. Owner decisions it is built on by default: O4, O15                                                                                                                                                                                                                                                               |
| 7   | Specified      | Another PR: 5, and the company core's PR that builds verified domains (its C22), which the notice's address rule reads. A sandbox run: E10. Owner decisions built on by default: O9, O13                                                                                                                                        |
| 8   | Specified      | Other PRs: 6, 7, C5. An owner decision built on by default: O3                                                                                                                                                                                                                                                                  |
| 9   | Specified      | Other PRs: 8, C13 (the ledger)                                                                                                                                                                                                                                                                                                  |
| 10  | Specified      | Other PRs: 5, C4's page. Run E11 decides one screen's wording                                                                                                                                                                                                                                                                   |
| 11  | Specified      | Another PR: 8. A change to `companies-design.md`, written and reviewed in this PR, which now also names the routes a closed company still answers and settles recovery with the kit                                                                                                                                             |
| 12  | Specified      | Other PRs: 8, S10. Sandbox runs E19 and E20 before the interval switch is turned on, and E20 must show a revert that charges and credits nothing; the rest of the PR does not wait for them                                                                                                                                     |
| 13  | Specified      | Other PRs: 2, 5. A sandbox run: E23. Owner decisions built on by default: O6, O7, O11, O12                                                                                                                                                                                                                                      |
| 14  | Specified      | Another PR: 13. An owner decision built on by default: O8. A deploy condition: no container older than PR 2's release                                                                                                                                                                                                           |
| 15  | Specified      | Another PR: 14. The affiliate terms, written with it                                                                                                                                                                                                                                                                            |
| 16  | After the rest | The owner's OK for production prices and the switch-on, and O5 (what a stored TB costs) before any production seed                                                                                                                                                                                                              |

"Specified" means nothing in this document is known to block it. The third review's findings are applied; the revision that applied them has not been reviewed again. An owner decision "built on by default" does not hold a PR back: the PR builds the default, and section 15 says what changes otherwise.

**The activity ledger.** PRs 8, 9, 11 and 12 record actions in the company's ledger, which the company core builds in its PR 13. Said plainly:

- PR 8 ships before the ledger exists. Its plan and seat changes are recorded by the mails to Owners and `billing` holders until then, and the PR that builds the ledger adds their records. Nothing in PR 8 is refused for want of a detail record.
- PR 9 waits for the ledger: a limit an Admin sets on a colleague is exactly what the ledger is for.
- The actions this design needs added to `companies-design.md` 3.8, in the PR that first writes each (that file is not edited here): `plan-changed`, `seats-changed`, `billing-setting-changed`, `card-confirmed`, `member-limit-changed`, `company-closed`, `company-reopened`. An operator's seat cap and custom price are already C28's record.

**What each PR carries besides code:**

- **PR 2** changes `docs/self-hosting.md` (the hold, voiding, clawbacks, what pausing and removing now do, the `disputes:read` scope) and the operator's Affiliates page. It is switched on at hushos.com only with the owner's OK, since it changes when affiliates can be paid and, through the cut-over, what today's affiliates are owed (O14, O17).
- **PR 3** changes `docs/self-hosting.md` (the seed's `--team`, the two new metadata keys).
- **PR 4** corrects `companies-design.md` in the four places 3.4 names.
- **PR 6** adds `ORG_STORAGE_CEILING_BYTES` to `docs/self-hosting.md` and `.env.example`.
- **PR 8** adds no public page: the plans are not for sale until PR 16.
- **PR 14**'s release note says it must not deploy while a container older than PR 2's release runs (8.4).
- **PR 16** replaces the pricing page's "coming" Team card with the two plans, updates `/teams`, moves the roadmap item, and adds to the terms. It is the only PR that touches what a visitor reads.
- **PRs 13 to 15** need the affiliate terms before they are switched on; the terms are written with PR 15.

### 13.1 The sandbox runs

All in the sandbox, with the scripts kept beside the spike's. For each: what decision rests on it, and which PR changes if it goes the other way.

| Run | What                                                                                                                                                                                                                                                                                                                                                                            | What rests on it, and what changes otherwise                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E9  | An `org` product pair with 2.1's tables; a checkout at three and at five seats in each currency; the invoice's lines                                                                                                                                                                                                                                                            | Nothing: the shape stays. A unit price alone is not pursued                                                                                                                                                                                                                                                                                                   |
| E10 | The ownership transfer (spike 3, step 2); whether a card a billing manager adds can be made the default; a cancel made in the portal by a billing manager; whether a checkout by another member of the customer is offered a card already on file                                                                                                                               | PR 7. If a checkout offers the card on file, a checkout during a card hold is refused with `card` (5.4). If the transfer fails, the old contact stays `owner` at Polar and HushOS's record moves alone; the card hold (5.4) is unchanged. If a billing manager cannot cancel, O13's cost does not exist and the former holder's mails say to write to support |
| E11 | A discount put on a live subscription: when it starts, and whether a raise before the next cycle carries it                                                                                                                                                                                                                                                                     | PR 10's wording only. If it carries, a custom price works mid-year and 3.6's by-hand refund is not needed                                                                                                                                                                                                                                                     |
| E12 | An order after a product change on a discounted subscription                                                                                                                                                                                                                                                                                                                    | PR 12. If the discount is lost, a plan or interval change re-applies it                                                                                                                                                                                                                                                                                       |
| E13 | A `repeating` discount on a yearly product, and a raise later in that year                                                                                                                                                                                                                                                                                                      | Nothing in the rules. It says what a discounted company is charged for a seat added mid-year, for the quote, and whether 3.5's bound on a short discount is the yearly charge alone or the whole yearly period                                                                                                                                                |
| E14 | How redemptions count when a discount is put on a subscription, and a second checkout with it afterwards                                                                                                                                                                                                                                                                        | PR 10. If a limit is somehow required, a custom price needs a discount per checkout                                                                                                                                                                                                                                                                           |
| E15 | Setting an end date on a discount that has been used, while a live subscription carries it                                                                                                                                                                                                                                                                                      | PR 2's pause. If Polar refuses, the discount is left and the no-new-tie rule stands alone (8.5). If ending it strips the discount from subscriptions that carry it, the pause does not end it either. Deleting is not tried: it is not used                                                                                                                   |
| E16 | A cut and a cancel made in Polar's dashboard, read back by the reconcile                                                                                                                                                                                                                                                                                                        | Nothing; confirms 11.2's rows and 4.4's "over the total" case                                                                                                                                                                                                                                                                                                 |
| E17 | A rupee checkout with a billing address outside India; whether an order carries its billing country                                                                                                                                                                                                                                                                             | PR 5's comparison. If Polar refuses such a checkout, 2.4's list is a backstop that should be empty. If an order has no country, the customer's billing address is read                                                                                                                                                                                        |
| E18 | A refund made in Polar, whole and partial: which of `order.refunded`, `refund.created` and `refund.updated` arrive, and what the order's refunds list shows                                                                                                                                                                                                                     | PR 2. If a delivery is missing, the daily run's re-read of recent earnings is what finds the refund, up to a day late                                                                                                                                                                                                                                         |
| E19 | A paid monthly company plan moved to the yearly product with `invoice`: the amount, the order, the period, the units                                                                                                                                                                                                                                                            | PR 12's interval switch, which stays off until this is seen. If the charge is not the prorated difference, the quote's arithmetic for it changes                                                                                                                                                                                                              |
| E20 | The same switch with a card that asks its holder to authenticate, if the sandbox has one: the subscription's status and period and the order while it waits. Then the revert to the monthly product: whether Polar accepts it, what it charges, what it credits and where, which orders it makes, what becomes of the unpaid yearly order, and what the period reads afterwards | PR 12 and 6.5. If the subscription stays active with a year-long period, `paid_through` and the revert after the wait are what stand between a company and a free year, as designed. If the revert is refused, or charges a second month, or leaves a credit for a year nobody paid, the interval switch is not turned on at all                              |
| E21 | A `once` discount on a monthly checkout, then the switch to yearly                                                                                                                                                                                                                                                                                                              | Nothing: `once` is refused on team plans whatever it shows. It records why                                                                                                                                                                                                                                                                                    |
| E22 | `disputes.list` with the sandbox token and the `disputes:read` scope: whether it answers for this organisation, and what a dispute looks like if the sandbox can raise one                                                                                                                                                                                                      | PR 2's switch-on. If the list is not available, commission safety covers refunds and `prevented` disputes only, the 30-day hold is the only defence against a chargeback, and the guide and O14 say so. No schema changes                                                                                                                                     |
| E23 | A discount with no code, restricted to the team products, passed as `discount_id` to a checkout that has `allow_discount_codes: false`                                                                                                                                                                                                                                          | PR 13 and 3.5. If Polar refuses a codeless discount on a checkout, the team discount carries a generated code of letters and digits that is never shown, and HushOS still passes it by id                                                                                                                                                                     |
| E24 | A renewal that fails (a card that declines at the cycle, if the sandbox has one): the subscription's status, what `current_period_end` reads while Polar retries, the order it leaves, and how often and for how long Polar retries before `unpaid`. Polar's documents are read for the same schedule                                                                           | PR 5 and O16. It says how long the default lets a company run on a dead card, and which of 4.1's expiries a renewal in retry needs. If `current_period_end` stays at the paid cycle's end, the third expiry is what keeps a company served, and family billing has the day-4 defect 4.1 names                                                                 |

**Already established, and not listed as open:** a discount on a checkout does reach a raise in the period it covers (spike, second card round); a mid-period change to a dearer product with `invoice` keeps the anniversary and charges the prorated difference (spike 8, T2); Polar's documents say a billing manager can manage payment methods and cancel.

**Needs the owner and a real card, not the sandbox:** what a real Indian card does above the e-mandate limit (it decides whether yearly rupee prices and more than 31 seats can ever be offered: PR 3's table), and a charge the bank asks to confirm on a seat raise (`PaymentActionRequired`: it decides whether 3.3's hand-off to a `billing` holder has anything to hand off).

## 14. Where the directions cannot be delivered as asked, and where this differs from the reviews

**The directions.**

1. **"Price match similar to our personal plans", in rupees.** The personal ratio is about 40 rupees to the dollar, less than half the market rate. For a Team seat it sells 1 TB for 399 rupees a month, about 4.50 USD, when the storage costs HushOS the same wherever the customer is; and anyone can get that price by checking out once from an Indian address. The table follows the direction, monthly only and with a 31-seat ceiling that nothing in this release lifts. Section 15, O1 and O2.
2. **Whether 8 USD covers 1 TB.** The October plan held prices back "until unit economics exist". They still do not: nothing in the repository says what a stored TB costs HushOS with its backup copy. The price matches Proton's. A company that fills every seat's TB is the case to cost before production prices are seeded. This document cannot. O5.
3. **Rupees above 15,000.** 2.4: no yearly rupee plan and a seat ceiling, until a real card shows otherwise. A company that pays by Indian card cannot have more than 31 seats.
4. **"No storage cap" on own storage.** The bytes cost HushOS nothing. The items do: every file and version is rows and envelopes in HushOS's database, and "uncapped" at five seats could be a hundred million small files. Support is the other cost: a broken bucket is the company's, and HushOS's inbox. Seats-only pricing needs a fair-use line on items.
5. **"Billing starts when someone is let in."** Delivered, with what it takes to be safe: someone who is not a `billing` holder spends the company's money only against a quote they were shown, for exactly the people they are letting in, within a monthly ceiling, and by default only on a monthly plan. O3.
6. **A custom price that starts today.** Polar applies a discount to a live subscription "on the next billing cycle". 3.6 says what the operator does meanwhile.
7. **Handover.** The card belongs to the customer at Polar and cannot be moved or removed by HushOS. HushOS can stop new purchases on it and cannot stop its renewals without ending the company's plan. And the one way HushOS can give a departed person to stop a charge on their own card, Polar's portal, also lets them cancel the company's plan. O9, O13.
8. **An exact amount before a charge.** Polar has no preview. Every quote says "about" and can differ by one minor unit a line, as for families.
9. **Refunds for seats handed back.** Not possible through Polar's public calls; a cut takes effect at the renewal and returns nothing.
10. **"HushOS pays each directly."** By hand, as today: nothing here pays anyone. Two people to pay per order doubles an operator's work at each payout, in every currency an order was paid in, and approving sub-affiliates and settling clawbacks is more of it.
11. **A way out for a company that stops paying.** Not an export: nothing in this release reads one back (`company-storage-design.md` 10.4). What a closed company gets is 30 days in which its Owners and Admins can download.
12. **Commission taken back after a chargeback.** Only as far as Polar's disputes list can be read (run E22), and only once a day, since Polar sends no delivery for a dispute. Past that, the 30-day hold is the whole defence.

**Where this revision differs from the second review's recommendation.**

- **Closure (N1).** Of the three options, the first is taken alone: a paying company is never closed. The clock is not kept as a backstop for dashboard cuts.
- **Monthly to yearly (N2).** All three options are taken together, not one: validity by `paid_through`, a revert when unpaid, no `once` at all, and the switch held off until E19 and E20. The second revision made the revert immediate; the third review showed that undoes switches Polar has not yet charged, and it now waits (6.5).
- **Disputes (N3).** Read from the organisation's list once a day, matched by order, not one call per earning. `prevented` adds nothing, since Polar's own refund for it is already counted and counting both would take the commission twice. And the list may not be there for every organisation: the SDK shows a `disputes_enabled` flag, so E22 comes before anyone relies on it.
- **The card (N6).** Stricter than recommended in one place: an Owner's confirmation is not offered at all when the former holder's account is gone, because there is nobody to tell and nobody to object. Wider in another: the hold covers a departing billing manager, and a card already confirmed starts no new hold, so a company with a company card is asked once.
- **The term (N8).** By cycle, as recommended, with a day's margin instead of a cycle counter, and pro rata for an order whose period runs past the term's end. That last rule also closes the low finding about a switch to yearly in the eleventh month.
- **The rupee ceiling (N9).** The refusal no longer says to write to support. There is nothing support can do.
- **Pausing and removing (N10).** The first way only, as recommended. Beyond it, removing an affiliate stops deleting their row and ledger.
- **The self-hosted ceiling (N13).** 1 TiB by default, not a family's 100 GiB: a company has an area for each person, and ten areas would stop it at ten people.
- **The purge (N14).** One step on day 120, not the dissolved path with a shorter wait.
- **What a member sees (a low finding).** No figure for the company's use at all, not a rounded one.

**Where this revision differs from the third review's recommendation, and what it found on reading the code.**

- **A failed renewal (T3).** As recommended, and one step further: the expiry while a renewal is in retry is written by the reconcile from its own clock and does not rest on `current_period_end`, because nobody has seen what that field reads then (run E24). The review's "as families do today" is what `groups-design.md` says a family gets; whether the family code delivers it past day 4 depends on the same unread field, and this document says so and does not claim it.
- **Polar's retry window.** The review asked for it from the spike document. The spike does not give it: it names `past_due` and says a new default card retries past-due orders, and has no schedule. O16 says so, and E24 reads it.
- **The revert (T4).** The wait is 24 hours and never past `paid_through`. And the condition is stricter than "record it": the mid-period switch is turned on only if E20 shows a revert that charges and credits nothing.
- **The card hold (T5).** A row for each departed holder, in a table, in place of the two columns. A checkout is not held, because the buyer gives a card on Polar's page; E10 checks that, and the rule flips if the page offers the card on file.
- **A closed company (T6).** Removal and suspension work. The hand-over and the area key changes that follow a removal stay owed until the company reopens: they write to Drive, a closed company takes no writes, and reading goes on while they are owed. Recovery with the kit is left open by default and handed to the company spec's change, which the review did not ask about.
- **The lapsed-plan rule.** The fix is in `findLapsedFamilyPlans`, not `isFamilyPayer`: with only the second changed, a company's contact with a live plan would still be refused (`charging`).
- **`payerHold`.** Family-only at the removal write and not in `depart`, so section 1 now says one call reads the kind, and 5.3's row keeps the change inside the function.
- **`takeOverPayer`.** Not called for a company at all. The alternative, calling it and skipping the delete, would still move the contact on a checkout, which 5.4 reserves for a departure.
- **A short `repeating` discount on a yearly charge.** Stated as a bounded cost and not refused: a first checkout on the yearly product gets the same year at the discount, so refusing the switch closes nothing.
- **An upload's refusal.** Withheld for a member, not rounded: two rounded refusals a day apart still measure what a colleague uploaded.

**Where the first revision differed from the first review,** kept for the record: a rupee seat ceiling in place of split raises (H6), which the second review agreed with; the typed code moved from first to last in the attribution order (M5), also agreed; the `member` check as a flag (M6); a departing contact able to say the card is the company's (H4), now with N6's limits on an Owner saying it; storage without billing described as the code has it (M12), now with a ceiling; and the scheduled cut taking effect at once (C2). Two of its choices are reversed here: pausing no longer has a second way (H9), and a paying company is no longer closed for being over its total (H5, C2).

## 15. Decisions to confirm

### The owner's

Each is the owner's to make. The document is built on the default; "otherwise" says what changes. O1 to O10 were in the second draft; four of them are corrected as the second review asked, and O11 to O15 came with the second review: four that draft decided silently, and one the review raised. O16 and O17 come from the third review, which also corrected O9 and O14. Numbers already given are kept, so the two new ones are last.

- **O1. Rupee prices for team plans.** _Default: the personal ratio (399 and 239 a seat a month), monthly only, at most 31 seats on Team and 53 on own storage, with mismatches of currency and billing country listed for operators._ Cost: an Indian company's seat earns about 4.50 USD for 1 TB, and the price is reachable from an Indian address. **And there is no way past 31 seats:** a company that pays by Indian card and outgrows it cannot be served in this release, whatever an operator sets. Otherwise: price a seat nearer the dollar price (about 830 rupees); the table and one test change, nothing else, and the ceiling falls to 15 seats.
- **O2. Yearly plans in rupees.** _Default: none until a real Indian card shows a renewal above 15,000 rupees succeeds._ Cost: Indian companies cannot take the yearly saving. Otherwise: add the yearly prices (3,900 and 2,400) knowing a company of four or more seats will most likely fail every renewal.
- **O3. An Admin who is not a billing holder spends at admission.** _Default: on for monthly plans, off for yearly, always against a quote for exactly the people being let in, with a ceiling of ten seats a month; the company can change both._ Cost on monthly: an Admin can add up to ten seats a month, 100 USD. Otherwise: off everywhere means admissions wait for a `billing` holder to add seats; on everywhere means one click on a yearly plan can cost 96 USD that cannot be handed back.
- **O4. When a company is closed.** _Default: only when it has no live plan. After 90 days with no plan and anything stored it is closed; its Owners and Admins can download for 30 more days; then it is purged. Own-storage companies included. A company that is paying is never closed, whatever it stores: over its total, its uploads are refused and its Owners are told._ Cost: a paying company that is over its total keeps reading what it holds for as long as it pays. It cannot get there by its own doing (a scheduled cut bites at once, and a checkout too small for what is stored is refused), so this is only ever a company that a dashboard cut, an operator's refund or a quota HushOS lowered put there. Otherwise: run the clock for those too. A company paying 4,800 USD a year could then be closed on day 90, with its plan set to end and about 3,600 USD of paid time gone, for something it did not do. Or exempt own storage from closing, which lets one month's payment buy signed downloads for good.
- **O5. Whether 8 USD a seat covers 1 TB.** _Default: the prices as given, not to be seeded in production until the owner has costed a stored TB with its backup._ Nothing in the repository can answer it. Otherwise: a smaller per-seat quota is one metadata value and one sentence on the page. **It is far cheaper to settle before the first sale than after:** lowering `quota_bytes_per_member` later reaches every existing subscriber at the next reconcile, and every company storing more than the new figure has its uploads refused that day.
- **O6. The commission term and the sign-up window.** _Default: a company's billing cycles earn for 12 months from its first paid order; a sign-up ties a new company only if it was within 90 days._ Cost: an affiliate who brought a founder last year earns nothing on the company they start today. And where no sign-up ties a company, a typed code does (O12). Otherwise: no term is today's rule for personal plans and pays for as long as a fifty-seat company exists; no window ties companies to attributions of any age.
- **O7. An affiliate who is a member of the company.** _Default: the order earns and is flagged; an operator releases or voids it before it can be paid._ Cost: operator work on every such order. Otherwise: pay nothing automatically, which a second account evades and which takes commission from a consultant added to a client's company.
- **O8. Sub-affiliates need an operator's approval before anything is payable.** _Default: yes, and before their page goes live._ Cost: a queue for operators, and a parent cannot bring someone on in a minute. Otherwise: self-serve subs, with HushOS owing money to people it never checked and any name usable on a hushos.com page.
- **O9. A departed holder's card.** _Default: no charge on anyone's click until the departing person says the card is the company's, a newer card is the default, or an Owner's saying so has stood for 7 days with the departed person told and not objecting; the plan is not set to end and renewals go on; the former holder keeps Card and invoices and is reminded before each renewal._ **A plan change charges that card as a seat does,** so the hold covers both: adding seats, the switch to the dearer plan, and the switch to yearly, which on fifty seats is 4,800 USD on one click. The notice of an Owner's confirmation goes only to an address outside the company's domains; where the departed person has none, an Owner's word is not accepted at all. Cost: a personal card can be charged a renewal after its owner left, until someone acts; an Owner's word, unopposed for a week, reopens every such charge on it; and a company under a hold can neither grow nor move to the dearer or the yearly plan until someone answers or a card is added. Otherwise: set the plan to end unless a new card is added within N days, which protects the person and risks a company losing its plan because finance staff changed; or never accept an Owner's word, which leaves a company whose former contact will not answer with one way forward, a new card.
- **O10. 5.00 GBP a month on own storage.** _Default: 5.00, with 48 a year (4.00 a month)._ Cost: 4% above the ratio. Otherwise 4.80, the only seat price in the product that is not a whole unit.
- **O11. How large a discount a team plan may carry.** _Default: at most 20%, for at most 12 months; never `once`, never for ever._ With a 20% discount and a 20% commission HushOS keeps 64 of every 100 of list price in a company's first year, before Polar's fees, and all of it after. Cost: less room for a promotion, and an affiliate's team offer may be smaller than their personal one. And the 12 months are not a hard edge on a yearly plan: a discount still running when a yearly charge is made covers that whole charge, so a discount of any length is worth up to one more year at its percentage (at most 960 USD on fifty seats; 3.5 says why the switch is not refused instead). Otherwise: the second draft's 30%, allowed for ever, keeps 56 in the first year and 70 for good; any `once` reopens the hole of 3.5.
- **O12. What a typed code alone ties.** _Default: the same as a sign-up: the company, for 12 months._ Cost: a code found on a coupon site earns its affiliate a year of a company they never brought, and most companies will have no sign-up tie to outrank it. Otherwise: a code gives its discount and ties the first order only (one more value on the tie, and 8.3's term read from it), or gives its discount and ties nothing, which removes the reason for an affiliate to hand out a code for team plans at all.
- **O13. A former holder may cancel the company's plan.** _Default: yes. While their card may be the one charged they keep Card and invoices, and Polar's portal lets a billing manager cancel._ Cost: someone who has left can set the company's plan to end. Every Owner is mailed when the reconcile sees it (the cancel is made at Polar, so that mail is the reconcile's to send, 5.1), it can be undone until the period ends, and a company card ends their access. Otherwise: do not keep them at Polar at all, and the only way they can stop a charge on their own card is their bank, which is a chargeback against HushOS; or take O9's alternative.
- **O14. Who the 30-day hold applies to, and from when.** _Default: earnings recorded after `AFFILIATE_V2_ENABLED` is turned on. An earning from before that day is not held. The date is the owner's, with notice to today's affiliates._ **Switching it on does change what today's affiliates get, not only when.** The third draft said here that "anything already owed that day is payable as it was". That is true of the date and false of the amount: the cut-over (8.4) lowers unpaid earnings whose orders were refunded, and gives earnings paid in the last 120 days a clawback where their orders were refunded or charged back. How far back that reaches is O17. Cost: from that date an affiliate waits 30 days for each new earning. Otherwise: no hold, and every chargeback after a payout is a clawback to chase by hand, with the dispute read (if run E22 shows it works) arriving after the money has gone.
- **O15. What a company may be allowed on a server without billing.** _Default: `ORG_STORAGE_CEILING_BYTES` of 1 TiB, checked when an area is made; operators change it._ Cost: a self-hosted company past about a hundred areas at the default allowance is refused its next one until the operator raises the ceiling or lowers the allowance. Otherwise: no ceiling leaves 5,000 GiB a company and three companies an account; a family's 100 GiB would stop a company at ten areas, which is ten people.
- **O16. How long a company keeps its service after a renewal fails.** _Default: for as long as Polar keeps the subscription `past_due` and goes on retrying the payment, as for a family. Seats and storage end when Polar gives up (`unpaid`). `paid_through` and the grace days govern only a plan change that is not paid (an interval switch, a seat raise, another product), never a renewal in retry._ Cost: a company can run on an expired card, with every seat and its whole storage total, for Polar's whole retry window, and can fill its total in that time. **How long that window is, is not known here.** `docs/archive/polar-group-billing-spike.md` does not give it: it names the `past_due` status and says a new default card retries past-due orders, and has no schedule. Run E24 reads it, and it is Polar's setting, so it can change without HushOS changing anything. A company that never pays then has no plan, and the 90 days of 6.3 start. Otherwise: end seats and storage a fixed number of days after the last paid cycle (`paid_through` plus a grace of the owner's choosing). The third draft did that with three days, and a fifty-seat company whose card had expired was refused every upload and admission on day 4, with its plan live and Polar still trying. It is one setting and one of 4.1's three expiries; nothing else changes.
- **O17. How far back the cut-over reaches.** _Default: on the day `AFFILIATE_V2_ENABLED` is turned on, HushOS reads the refunds and disputes that nothing acted on at the time, for every unpaid earning whatever its age, and for every earning paid in the last 120 days. An unpaid one is lowered at once. A paid one gains a clawback that is taken from a later payout only after an operator has said yes to that clawback._ Cost: today's affiliates are owed less the day after the switch than their page showed the day before, for orders that were refunded in Polar; and some are shown a debt for money they were paid up to four months ago. They should be told before the date, with O14's notice. Otherwise: reach back no days for paid earnings (nothing paid is reopened, and HushOS absorbs those refunds); or leave unpaid earnings as they stand too (HushOS then pays commission on orders it knows were refunded); or a longer window, which reopens older payouts.

### The design's

Ranked by how much each changes the build. Each has a recommendation.

1. **Billing is the company's: any `billing` holder acts, the contact leaving never blocks, and companies are exempt from all four sets of family payer rules.** _Recommendation: yes._
2. **A purchase carries a quote the server checks, and an Admin without `billing` may buy only for the people they are letting in, named in the quote.** _Recommendation: yes, for "Add seats", for the raise for several people and for buying at admission._ Two small tables (quotes and purchases) and one route.
3. **A scheduled cut lowers the storage total at once, and a checkout smaller than what is stored is refused.** _Recommendation: yes to both._ Without the first, a company fills fifty seats' worth and pays for three.
4. **A plan change that is not paid adds nothing: no seat (`paid_units`), no storage (the paid product), no day (`paid_through`, stored when a cycle order is first seen paid).** _Recommendation: yes; it differs from a family only when an interval change is unpaid._ What a failed renewal keeps is not this rule's and is the owner's (O16).
5. **`groups.closed_at` as a state of its own,** not a dissolve, read-only for data admins, with removal and suspension still working, purged in one step. _Recommendation: yes; it needs the company spec changed and reviewed in the same PR._ The hand-over and the area key changes after a removal wait for the company to reopen.
6. **Team checkouts take no typed code at Polar; HushOS applies only discounts restricted to the team products.** _Recommendation: yes._ The caps are O11.
7. **The Polar products use the family shape (a base of three seats and a price per seat past three).** _Recommendation: yes._
8. **`groups.seat_cap` as a new column,** with `seat_limit` left as the seats paid for. _Recommendation: yes; it corrects the company spec in four places._
9. **A custom price is a codeless discount with no redemption limit.** _Recommendation: yes; it starts at the next renewal for a company already paying._
10. **Commission safety for every order (the stored pot, one function for what is left after refunds and disputes, disputes read daily and kept by order, the hold, clawbacks settled by amount, voiding, flags),** behind its own switch, before companies earn anyone anything. _Recommendation: yes._ How far back its cut-over reaches was the design's in the third draft and is now the owner's (O17).
11. **Removing an affiliate keeps the row and the ledger.** _Recommendation: yes; today's delete would take dispute records and settled clawbacks with it._
12. **A company is tied to one affiliate at its first paid order, sign-up before code, and the term is judged by billing cycle, pro rata for an order that runs past its end.** _Recommendation: yes._
13. **A sub's share is a share of the parent's commission; a cut and a removal by the parent both take 30 days; a sub's row and ledger are kept; an ended sub's discount earns for the parent.** _Recommendation: yes to all four._
14. **A rupee seat ceiling, not split raises, with no way past it.** _Recommendation: yes (2.4)._
15. **Monthly to yearly as a product change, for companies, reverted when unpaid, and switched on only after E19 and E20, and only if E20's revert charges and credits nothing.** _Recommendation: yes._
16. **How long a bank's confirmation may wait before an unpaid interval change is reverted: 24 hours (`INTERVAL_CONFIRM_HOURS`), and never past the end of the paid cycle.** _Recommendation: 24 hours._ It is long enough for a holder in another time zone to answer their bank and short enough that a subscription does not sit for days showing a year nobody paid for. Shorter (an hour) reverts honest switches that needed a phone call; longer (`STALE_RAISE_DAYS`, as a raise gets) leaves that year-long period standing at Polar for as long, with only `paid_through` between it and the company's service.
17. **The card hold covers any departing `billing` holder who may have added the default card, one row a person, against every charge made on a click; a card once confirmed starts no new hold; a checkout by another holder takes nothing over.** _Recommendation: yes._
18. **No trial at launch.** _Recommendation: yes; a monthly plan at three seats is the trial._
19. **An item ceiling on own storage.** _Recommendation: a fair-use line in the terms (a million items a seat), watched by operators, not enforced by the server at launch._
20. **Seats may be bought for storage alone.** _Recommendation: yes, up to the limit._
21. **No company total on a server without billing; a ceiling on the allowances its areas were given in its place.** _Recommendation: yes; the number is O15._
22. **Per-member limits are a server rule recorded in the ledger, not signed on the roster, in a column of their own (`company_area_cap_bytes`).** _Recommendation: yes; they protect a quota, not a secret._
23. **A member sees their own area's use and whether the company has room, and no figure for the company's use, in an upload's refusal as on a page.** _Recommendation: yes._
24. **The affiliate's page moves to `/app/affiliate` and shows monthly totals, never single orders, with totals of what is held, disputed and taken back.** _Recommendation: yes._
25. **A `repeating` discount that reaches a yearly charge is a stated cost, not a refused switch.** _Recommendation: yes (3.5); the bound is 20% of one yearly period._

## Sources

- Polar, updating a subscription (`discount_id`: "The change will be applied on the next billing cycle"; the units, product and cancel variants; `proration_behavior`): <https://polar.sh/docs/api-reference/subscriptions/update>
- Polar, discounts (percentage or fixed, once, several months or forever, limits by product and by redemptions, a discount without a code "can only be applied through a Checkout Link or the API", "the discount stays on through plan changes", and "Once covers the first billing cycle after it's applied"): <https://polar.sh/docs/features/discounts>
- Polar, trials (a card is collected, "Prevent trial abuse" by email or card fingerprint): <https://polar.sh/docs/features/trials>
- Polar's SDK as pinned (`@polar-sh/sdk` 1.0.2, `packages/billing/package.json`), read in its type declarations: the disputes service (`list` with `order_id` and `status`, `get`, `accept`; scopes `disputes:read`, `disputes:write`), the `Dispute` type and its statuses, the webhook event types, and the organisation's `disputes_enabled` feature flag.
- `packages/billing/src/endings.ts` and `docs/families-shared-pool.md` for what Polar does with a refund on a disputed charge, and for Stripe failing a refund up to 30 days after it succeeded.
- Everything else about Polar is from `docs/archive/polar-group-billing-spike.md`, which cites Polar's source, SDK and sandbox runs.

The three pages were opened for the first draft and their quoted claims were checked again by the reviewer in both rounds; they were not opened again for this revision. Not established from any page or run: 13.1's rows, what a real Indian card does above the e-mandate limit, where an order the bank asks to confirm goes, whether the disputes list answers for this organisation, how long Polar retries a failed renewal and what `current_period_end` reads meanwhile, and what reverting an interval change charges or credits.
