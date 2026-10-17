# Polar group billing spike

Status: research, 15 October 2026; the card-free sandbox runs of 17 October are in section 8. Sections 1 to 7 cite three sources inline:

- **[SDK]** the installed `@polar-sh/sdk` 1.0.0-alpha.20, `2026-04` namespace: `node_modules/.bun/@polar-sh+sdk@1.0.0-alpha.20/node_modules/@polar-sh/sdk/dist/models-Os3Vmw3y.d.mts` (line numbers below). The billing package moved to the `2026-10` namespace on 17 October 2026; its models file (`models-Buz84sI2.d.mts`) differs from this one in two doc strings only, so the line numbers hold for both.
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
    - A failed charge returns 402 `PaymentFailed` or `PaymentActionRequired` ([docs] `api-reference/2026-10/subscriptions/update-subscription`).
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
    1. Through the API on `2026-10`, create Family (monthly) with a fixed price plus a graduated unit price in all four currencies: `{ bound: 6, unit_amount: 0 }`, then `{ bound: null, unit_amount: 200 }`, with `minimum_units: 6`.
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

- **Unit-based pricing is six weeks old** and is used here against Polar's own "not a person" guidance. Polar may change its behaviour, or steer people-counting to seats. Mitigation: pin the SDK version and the API-version path (`2026-10` since 17 October 2026), and rerun E2 and E3 before every SDK upgrade or API-version change. The move from `2026-04` to `2026-10` is such a change, so E2 and E3 must be run, or rerun, on `2026-10` before their results are relied on. The OpenAPI specs for the two versions differ only in webhook-endpoint secrets and license-key fields, which makes a change unlikely, not ruled out.
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

## 8. Sandbox results (2026-10-17)

These are the card-free parts of section 6, then the card runs after the owner paid the checkout links ("Card runs" below). They ran against `https://sandbox-api.polar.sh` only, with `@polar-sh/sdk` 1.0.0-alpha.20 on `2026-04`. The scripts are in `packages/billing/scripts/experiments/`. `sandbox.ts` refuses to run unless `POLAR_ENVIRONMENT` is `sandbox`, and it pins the server URL. Run any of them with `bun --env-file=.env <script>`. Every created ID is in `state.json` next to them, and is listed at the end of this section.

**How the tests avoid cards.** Each subscription comes from a checkout that carries the 100%-off discount `exp-free` (code `EXPFREE`, duration `forever`, limited to the `exp-` products). The checkout is confirmed with `checkouts.clientConfirm(client_secret, { customer_billing_address: { country: 'IE' } })`, with no Stripe `confirmation_token_id`. On such a checkout:

- `is_payment_required`, `is_payment_setup_required` and `is_payment_form_required` are all false;
- the checkout reaches `succeeded` in about 2 seconds;
- the subscription is `active` with `amount: 0`.

**Every amount after checkout was 0.** These runs say nothing about charges, 402s, proration amounts or tax.

**Token scopes.** The first token lacked `orders:read`, `checkout_links:write` and `webhooks:read`. The owner replaced it the same day, and `scopes.ts` confirms the new one has all three: the five checkout links were created, and order and webhook-delivery reads work. It still lacks:

- `members:read` and `members:write`, so members cannot be listed or changed (E6 needs them);
- `events:read`, so Polar's system events, including `subscription.units_updated`, cannot be read;
- `organizations:read`.

`free-orders.ts` re-read the free subscriptions' orders with the new token; the results are folded into E2, E4 and E3 below.

**No webhook can be observed yet.** The sandbox organisation has no webhook endpoint (`listWebhookEndpoints` returns `[]`), so no deliveries exist to read. Observing the webhook order needs an endpoint, such as the relay URL, added in the dashboard, or the `webhooks:write` scope plus a receiver.

### E2. Product shape: passes

