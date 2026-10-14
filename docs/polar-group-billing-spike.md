# Polar group billing spike

Status: research, 15 October 2026. Nothing was called against Polar. Evidence comes from three places, cited inline:

- **[SDK]** the installed `@polar-sh/sdk` 1.0.0-alpha.20, `2026-04` namespace: `node_modules/.bun/@polar-sh+sdk@1.0.0-alpha.20/node_modules/@polar-sh/sdk/dist/models-Os3Vmw3y.d.mts` (line numbers below). The `2026-10` models file differs from it in two doc strings only.
- **[src]** Polar's public server source at commit `a4bae2b` (14 October 2026): `https://github.com/polarsource/polar/blob/a4bae2b742befdb6dcc696a841f259aed24f2086/server/polar/<path>`. Source shows intent, not what the sandbox does; anything load-bearing is repeated as an experiment in section 6.
- **[docs]** `https://polar.sh/docs/...` pages, named where cited.

## Verdict

1. **Bill extra members as a quantity on the group's single subscription, using a unit-based price next to a fixed base price.** Do not use a second product, and do not use Polar's seat-based pricing. Each currency gets one `fixed` price for the base and one `unit_based` price with graduated tiers: rate 0 up to the included N, then the per-member rate. `minimum_units` carries a company's minimum. Seat-based pricing works mechanically, but it brings Polar's member and seat-claim system with it. That system emails the people it holds seats for, and it would hold a record of every family member, which HushOS should not hand to its payment processor. A second product would need a hosted checkout for every added member.
2. **The prorated refund is not automatic, so HushOS must compute it.** Revoking a subscription issues no refund and no credit. A downgrade or quantity cut credits a per-currency wallet that the public API cannot pay out. HushOS revokes the subscription, computes the remaining value itself, and calls `refunds.create` once per order. Polar gives refunds no idempotency key, so HushOS needs its own ledger.
3. **The payer is a Polar team customer that HushOS creates through the API before checkout:**
    - `external_id: "group:<groupId>"`, with no customer email;
    - the paying person is the `owner` member.

    Billing passes to someone else through an ownership transfer. **The card does not pass with it:** the new payer has to add one in the portal, and until they do, renewals keep charging the departing payer's card.

4. **Three questions cannot be settled from types and source**, so they need sandbox runs (section 6):
    - whether a team customer without an email can complete a fixed-plus-unit checkout;
    - whether a quantity increase that fails payment (402) is rolled back;
    - how the refund's net amount should be derived on tax-inclusive orders.

**Weaknesses the current code and design already have:**

- `docs/groups-design.md` §3.5 says "seats", which in Polar means a separate system the group design does not want.
- Everything in `@hushos/billing` assumes the customer is a person:
    - `USER_ID_PATTERN` in `externalIdOf` and `reconcileCustomer` (`packages/billing/src/server.ts`);
    - `billing_customers.user_id` as the primary key (`packages/db/src/schema/billing.ts`);
    - `revokeForDeletion`.
- `readProduct` would list group products in the personal catalogue, because they carry `hushos_plan` and fixed prices.
- `seed.ts --update` reads only fixed prices (`livePrices`), so it would archive a unit price by leaving it out.

## Decisions (agreed 2026-10-15)

1. **Extra members are a quantity on the group's one subscription**: a fixed base and a unit-based price per currency (option B). No seat-based pricing, no per-member product.
2. **Switching from one's own plan to the pool happens at renewal, with no refunds**: the plan stops renewing and the personal space joins the pool when the paid period ends. Switching at once is allowed and forfeits the rest of the period, said plainly. Section 2's refund procedure is therefore not built; it stays here in case refunds are wanted later.
3. **The customer is a Polar team customer per group** (`group:<groupId>`), the payer its owner.
4. **Billing handover completes only once the new payer has added a card**; until then the old payer stays the payer, and is told so.
5. **A payer's account cannot be deleted** until they hand billing over or cancel the group plan.
6. **A Business pool grows with each paid member** (`quota_bytes_per_member`); a Family pool is fixed per plan.

Experiments E5 (refund maths) and the refund half of E4 are no longer needed; the others still confirm Polar's behaviour before groups-design 3.5 is built.

## 1. Per-member billing

### Three options