- **Accepted.** `exp-Family (monthly)` and `exp-Family (yearly)` were created with one `fixed` and one `unit_based` price in each of USD, EUR, GBP and INR. The tiers are `{bound: 6, unit_amount: 0}` then `{bound: null, unit_amount: 200}` (2000 for yearly), with `minimum_units: 6` and the member/members `unit_label`.
- **Base prices are placeholders.** They are 15 USD, 15 EUR, 12 GBP and 599 INR a month; a year is ten months.
- **Unit amounts come back as decimal strings.** Polar returns `unit_amount` as `"0"` and `"200"`, not as numbers.
- **Quotes from unconfirmed checkouts.** `amount` equals `net_amount` equals `total_amount`, and `tax_amount` is null because no address was given.

    | Product, currency | 6 units | 7 units | 5 units                         |
    | ----------------- | ------- | ------- | ------------------------------- |
    | monthly USD       | 1500    | 1700    | 422 `Minimum 6 units required.` |
    | monthly EUR       | 1500    | 1700    | 422                             |
    | monthly GBP       | 1200    | 1400    | 422                             |
    | monthly INR       | 59900   | 60100   | 422                             |
    | yearly USD        | 15000   | 17000   | 422                             |
    | yearly EUR        | 15000   | 17000   | 422                             |
    | yearly GBP        | 12000   | 14000   | 422                             |
    | yearly INR        | 599000  | 601000  | 422                             |

    The bound is inclusive: units 1 to 6 are free, and the 7th costs one tier-2 unit. The checkout's `min_units` reads `null`, but the price's `minimum_units` is still enforced.

- **Order lines use the plural label.** The `subscription_create` order lines read `exp-Family (monthly)` (the base) and `exp-Family (monthly) (8 members)` (400, two members above the free six, before the discount). At 6 units the line reads `(6 members)` at 0. The singular "member" and the rendered invoice PDF are unseen.
- **Mismatched bounds are accepted.** `exp-Family mismatch (monthly)` has bound and minimum 5 in EUR and INR, and 6 in USD and GBP. Polar created it without complaint. It also enforces each currency's own minimum:
    - a USD checkout at 5 units gets 422;
    - a EUR checkout at 5 units is accepted and quotes 1500 EUR.

    A mismatched product therefore really sells a cheaper, smaller family in some currencies.

- **The default currency is required.** An INR-only product is refused with 422 `The organization's default presentment currency must be present in the prices.`
- **Discount codes must be alphanumeric.** `exp-free` is refused with 422 `Code must contain only alphanumeric characters.`; `EXPFREE` is accepted.

**Design changes:**

1. The catalogue reader must parse `unit_amount` as a decimal string.
2. Dropping products whose currencies disagree on bound or minimum (section 5) is now confirmed as necessary, not a precaution.
3. `min_units` on `checkouts.create` is redundant with `minimum_units`. It is harmless (E1 passed it), so keep it or drop it.

### E1. Team customer: passes

- **Setup:**
    - Individual customer X, `exp-owner+mvbsgq7b2h58@thebinary.dev`, with a free `exp-Personal (monthly)` subscription.
    - Team customer `group:2a22c995-3d0e-4ed7-9d50-ba5aa19023ea`, with `email: null` and owner `{ email: X, external_id: 'exp-user-mvbsgq7b2h58' }`. Polar accepted the owner's email even though X's individual customer already uses it.
- **Checkout.** Family monthly, with the team's `customer_id`, `units: 6`, `currency: 'usd'` and `exp-free`. It completed through `clientConfirm` with no payment method.
- **Who owns the subscription.** It belongs to the team customer (`customer_id` is the team's), with `units: 6` and `currency: usd`. X's individual customer still has only its personal subscription.
- **Customer type.** `customer.type` is `team` before and after checkout, and `email` stays null.
- **Portal sessions:**

    | Call                                                                    | Result                                                                                              |
    | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
    | `customerSessions.create({ external_customer_id, external_member_id })` | Works: returns a token and a `sandbox.polar.sh` portal URL that expires after one hour. Not opened. |
    | Without a member                                                        | 422 `member_id is required for team customers.`                                                     |
    | With an `external_member_id` that is not on the team                    | 422 `Member does not exist for this customer.`                                                      |

- **Receipt recipients are not visible.** `orders.list` returned 403 because of scope. `orders.receipt` only returns a PDF URL; no endpoint reports recipients. This still needs the owner's mailbox and a real paid order.

**Design changes:**

1. A group's portal session must pass `external_member_id`. Today's `openPortal` in `packages/billing/src/server.ts` (line 511) passes only `external_customer_id: user.id`, which Polar refuses for team customers.
2. The owner member's `external_id` must be the HushOS user id, as section 5 already writes it. That is how the payer's portal is reached.
3. The Polar API keeps a member to their own team: opening a session needs a real member of that customer.

### E4 part 2. Monthly to yearly: passes

- **The switch.** A free Family monthly subscription with 8 units was moved with `subscriptions.update(id, { product_id: yearly, proration_behavior: 'prorate' })`. `prorate` was passed on purpose, to see whether Polar forces `invoice`. The call succeeded.
- **Units stay at 8**, in the response, in a re-read and in `customers.getState`.
- **A new period starts at once:**

    | Field                  | Before               | After                              |
    | ---------------------- | -------------------- | ---------------------------------- |
    | `current_period_start` | 2026-10-17T02:41:07Z | 2026-10-17T02:41:10Z (switch time) |
    | `current_period_end`   | 2026-11-17           | 2027-10-17                         |

    That fits an immediate invoice for the yearly period.

- **It invoices immediately, even though `prorate` was asked for.** At 02:41:11, one second after the switch, Polar created a `subscription_update` order, `paid`, total 0, with four proration lines:

    | Line                                                                                     | Amount |
    | ---------------------------------------------------------------------------------------- | ------ |
    | `exp-Family (yearly) — From Oct 17, 2026 to Oct 17, 2027`                                | 0      |
    | `Remaining time on exp-Family (monthly) — From Oct 17, 2026 to Nov 17, 2026`             | 0      |
    | `exp-Family (yearly) (8 members) — From Oct 17, 2026 to Oct 17, 2027`                    | 0      |
    | `Remaining time on exp-Family (monthly) (8 members) — From Oct 17, 2026 to Nov 17, 2026` | 0      |

    The amounts are 0 because of the discount. The order's own `units` is null.

- **Still untested:** part 1 (adding a member a day into a paid yearly plan) needs a card.

**Design change:** none. Expect an interval change to restart the billing period from the switch moment, not to keep the old anniversary.

### E7. Limits: Polar enforces no cap

- **Unit subscription.** Updates to `units: 1001` and then `units: 10001` with `invoice` both succeeded.
- **Unit checkout.** A quote at 1001 units was accepted at 200500 USD minor units.
- **Seat-based product** (`exp-Seat throwaway (monthly)`, one tier, `min_seats: 1`, `max_seats: null`):
    - checkout quotes at 1000 and 1001 seats were accepted;
    - a free seat subscription at 2 seats updated to 1001 with `invoice`.

    The documented 1,000-seat cap is not enforced by the API, which settles the docs-versus-source conflict in section 1.

- **Portal setting:** for the owner to check. The owner should confirm in the dashboard that "Enable subscription unit changes" is off, and that a portal session then shows no units control.

**Design change:** Polar will not stop a typo like 10001 members, which on a paid plan is an immediate, large invoice. HushOS should bound a single raise itself: refuse a jump of more than a set step at a time, and pass `max_units` on checkout. This can stay consistent with "no upper limit" in groups-design 3.5, because a deliberate large count is still possible in steps or through support.

### E3. Quantity changes, discount-only parts: matches section 1 on `pending_update`

One free Family monthly subscription, starting at 6 units:

| Step | Call                                        | `units` after | `pending_update` after                                         |
| ---- | ------------------------------------------- | ------------- | -------------------------------------------------------------- |
| 1    | `units: 7`, `invoice`                       | 7             | null                                                           |
| 2    | `units: 6`, `next_period`                   | 7             | `{ units: 6, applies_at: <current_period_end> }`               |
| 3    | `units: 8`, `invoice`                       | 8             | null: the raise deleted the pending cut                        |
| 4    | `units: 5`, `next_period`                   | 8             | 422 `BelowMinimumUnits`: the minimum also binds scheduled cuts |
| 5    | `units: 7`, `next_period`                   | 8             | `{ units: 7 }`, with a new `pending_update.id`                 |
| 6    | `units: 9`, `prorate`                       | 9             | null: a `prorate` raise also deletes the pending cut           |
| 7    | `cancel_at_period_end: true`                | 9             | null                                                           |
| 8    | `units: 10`, `invoice`, while set to cancel | 9             | 403 `AlreadyCanceledSubscription`                              |
| 9    | `cancel_at_period_end: false`               | 9             | null                                                           |

- **No orders for the raises.** With the new token, this subscription has exactly one order, its `subscription_create`. Neither `invoice` raise (steps 1 and 3) produced a `subscription_update` order. Neither did E7's raises to 1001 and 10001 units. A product change at the same zero amount does produce one (E4).

    The likely cause is that Polar skips a unit proration whose total is 0, but this is unconfirmed. Either way, free subscriptions cannot show E3's order lines; the card runs must.

- **Webhook order:** not observable; the organisation has no endpoint (see the top of this section).

**Design change:** "re-issue a pending cut after any increase" (section 5) must cover `prorate` increases too, not only `invoice`. Section 1's other predictions hold:

- the cut is pending until the period end;
- a cut below the minimum is refused;
- a plan set to cancel blocks quantity changes.

### Checkout links for the owner: created, not opened

`e6-checkout-links.ts` created five links, each locked to 6 units with discount codes off. Each link's label and metadata (`hushos_card`, `hushos_link`) name its card, and each URL pre-fills a distinct `exp-` email:

| Link key       | Product        | Card                | Link ID                                |
| -------------- | -------------- | ------------------- | -------------------------------------- |
| `monthly0341`  | Family monthly | 4000 0000 0000 0341 | `5b01f3df-663f-4d52-9305-0ef120093ab8` |
| `monthly3184`  | Family monthly | 4000 0027 6000 3184 | `090e8fc0-d77a-4ff2-b81f-b9026e6af883` |
| `monthly4242`  | Family monthly | 4242 4242 4242 4242 | `b9222dfb-70bd-4e98-bd22-728402a5433a` |
| `yearly4242`   | Family yearly  | 4242 4242 4242 4242 | `9908fe9b-1aa1-4186-9ac4-c30b7b932cf7` |
| `monthlyIndia` | Family monthly | 4000 0035 6000 0008 | `9589de8a-b3cb-4198-aebb-740c8eca87ab` |

The full URLs are in `state.json` under `links`. Three facts matter before the links are paid:

- **All five will probably check out in INR.** A link cannot fix its currency. Polar picks it from the visitor's IP country, falling back to USD, and the redirect accepts no `currency` parameter (Polar `checkout_link/endpoints.py`; `checkout/service.py` `_get_currencies`). An INR-only product is refused (E2). The owner is in India, so expect INR on every link, including the "USD" ones.

    The card behaviours under test do not depend on currency. E8's ₹15,000 threshold does: `e8-card.ts` uses it directly for INR, and needs `--threshold=<minor units>` in any other currency.

- **A link cannot carry a customer.** Each one makes or reuses an individual customer from the email typed at checkout, never a team customer. Keep the pre-filled email, because the card scripts find the subscription by link metadata first, and by that email if the metadata was not copied onto the subscription. Card runs from links test subscription and payment behaviour, not the team-customer path, which E1 covered.
- **Links are long-lived.** Each open creates a fresh checkout session; a session itself expires 24 hours after creation.

**Card scripts.** Each case runs once (state `cardRuns`) unless `--force` is passed:

| Script                       | What it does                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find-card-subscriptions.ts` | Read-only. Finds each link's subscription and prints its status, currency, units and the customer's card last 4 digits.                                                                                                                                                                                    |
| `e3-card.ts`                 | Raises the 0341 and 3184 subscriptions by one with `invoice`. It records the error body, whether `units` moved anyway, and the pending order. It runs invoice, `next_period`, then invoice on the 4242 one. It reads the webhook trail and system events where scopes allow. `--only=<key>` runs one case. |
| `e4-card.ts`                 | Adds one member to the yearly subscription, and prints the expected charge (yearly per-member price × fraction of the period left) beside the actual order.                                                                                                                                                |
| `e8-card.ts`                 | On the India subscription, raises by one member (far below ₹15,000), then raises by enough members that the proration net exceeds ₹15,000 by 10%. With the placeholder ₹2 a member, that is thousands of units; E7 shows no cap.                                                                           |
| `payments.ts <checkout>`     | Read-only. A checkout's state and its payment attempts. The attempts need `payments:read`, which the token lacks.                                                                                                                                                                                          |

### Card runs (2026-10-17, after the owner paid the links)

These ran on the `2026-04` API path, as everything above did. Main is moving to `2026-10` in PR #43; see "The 2026-10 path" below.

**What the links produced:**

| Link           | Checkout                                                              | Subscription                                                 | Card on the customer |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------- |
| `monthly0341`  | `87b163aa-7d26-470e-866d-c3c979f2c307`: still `open`, total 70682 INR | None                                                         | None                 |
| `monthly3184`  | `7f6ff8e2-…`: `succeeded`                                             | `a00b4e37-db36-45ca-8b6f-e371d073b5d6`: active, INR, 6 units | visa 3184            |
| `monthly4242`  | `9f32259d-…`: `succeeded`                                             | `90197bd1-98cd-4408-a273-15d4552a1096`: active, INR, 6 units | visa 4242            |
| `yearly4242`   | `cf70681f-…`: `succeeded`                                             | `c083ee20-aa47-4bb9-9803-4a00790b210d`: active, INR, 6 units | visa 4242            |
| `monthlyIndia` | `6fd3cd32-…`: `succeeded`                                             | `e1eb5f51-43c7-40e6-b5d7-240f0c9710d8`: active, INR, 6 units | visa 0008            |

- **All four paid checkouts are in INR**, as expected from an Indian IP. Each paid 59900 net plus 10782 GST (18%) = 70682; the yearly one paid 599000 + 107820 = 706820. GST sits on the order, and each line's `tax_amount` is 0.
- **Link metadata is copied onto the subscription** (`hushos_card`, `hushos_link`). All four were found by metadata, and every customer is `individual`.
- **The 0341 checkout declined.** It is still `open` (Polar keeps it open for a retry). Its customer `11acfb7c-13b0-457e-80a0-70dcd14613b0` was created, but has no card, no order and no subscription. The decline reason is not visible: `payments.list` needs `payments:read`, which the token lacks.

    This matches Stripe's documentation for 0341: attaching the card succeeds, and any charge fails. Polar's checkout charges the first period at once, so the first charge is the one that fails. 0341 only gets past checkout when the first charge is zero and the card is saved for later.

    **E3's 0341 case did not run and is untested.** To set it up: give the 0341 link a 100%-off `once` discount, so the first period costs nothing but the card is saved (expect `is_payment_setup_required: true`), or have the owner add 0341 as the default card in the portal of a paid subscription.

**E3 with cards:**

- **3184 charged off-session with no authentication.** A raise from 6 to 7 with `invoice` returned 200. `units` is 7, and a `subscription_update` order is `paid`: net 199, tax 36, total 235, one line `exp-Family (monthly) (6 members → 7 members) — From Oct 17, 2026 to Nov 17, 2026` (proration). There was no 402 and no pending order.

    Stripe documents 3184 as requiring authentication on every transaction. Through Polar's sandbox it did not, at least for ₹2.35. **The `PaymentActionRequired` path is still unreproduced.**

- **4242 matches section 1's predictions:**

    | Step | Call                      | `units` after | `pending_update` after                                        | New order                                                                  |
    | ---- | ------------------------- | ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
    | 1    | `units: 7`, `invoice`     | 7             | null                                                          | `subscription_update` paid, 199 + 36 = 235, line `(6 members → 7 members)` |
    | 2    | `units: 6`, `next_period` | 7             | `{ units: 6, applies_at: 2026-11-17T04:32:04Z }` (period end) | None                                                                       |
    | 3    | `units: 8`, `invoice`     | 8             | null: the raise deleted the pending cut                       | `subscription_update` paid, 199 + 36 = 235, line `(7 members → 8 members)` |
    - Each raise is its own order, taxed on its own.
    - The cut produced no credit and no order.
    - The prorated amount is truncated: 200 × 0.99994 of the period left came to 199, not 200.

- **Webhook order: not observable.** The organisation has no webhook endpoint, and `events:read` is missing.

**E4 part 1, add a member to the yearly plan:**

- The period was 3 minutes old, not a day (paid 04:32:15, raised 04:35:23), so the fraction of the period left was 0.99999, not 364/365.
- Raise 6→7 with `invoice` gave a `subscription_update` order, paid: net 1999, tax 360, total 2359. The line reads `exp-Family (yearly) (6 members → 7 members) — From Oct 17, 2026 to Oct 17, 2027`.
- Expected: 2000 × 0.999994 = 1999.99, truncated to 1999. The per-second proration and the truncation are confirmed.
- **The 364/365 point is untested.** Rerun `e4-card.ts --force` a day or more after 2026-10-17 04:32Z for a second add, and expect about `floor(2000 × fraction left)`.

**E8, Indian card 4000 0035 6000 0008:**

| Step | Raise                                                   | Result                                                                             | `units` after   | Orders                               |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------- | ------------------------------------ |
| 1    | 6→7, `invoice` (₹2.35)                                  | 200; charged off-session                                                           | 7               | `subscription_update` paid, 199 + 36 |
| 2    | 7→8258, `invoice` (net ₹16,501, about ₹19,471 with GST) | 402 `{"error":"PaymentFailed","detail":"Payment failed with reason: card_error."}` | 7 (rolled back) | No new order of any status           |

- Above ₹15,000 the sandbox **declined**; it did not return `PaymentActionRequired`.
- **The failed raise was rolled back completely:** `units` stayed 7, the status stayed `active`, and no unpaid or pending order was left behind. This is the first direct evidence for the section 1 question "does a unit change survive a 402?": it does not, at least for `PaymentFailed`.
- **What the payer must do:** nothing is pending. The portal holds no order to pay or confirm, so `hasPendingOrder` and the portal route never trigger. HushOS only has the 402. What the portal offers this payer, and whether a real Indian card would ask for authentication instead, are untested.

### The 2026-10 path

`api-2026-10.ts` uses `@polar-sh/sdk/2026-10` with the same sandbox options.

- **The E2 product** read through `2026-10` is field-for-field identical to the `2026-04` read.
- **On the free E3 subscription:**
    - a raise 9→10 with `invoice` returned `units: 10`;
    - a cut to 9 with `next_period` returned `pending_update { units: 9, applies_at: <period end> }`;
    - a cut to 5 returned the same 422 `BelowMinimumUnits` body.
- **After each change**, a `2026-04` re-read of the subscription matched the `2026-10` response exactly.

**Nothing differs.** The E3 free subscription now stands at 10 units with a pending cut to 9.

### Design consequences for groups-design 3.5

1. **Charge for a raise before admitting the member, and treat a 402 as "nothing happened".** A failed off-session raise leaves `units`, status and orders untouched (E8 step 2). HushOS admits only after a 200, and on a 402 has nothing to roll back. This was observed for `PaymentFailed`; `PaymentActionRequired` is unreproduced.
2. **A 402 is not always a portal case.** The India decline is `PaymentFailed` with no pending order, so the "send the payer to the portal to confirm" route in section 5 does not apply. The admission screen needs a plain "your bank declined this charge" outcome.
3. **INR groups with large raises.** One raise whose proration crosses ₹15,000 failed outright in the sandbox. With realistic prices, that is a company adding dozens of members at once. HushOS should say so before the attempt for INR payers. Splitting a raise to stay under the RBI limit is not proposed.
4. **Every raise is its own taxed order.** It carries 18% GST in India, and in production Polar's fixed per-order fee. On a ₹2 member, the fee would exceed the charge. This confirms section 4's fee warning for `invoice` raises at INR prices.
5. **Quote truncated amounts.** Any "you will be charged X now" figure HushOS computes must truncate per currency minor unit, to match Polar's 199 and 1999.
6. **A pending cut dies on any raise.** This is now seen on a paid subscription too: re-issue the cut after every increase (E3).

### Still untested; needs a card, wider scopes or the owner

| Item                                                         | Needs                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| E3: 0341 decline on a raise                                  | A 0341 subscription whose first charge was zero (a `once` 100% discount), or 0341 added in the portal |
| E3: `PaymentActionRequired` and where its pending order goes | A card that actually demands authentication off-session through Polar; 3184 did not                   |
| E3: webhook order                                            | A webhook endpoint on the sandbox organisation, or `events:read`                                      |
| E3: deferred `prorate` charge after cancellation             | A card and a period end                                                                               |
| E4 part 1: 364/365 of the yearly price                       | `e4-card.ts --force` a day or more after 2026-10-17 04:32Z                                            |
| E8: what the portal offers after the decline                 | The owner, in the portal                                                                              |
| E8: the 0341 decline reason                                  | `payments:read`                                                                                       |
| E6: payer handover and card ownership                        | `members:write` and two test users                                                                    |
| E2: singular "member" and the rendered invoice PDF           | An order at 1 unit, or the owner opening an invoice                                                   |
| E1: receipt recipients                                       | The owner's mailbox                                                                                   |
| E7: portal setting ("Enable subscription unit changes" off)  | The owner, in the dashboard                                                                           |

The production app token will also need `members:write` once handover is built, since section 3's steps call `customers.members.*`.

### Sandbox objects created (all `exp-`)

**Products:**

- `b216cc0b-89d5-408e-a3cd-a2a56cbafec6` exp-Family (monthly);
- `0c71028e-093d-4d41-83bb-d2cf3a111a4f` exp-Family (yearly);
- `ef18669c-3241-4b3b-ad77-4532209e5fa7` exp-Family mismatch (monthly);
- `b0b3210c-6029-4d4c-93eb-7e7034641fbe` exp-Personal (monthly);
- `3d82b99f-41e4-48b4-95dd-c2ffe007f3c0` exp-Seat throwaway (monthly).

**Discount:** `745a7270-22d7-4a7d-848e-d4ed5caab47f` exp-free (code `EXPFREE`).

**Checkout links:** the five IDs in the links table above.

**Customers:**

- E1 individual: `17ee620e-de7e-46fe-ba9c-9e4756bcc25f`;
- E1 team: `f01708e4-a4ed-4e35-b3fd-c313e89e197a` (`group:2a22c995-3d0e-4ed7-9d50-ba5aa19023ea`);
- E4: `780739e8-0ff6-4fdd-b784-f7bd7e7fd0fe`;
- E7 units: `f959699a-0f02-4b53-9c2f-2a8ffc94646b`;
- E7 seats: `21159dc9-183f-49c5-beab-79e73b688256`;
- E3: `95900563-7f27-46be-b1e5-f0497a0ad7cf`;
- card links, all individual:
    - 0341 (declined, no card): `11acfb7c-13b0-457e-80a0-70dcd14613b0`;
    - 3184: `66e00a09-1405-4eb0-841b-88da62a188cf`;
    - monthly 4242: `357f3005-3ab9-434e-9876-291eaf64579d`;
    - yearly 4242: `80413f60-c9b3-4772-a167-e40785a7d5ba`;
    - India: `07f1fb96-20b7-4b6f-a380-38ad5f22ea91`.

All five team customers have `external_id` `group:<random uuid>`, an `exp-owner+…@thebinary.dev` owner and metadata `hushos_experiment: true`.

**Free subscriptions (active):**

- E1 personal: `333e1e2e-3a1e-4aa1-9ead-ba9a5538861f`;
- E1 family: `bd47de0e-c7fc-40ff-89c8-7ea39127a31d`;
- E4: `cfc7ce1a-c84c-455f-b416-243c671dc0e0`;
- E7 units: `31766d2e-5c38-4ab8-968a-825915f9b5f8` (10001 units);
- E7 seats: `a008b991-ae17-4ba2-9c10-48541c95b825` (1001 seats);
- E3: `46f1a101-f69f-4eb3-ba8e-d3a8731685b6` (10 units, cut to 9 pending).

**Card-paid subscriptions (active, INR, renewing on test cards):**

- 3184: `a00b4e37-db36-45ca-8b6f-e371d073b5d6` (7 units);
- monthly 4242: `90197bd1-98cd-4408-a273-15d4552a1096` (8 units);
- yearly 4242: `c083ee20-aa47-4bb9-9803-4a00790b210d` (7 units);
- India: `e1eb5f51-43c7-40e6-b5d7-240f0c9710d8` (7 units).

The open 0341 checkout `87b163aa-7d26-470e-866d-c3c979f2c307` expires on 2026-10-18 at 04:31Z.

**Checkouts.** The confirmed ones are:

- `1b726e85-3af4-46c7-8ec3-22dedc80a543`;
- `d9c67b2c-7d5d-4c30-8746-883d85266cfe`;
- `41075113-8574-4e74-af80-b9dde50906ab`;
- `69ef92db-41e8-44a4-a50a-32cbfccebe1a`;
- `23f6a202-7685-4bbe-b786-f087a83caa04`;
- `60947a43-5456-4f38-93ce-edf45a786f3a`.

The open quote-only checkouts expire 24 hours after creation:

- the 16 checkouts listed in `state.json` under `e2Checkouts`;
- `999e6d09-94cb-45d5-a5bf-9a918a7e9f60` (mismatch, EUR);
- `1976de3b-add0-4145-964f-0425e10fed2c` (1001 units);
- `41e64ca3-66d4-49b0-94cd-fc3e3c9cbc0c` (1001 seats);
- `60d419d0-e9c3-4e39-ba1a-d0f52a10ff01` (1000 seats).

**Cleanup:**

1. Revoke the ten subscriptions (six free, four card-paid).
2. Delete the eleven customers with `anonymize: true`.
3. Delete the five checkout links.
4. Archive the five products.
5. Delete the discount.