|                 | A. Seat-based price                                                                                                                                                                                                                    | B. Unit-based price (recommended)                                                                                                                                    | C. Second per-member product                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shape           | One `fixed` price plus one `seat_based` price per currency, billed `fixed + seat_charge` ([SDK] 17314; [src] `product/service.py` 771–843; added June 2026, polarsource/polar#12206)                                                   | One `fixed` price plus one `unit_based` price per currency ([src] `product/service.py` 771–843; [docs] `features/unit-based-pricing`, "Combining with other prices") | A separate recurring product per extra member                                                                                                                                                                                                                                                                                                                                                                                  |
| Included N free | Graduated `seat_tiers`; `price_per_seat` may be 0 ([src] `product/schemas.py` 139–146)                                                                                                                                                 | Graduated `tiers`; `unit_amount` ≥ 0 ([src] `product/tiers.py` 37–45)                                                                                                | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Minimum         | First tier's `min_seats`, enforced by `BelowMinimumSeats` ([src] `subscription/service.py` 1990–1992)                                                                                                                                  | `minimum_units`, enforced by `BelowMinimumUnits` ([src] 1962–1974)                                                                                                   | Not enforceable                                                                                                                                                                                                                                                                                                                                                                                                                |
| Maximum         | Last tier's `max_seats` or unlimited. [docs] `features/seat-based-pricing` also states "Maximum of 1,000 seats per subscription", which no source check enforces. This conflicts with "no upper limit" (E7).                           | Last tier's bound or unlimited; no documented cap                                                                                                                    | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Floor on cuts   | Cannot go below _assigned_ Polar seats (`SeatsAlreadyAssigned`, [src] 1998–2002)                                                                                                                                                       | None; HushOS enforces it                                                                                                                                             | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Side effects    | The first seat purchase turns the customer into `team` for good. The buyer's seat is auto-claimed at checkout. The portal lets billing managers assign seats, which sends Polar invitation emails, and Polar then holds member emails. | None; `unit_label` shows "member/members" on invoices ([SDK] 18394)                                                                                                  | Paid subscriptions can only be created through checkout. `subscriptions.create` accepts only free products ([SDK] `SubscriptionCreateExternalCustomer`; [src] `subscription/schemas.py` 304). Every added member means card entry. Each subscription has its own period, and the org-wide `allow_multiple_subscriptions` would be needed, which also lets people stack personal plans ([src] `checkout/service.py` 2740–2779). |
| Switching back  | Seat to non-seat product refused ([src] `subscription/service.py` 1891–1902)                                                                                                                                                           | Unit to non-unit refused; unit to unit keeps the count ([src] 3492–3530)                                                                                             | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Maturity        | Feature flag removed 9 September 2026 (#14256)                                                                                                                                                                                         | Released 1 September 2026 (#14064). [docs] advise unit-based for "any quantity that isn't a person"; this is guidance, not a rule.                                   | Not applicable                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Option C is out:**

- Adding a member would need its own checkout.
- The member's renewals would not line up with the group plan's.
- It would need an org-wide setting HushOS does not want.

**A and B share Polar's proration engine** (`subscription/update.py`, `_collect_proratable_amounts` covers fixed, seat and unit prices). They differ only in what Polar knows about people. HushOS already owns membership, admission and the roster, so B gives Polar the count and nothing more.

### Behaviour common to A and B

- **Adding mid-cycle.**
    - `subscriptions.update(id, { units, proration_behavior: 'invoice' })` creates a `subscription_update` order and charges it off-session at once, in `PaymentMode.sync` ([src] `subscription/service.py` 4644–4661, 2559–2669).
    - A failed charge returns 402 `PaymentFailed` or `PaymentActionRequired` ([docs] `api-reference/2026-04/subscriptions/update-subscription`).
    - Whether the unit change survives that 402 is not visible; E3 checks it.
    - `'prorate'` defers the charge to the next renewal: no immediate payment, no 402, and no separate transaction fee. The catch is credit risk. A plan cancelled at period end never renews, so the deferred charge is likely never collected (E3).
- **Removing mid-cycle.**
    - `invoice` or `prorate` produces a negative order. Its value goes to the customer's billing wallet in that currency and is applied to later invoices ([src] `order/service.py` 1549–1572). It is never paid back to the card.
    - The wallet API is private: `tags=[..., APITag.private]` ([src] `wallet/endpoints.py` 25), and the SDK has no org-level wallet service.
    - `next_period` sets `pending_update.units` and applies it at renewal, with no credit ([SDK] 17075).
    - **A later immediate increase deletes a pending unit cut** ([src] `subscription/service.py` 2623–2642), so HushOS must re-issue the cut afterwards.
- **A plan set to cancel blocks quantity changes**: `cancel_at_period_end` returns 403 `AlreadyCanceledSubscription` ([src] 1930–1931). Admission into a group whose plan is set to cancel needs the plan resumed first, as `startCheckout` already does for personal plans.
- **Monthly versus yearly:**
    - The interval is fixed when a product is created ([docs] `features/products`), so each group kind needs a monthly and a yearly product.
    - Proration is per second over the real period length ([src] `subscription/update.py` `_calculate_time_proration`). One member added in month 1 of a yearly plan charges about 11/12 of the yearly per-member price at once.
    - Changing interval forces `prorate` to `invoice` ([docs] `features/subscriptions/proration`). Units carry over from one unit product to another.
- **Currencies:**
    - Polar checks that every currency has the same _structure_ (fixed, seat, unit, custom, meter count) ([src] `product/service.py` 884–895), and that the default USD price exists (896–907).
    - It does **not** compare tier bounds or minimums across currencies, so HushOS's catalogue reader must.
    - A subscription keeps its checkout currency, and product changes must stay in it ([docs] `features/subscriptions/manage`).
- **Webhooks:**
    - There is no webhook specific to quantity changes ([SDK] 339 `WebhookEventType`).
    - A change sends `subscription.updated` ([src] `subscription/service.py` 3717–3740), plus `order.created` and `order.paid` for the proration order, and `customer.state_changed`.
    - `old_units`, `new_units` and `proration_behavior` exist only on the Events API's `subscription.units_updated` system event ([SDK] `SubscriptionUnitsUpdatedMetadata`).
    - `CustomerStateSubscription` carries `units` and `seats` ([SDK] 9838). The current handler, which reconciles from customer state on any event, therefore fits, once it accepts group ids.
- **No preview.** The charge, change and cancel previews are private endpoints ([src] `subscription/endpoints.py` 255–337), so HushOS has to compute any "you will be charged X now" figure itself.

## 2. The prorated refund on switching to the pool

### What Polar offers

- **Revoke** (`subscriptions.revoke` or `update({ revoke: true })`) ends the subscription now with no refund and no credit ([src] `subscription/service.py` 3030–3080; [docs] `features/subscriptions/manage`: "There's no refund").
- **Cancel at period end** runs to the end of the period, also with no refund.
- **`refunds.create({ order_id, amount, reason, comment, metadata })`** ([SDK] 18564):
    - Works on one order at a time. `amount` is net of tax, in minor units.
    - Polar adds the matching tax proportionally ([src] `models/order.py` 454–466).
    - The ceiling is `refundable_amount = net_amount + applied_balance_amount − refunded_amount` ([src] `models/order.py` 358–361; [SDK] 15312).
    - `revoke_benefits` is refused on subscription orders.
    - There is **no idempotency key**.
- **Refund errors** ([src] `refund/service.py` 222–246):

    | Error                                                                 | Status |
    | --------------------------------------------------------------------- | ------ |
    | `RefundedAlready`                                                     | 403    |
    | `RefundDisputedPayment`                                               | 403    |
    | `RefundsBlocked`                                                      | 403    |
    | Over the refundable amount                                            | 422    |
    | Order paid entirely from the wallet, so there is no payment to refund | 404    |

- **Credits:** the wallet is private and belongs to one customer. Credit cannot move from a member's personal customer to the group customer.

**Conclusion:** HushOS computes the amount, revokes, and issues the refunds. None of it is automatic.

### Procedure

1. **Record a switch row** (switch id, subscription id, state) before any call.
2. **Revoke.** Take `T = ended_at` from the response, then switch the storage source in the same HushOS transaction that records the revoke. Revoking first is deliberate:
    - a refund that fails after a revoke leaves money owed, which can be retried;
    - a revoke that fails after a refund leaves the person on two storage sources.
3. **Compute** `R = floor(A_net × (period_end − T) / (period_end − period_start)) + W`.
    - `A_net` is one full period at the current price, net of tax and discount.
        - If the current period has no `subscription_update` order, `A_net` is the period's `subscription_cycle` or `subscription_create` order's `net_amount`.
        - Otherwise it is `subscription.amount` (after discount), with tax backed out when the latest order was tax-inclusive. E5 confirms this derivation.
    - `W` is the member's wallet credit in that currency. The org API cannot read it. A customer-portal session (`customerPortal.wallets.list`) might (E5). If it cannot, the credit is forfeited, and the switch screen must say so.
4. **Allocate `R`** across the current period's paid orders, newest first. Cap each order at its `refundable_amount`. If anything is left over, alert an operator.
5. **Refund each share** with `refunds.create({ order_id, amount, reason: 'other', metadata: { hushos_switch: <id> } })`.
    - Before any retry, call `refunds.list({ order_id })` and skip orders that already carry that metadata. Without this, a timeout followed by a retry refunds twice.
    - Treat `RefundedAlready` as done.
6. **Watch the outcome.** A `refund.updated` with `status: failed` goes to an operator.

The calculator moves money, so `AGENTS.md` requires a Vitest suite beside it. It should cover:

- `T` at the period's start and end;
- yearly periods;
- INR rounding;
- the per-order caps;
- an order that is already partly or fully refunded;
- a wallet credit.

### Edge cases

- **Yearly plans.** Refunds are large and can fall on charges up to 12 months old. A closed or replaced card can fail the refund at the card network, which arrives as `refund.updated` with `failed`. The sandbox cannot simulate an old charge, so this stays a risk.
- **INR.** Today's production subscriptions are INR.
    - Amounts are in paise; round down so a refund never overpays.
    - India is tax-exclusive, so GST comes back proportionally without extra work.
    - Polar's transaction fee on the original charge is not returned ([docs] `merchant-of-record/fees`: "the initial transaction fees are not refunded"). On a ₹199 order, the fixed part of that fee is a large share.
    - Polar's draft multi-currency design says refunds go out in the presentment currency, and the merchant bears any exchange-rate loss (`handbook.polar.sh/engineering/design-documents/multi-currency`, draft dated 8 January 2026). This is unconfirmed.
- **An order already refunded.**
    - Polar may refund within 60 days on its own to head off a chargeback. That also cancels the subscription ([docs] `features/refunds`).
    - Expect `RefundedAlready`, or a lower `refundable_amount`, and an already-revoked subscription; skip the revoke in that case.
    - Partly refunded orders are capped by `refundable_amount`.
- **Past due.** The unpaid period earns no refund, and the revoke voids the pending orders ([src] `subscription/service.py` 4003).
- **Cancel at period end versus immediately.**
    - A subscription already set to cancel can still be revoked ([src] `models/subscription.py` 528–543), and the remaining time is still refunded.
    - "Switch at renewal" (cancel at period end, no refund, pool from `ends_at`) would avoid the fee loss and the refund machinery. §3.5 chose the refund, so this is noted only as a cheaper alternative for monthly plans.
- **Disputed orders** return 403 and go to an operator.
- **Affiliate commission.** `recordAffiliateEarning` books commission on `order.paid`, and nothing reverses it on `order.refunded`. A switch refund therefore leaves commission paid on refunded money (`packages/billing/src/server.ts`).

## 3. The payer as a customer

- **What Polar supports.** `CustomerTeamCreate` ([SDK] 10505) takes:
    - `type: 'team'`;
    - `external_id`, which is unique per organisation and **cannot be changed once set**;
    - an optional `email`;
    - `owner { email, name, external_id }`;
    - `billing_address`, `tax_id` and `metadata`.

    A customer's type can only change from individual to team ([SDK] 10560). A group customer keyed `group:<groupId>` fits this model.

- **Why not an individual customer.** An individual customer's email is required and unique per organisation. The payer's personal customer usually holds it already.
- **Why create the customer before checkout.** A checkout with no linked customer is matched to an existing customer by its email and attached there ([src] `checkout/service.py` 2996–3020). The group subscription would land on the payer's _personal_ customer. Pass the team customer's `customer_id` (or its `external_customer_id`, [src] 579–583).
- **The billing contact is the `owner` member.** The roles are `owner`, `billing_manager` and `member` ([SDK] 151). Portal sessions are opened per member: `customerSessions.create({ external_customer_id, external_member_id })` ([SDK] 9634).
- **When billing passes to another member:**
    1. `customers.members.createExternal('group:<id>', { email, name, external_id: newUserId, role: 'billing_manager' })`.
    2. `customers.members.updateExternal('group:<id>', newUserId, { role: 'owner' })`. Through the admin API this transfers ownership and demotes the old owner to `billing_manager` ([src] `member/service.py` 830–880; `member/endpoints.py` 367).
    3. The new payer opens the portal, adds a card, and sets it as default. Polar then moves the customer's subscriptions to that card and retries any past-due orders ([src] `customer_portal/service/customer.py` 230–236).
    4. `customers.members.deleteExternal('group:<id>', oldUserId)`.
    5. `customers.updateExternal` for the billing name, address and tax ID.
- **Weaknesses of that handover:**
    - **The card stays with the customer.** The org API can list cards (`listPaymentMethodsExternal`) but cannot add or remove them. Until step 3 is done, renewals charge the departing payer's card. HushOS must treat the handover as unfinished until `default_payment_method_id` names a card created after the handover began.
    - **The old card cannot be removed early.** It cannot be deleted while it is the only card backing a subscription ([src] `payment_method/service.py` 56–63). Afterwards, only a portal user can delete it. If nobody does, it stays stored on the group's customer.
    - **Past invoices go with the customer.** The new owner sees the old payer's past invoices, billing name and address in the portal (E6).
    - **Tax and currency diverge.** Tax on later orders follows the new address, but the currency stays the subscription's. A payer in India taking over a USD plan pays in USD.
    - **Deleting the payer's account leaves the group charging their card.** `revokeForDeletion` touches only the person's own customer. HushOS must refuse to delete the account of a group's payer until billing has been handed over or the group plan is cancelled.
- **Dissolving a group:** `subscriptions.revoke`, then `customers.deleteExternal('group:<id>', { anonymize: true })`.

## 4. Taxes and merchant-of-record constraints

- **Tax is added on top in some countries and included elsewhere.**
    - Polar taxes each order by the customer's billing address.
    - By default it is exclusive in the US, Canada and India and inclusive elsewhere ([docs] `features/tax-inclusive-pricing`).
    - USD and INR per-member prices are therefore before tax. EUR and GBP prices include VAT, so HushOS's net per member varies by country.
    - The "add a member" figure must say "plus tax" for US, Canada and India payers.
- **Taxes on proration and refunds.** Each proration order is taxed when it is made. Refunds return tax in proportion; HushOS sends only the net ([src] `models/order.py` 454–466).
- **Companies.** A team customer carries `tax_id` and `billing_name`. EU business buyers get reverse charge ([docs] `merchant-of-record/introduction`). Polar refuses invoices without billing details (`MissingInvoiceBillingDetails`, [SDK]).
- **Fees.** Every immediate member addition is its own order, so it pays its own fixed per-transaction fee, plus 1.5% on non-US cards ([docs] `merchant-of-record/fees`). Fees are not returned on refunds, and a dispute costs $15. On small INR plans, adding members one at a time with `invoice` is fee-heavy. `prorate` avoids the fee but takes the credit risk described in section 1.
- **India.** RBI e-mandate rules require the cardholder to authenticate off-session charges above a threshold (₹15,000 for most categories). Polar reports this as 402 `PaymentActionRequired`. The existing `hasPendingOrder` and portal route already covers plan switches, and it must cover quantity increases too (E8).
- **Polar can act on its own.** It may refund and cancel a subscription itself to prevent a chargeback ([docs] `features/refunds`). HushOS must reconcile from Polar's state rather than assume its own last write.

## 5. Recommended design

**Products.** Four products: Family (monthly), Family (yearly), Business (monthly) and Business (yearly), seeded by `seed.ts`.

- `recurring_interval`: `month` or `year`.
- Per currency (`usd`, `eur`, `gbp`, `inr`):

```ts
prices: [
    { amount_type: 'fixed', price_currency, price_amount: base },
    {
        amount_type: 'unit_based',
        price_currency,
        tiers: {
            type: 'graduated',
            tiers: [
                { bound: included, unit_amount: 0 },
                { bound: null, unit_amount: perMember },
            ],
        },
        minimum_units: Math.max(included, minimum),
        unit_label: { en: { '=1': 'member', other: 'members' } },
    },
];
```

- **Metadata:**
    - `hushos_plan` (`family` or `business`);
    - `hushos_group_kind` (`family` or `org`);
    - `quota_bytes` (the pool);
    - `included_members`.
- **The minimum comes from the price, never from metadata.** The catalogue reader must:
    - drop any group product whose currencies disagree on the free-tier bound or `minimum_units`, or whose bound differs from `included_members`;
    - keep every product carrying `hushos_group_kind` out of the personal catalogue;
    - make `seed.ts --update` keep unit prices, which `livePrices` currently drops.
- **Open product question:** does a Business pool grow with each member? If it does, add `quota_bytes_per_member`.

**Customer.** One team customer per group, created when the payer starts checkout:

```ts
customers.create({
    type: 'team',
    external_id: `group:${groupId}`,
    name,
    owner: { email, name, external_id: userId },
    metadata: { hushos_owner_kind: 'group', hushos_group_id: groupId },
});
```

**Checkout:**

```ts
checkouts.create({
    products: [id],
    customer_id,
    currency,
    units: chosen,
    min_units: minimum,
    customer_ip_address,
    success_url,
    return_url,
    allow_trial: false,
    metadata: { hushos_group_id },
});
```

**Seat count.** `units` is the purchased member capacity.

- **Admitting.** Admission returns 402 `seats` when admitted members equal `units`, as §4 of the groups design specifies.
- **Raising.** Only the payer raises the count, with `subscriptions.update(id, { units, proration_behavior: 'invoice' })`. On a 402, send the payer to the portal for confirmation.
- **Lowering.**
    - Lower with `{ units, proration_behavior: 'next_period' }`, so no wallet credit is stranded.
    - HushOS refuses any count below the number of admitted members.
    - Polar cannot enforce that floor, because it does not know the members.
    - If Polar's `units` ever drops below admitted members (changed in the dashboard or by support), block admissions and alert an operator. Never remove anyone.
    - Re-issue a pending cut after any increase.
- **Portal setting.** Keep "Enable subscription unit changes" off (it is off by default), so every change goes through HushOS's floor check.

**Webhooks.** Subscribe to:

- `subscription.created`, `.updated`, `.active`, `.canceled`, `.uncanceled`, `.revoked`, `.past_due`;
- `order.paid` and `order.refunded`;
- `refund.created` and `refund.updated`;
- `customer.state_changed`.

Route on the external id: a UUID goes to `reconcileCustomer(userId)`; `group:<uuid>` goes to a new `reconcileGroup`. That function reads `customers.getStateExternal('group:<uuid>')` and writes `units`, status, period end and pool size to the group's billing rows. Check that the Polar webhook endpoint already includes the `refund.*` events.

**Switching to the pool and handing over billing** follow sections 2 and 3.

**Code changes:**

- Key `billing_customers` and `billing_subscriptions` by owner kind and owner id.
- Extend `externalIdOf`.
- Block deleting the account of a group's payer.
- Reverse affiliate commission on `order.refunded`.

## 6. Experiments for the owner to run (sandbox only)

Use Stripe test cards ([Stripe testing docs](https://docs.stripe.com/testing)):

| Card                | Behaviour                             |
| ------------------- | ------------------------------------- |
| 4242 4242 4242 4242 | Succeeds                              |
| 4000 0000 0000 0341 | Attaches, then declines later charges |
| 4000 0027 6000 3184 | Always requires authentication        |
| 4000 0035 6000 0008 | Indian card                           |

**E1. Team customer and checkout.**

- **Setup:**
    1. Create a user who already has a personal subscription (an individual customer with email X).
    2. Create a team customer `group:<uuid>` with no email and owner email X.
    3. Run a checkout on a Family product, using `customer_id` and `units: 6`.
- **Pass if:**
    - the checkout completes;
    - the subscription belongs to the team customer, not to X's individual customer;
    - `customer.type` stays `team`.
- **Also record:**
    - who receives the receipt email;
    - whether `customerSessions.create` with `external_member_id` opens the portal.

**E2. Product shape.**

- **Setup:**
    1. Through the API on `2026-04`, create Family (monthly) with a fixed price plus a graduated unit price in all four currencies: `{ bound: 6, unit_amount: 0 }`, then `{ bound: null, unit_amount: 200 }`, with `minimum_units: 6`.
    2. Retry with mismatched bounds across currencies.
- **Pass if:**
    - the product is accepted;
    - checkouts at 6 and 7 units cost the base and the base plus one member;
    - invoices show "member/members".
- **Also record:** whether the mismatched bounds are accepted. HushOS expects Polar to accept them, so the catalogue reader must catch them.

**E3. Changing the quantity.**

- **Setup:** use an active Family (monthly) subscription on the 0341 card.
- **Steps:**
    1. Raise units 6→7 with `invoice`.
    2. Re-read the subscription.
    3. Repeat with the 3184 card.
    4. On a 4242 subscription, raise with `invoice`; cut with `next_period`; then raise again.
    5. On a `prorate` raise, set `cancel_at_period_end` and let the period end with a test clock or a shortened period.
- **Pass if:**
    - with 0341 the response is 402, and the record shows whether `units` changed. A change that survives without payment is a fail for the `invoice` design;
    - with 3184 the response is `PaymentActionRequired`, and the record shows where the pending order goes;
    - with 4242, after step 4, the order lines and `pending_update.units` match what section 1 predicts (the raise deletes the pending cut);
    - the webhooks arrive in this order: `subscription.updated`, `order.created`, `order.paid`, `customer.state_changed`.
- **Also record:** whether the deferred `prorate` charge is ever billed after the cancellation.

**E4. Yearly plans and interval changes.**

- **Steps:**
    1. Add a member one day into a Family (yearly) subscription, and record the charge.
    2. Switch a monthly plan with 8 units to yearly.
- **Pass if:**
    - the charge is about 364/365 of the yearly per-member price;
    - the switch keeps `units: 8` and invoices immediately.

**E5. The refund.**

- **Setup:**
    1. Create a personal Plus (yearly) subscription in INR, and a second one in EUR from a German address (tax-inclusive).
    2. Upgrade each to Pro with `invoice`.
    3. Downgrade one back with `invoice`, which creates wallet credit.
    4. Revoke each.
    5. Run the section 2 calculation, and issue the refunds with `hushos_switch` metadata.
- **Pass if:**
    - the per-order `tax_amount` is proportional;
    - `refundable_amount` drops as expected;
    - `order.refunded`, `refund.created` and `refund.updated` all arrive;
    - an over-refund returns 422;
    - refunding a fully refunded order returns 403;
    - the `A_net` derivation matches Polar's own figures on the tax-inclusive order.
- **Also record:**
    - whether sending the same refund call twice creates two refunds (HushOS expects it to);
    - whether a customer-portal session can read the wallet balance.

**E6. Payer handover.**

- **Steps:** run the five steps in section 3 with two test users.
- **Record:**
    - whether the old owner becomes `billing_manager`;
    - what the new owner sees of past invoices;
    - that the old card cannot be deleted before the new one is the default, and can be deleted after;
    - which card the next raise charges.

**E7. Limits and portal.**

- Set `units: 1001` on the unit product, and `seats: 1001` on a throwaway seat-based product.
- Confirm that with the portal setting off, the portal offers no control to change units.

**E8. India.**

- **Steps:**
    1. Check out an INR Family plan with the Indian test card.
    2. Raise the units with `invoice`, once below and once above ₹15,000 for the proration order.
- **Record:** whether Polar charges off-session or returns `PaymentActionRequired`, and what the payer must do in the portal.

## 7. Open risks

- **Unit-based pricing is six weeks old** and is used here against Polar's own "not a person" guidance. Polar may change its behaviour, or steer people-counting to seats. Mitigation: pin the SDK version and the `2026-04` path, and rerun E2 and E3 before every SDK upgrade.
- **Polar's docs disagree with its source.**
    - `features/products` says "Each product has a single pricing model", while the source composes fixed with seat or unit prices.
    - The 1,000-seat cap appears in the docs but not in the code.
    - Treat the sandbox (E2, E7) as the tiebreaker.
- **No idempotency on refunds or quantity changes.** Every money-moving call needs a HushOS-side ledger row written before the call and checked before any retry.
- **Wallet credit is invisible and cannot be refunded** through the org API. Unless E5 shows a portal session can read it, a member who downgraded earlier in the period loses that credit when switching.
- **Billing handover has a card gap.** Until the new payer adds a card, the departing payer is still charged, and their card stays stored on the group's customer.
- **Fees on INR plans.** Immediate per-member charges each pay a fixed fee, and refunds return none of the original fee.
- **A quantity below the admitted count can be set outside HushOS** (in the dashboard or by support). HushOS would then serve more members than it bills. Reconciliation must flag it.
- **Refunds on old charges** (yearly plans) can fail at the card network. That needs an operator path, which the sandbox cannot exercise.
- **Refunds leave affiliate commission in place** until `order.refunded` reverses it.
