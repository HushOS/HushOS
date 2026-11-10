import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as billing from '@hushos/billing/server';
import * as growth from '@hushos/billing/growth';
import { chargeableCurrency } from '@/lib/currency';
import {
    affiliateEmail,
    cancellationSchema,
    guards,
    requestAddress,
    requestCountry,
    uuidSchema,
} from '@/lib/api/shared.server';
import {
    affiliateDeletedResponse,
    affiliateDoneResponse,
    affiliateEarningsResponse,
    affiliateLedgerStatusResponse,
    affiliatePaidResponse,
    affiliateResponse,
    affiliatesResponse,
    catalogueResponse,
    checkoutResponse,
    couponResponse,
    forgottenResponse,
    groupBillingChangedResponse,
    groupBillingResponse,
    groupPlanResponse,
    groupUnitsResponse,
    handleResponse,
    referralsResponse,
    summaryResponse,
    urlResponse,
} from '@/lib/api/billing-responses.server';

/* An amount in a currency's smallest unit, as a decimal string: a number would round a large one. */
const minorUnits = t.String({ pattern: '^(0|[1-9][0-9]{0,17})$' });
const earningParams = t.Object({ id: uuidSchema, earning: uuidSchema });

/* Plans, checkout, families' billing, referrals and affiliates (/api/billing). */
export const billingApi = new Elysia()
    .use(guards)
    .get('/billing/catalogue', { response: { 200: catalogueResponse } }, ({ set }) => {
        set.headers['Cache-Control'] = 'public, max-age=60';
        return billing.listCatalogue();
    })
    .guard({ mutation: true, session: 'billing' }, (app) =>
        app
            .get('/billing', { response: { 200: summaryResponse } }, async ({ user }) =>
                billing.getSummary(user),
            )
            .post(
                '/billing/checkout',
                {
                    body: t.Object({
                        productId: t.String({ minLength: 1, maxLength: 100 }),
                        currency: t.Optional(t.String({ pattern: '^[a-z]{3}$' })),
                    }),
                    response: { 200: checkoutResponse },
                },
                async ({ user, request, body }) =>
                    billing.startCheckout(
                        user,
                        body.productId,
                        requestAddress(request),
                        // The page's currency is a display choice; Polar is told it only when
                        // the visitor's country pays in it, else Polar decides from the address.
                        chargeableCurrency(body.currency, requestCountry(request)) ?? undefined,
                    ),
            )
            // Referrals and affiliates: a person's own invite, and the operator's creators.
            .get(
                '/billing/referrals',
                { response: { 200: referralsResponse } },
                async ({ user, set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return growth.getReferralSummary(user.id);
                },
            )
            .post(
                '/billing/coupon',
                {
                    body: t.Object({ code: t.String({ minLength: 3, maxLength: 32 }) }),
                    response: { 200: couponResponse },
                },
                async ({ user, body }) => {
                    return growth.rememberCoupon(user.id, body.code);
                },
            )
            .post(
                '/billing/portal',
                { body: t.Object({}), response: { 200: urlResponse } },
                async ({ user }) => billing.createPortalSession(user),
            )
            .post(
                '/billing/sync',
                { body: t.Object({}), response: { 200: summaryResponse } },
                async ({ user }) => billing.sync(user),
            )
            .post(
                '/billing/cancel',
                { body: cancellationSchema, response: { 200: summaryResponse } },
                async ({ user, body }) => billing.cancelAtPeriodEnd(user, body),
            )
            .post(
                '/billing/resume',
                { body: t.Object({}), response: { 200: summaryResponse } },
                async ({ user }) => billing.resume(user),
            )
            // The family tier chosen at signup, once the app has opened Create a family with it.
            .post(
                '/billing/intended-family/forget',
                { body: t.Object({}), response: { 200: forgottenResponse } },
                async ({ user }) => {
                    await billing.forgetIntendedFamily(user);
                    return { success: true as const };
                },
            )
            // A family's plan (docs/groups-design.md 3.5): only with GROUPS_ENABLED and billing on,
            // which the billing functions check; managers see it, the payer changes it.
            .get(
                '/billing/groups/:id',
                { params: t.Object({ id: uuidSchema }), response: { 200: groupBillingResponse } },
                async ({ user, params, set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return billing.getGroupBilling(user, params.id);
                },
            )
            .post(
                '/billing/groups/:id/checkout',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        productId: t.String({ minLength: 1, maxLength: 100 }),
                        currency: t.Optional(t.String({ pattern: '^[a-z]{3}$' })),
                        units: t.Optional(t.Integer({ minimum: 1, maximum: 10_000 })),
                        // Confirmed: these lapsed plans of the family end now (refusal code `ends-lapsed`).
                        endLapsed: t.Optional(
                            t.Array(t.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
                        ),
                    }),
                    response: { 200: urlResponse },
                },
                async ({ user, request, params, body }) =>
                    billing.startGroupCheckout(user, params.id, {
                        productId: body.productId,
                        units: body.units,
                        endLapsed: body.endLapsed,
                        address: requestAddress(request),
                        currency:
                            chargeableCurrency(body.currency, requestCountry(request)) ?? undefined,
                    }),
            )
            .post(
                '/billing/groups/:id/units',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        units: t.Integer({ minimum: 1, maximum: 10_000 }),
                        from: t.Optional(t.Integer({ minimum: 1, maximum: 10_000 })),
                    }),
                    response: { 200: groupUnitsResponse },
                },
                async ({ user, params, body }) =>
                    billing.setGroupUnits(user, params.id, body.units, body.from),
            )
            .post(
                '/billing/groups/:id/plan',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({ productId: t.String({ minLength: 1, maxLength: 100 }) }),
                    response: { 200: groupPlanResponse },
                },
                async ({ user, params, body }) =>
                    billing.changeGroupPlan(user, params.id, body.productId),
            )
            .post(
                '/billing/groups/:id/portal',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({}),
                    response: { 200: urlResponse },
                },
                async ({ user, params }) => billing.createGroupPortalSession(user, params.id),
            )
            .post(
                '/billing/groups/:id/cancel',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: cancellationSchema,
                    response: { 200: groupBillingChangedResponse },
                },
                async ({ user, params, body }) => billing.cancelGroupPlan(user, params.id, body),
            )
            .post(
                '/billing/groups/:id/resume',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({}),
                    response: { 200: groupBillingChangedResponse },
                },
                async ({ user, params }) => billing.resumeGroupPlan(user, params.id),
            )
            .post(
                '/billing/groups/:id/sync',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({}),
                    response: { 200: groupBillingResponse },
                },
                async ({ user, params }) => billing.syncGroup(user, params.id),
            ),
    )
    .guard({ mutation: true, admin: true }, (app) =>
        app
            .get(
                '/billing/affiliates',
                { response: { 200: affiliatesResponse } },
                async ({ set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return growth.listAffiliates();
                },
            )
            // Whether a slug or code is free, as the admin form types it. A convenience only:
            // create and update check the same rule again, and their answer is the one that counts.
            .get(
                '/billing/affiliates/handle',
                {
                    query: t.Object({
                        value: t.String({ minLength: 1, maxLength: 64 }),
                        except: t.Optional(uuidSchema),
                    }),
                    response: { 200: handleResponse },
                },
                async ({ query, set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return { free: await growth.isHandleFree(query.value, query.except) };
                },
            )
            .post(
                '/billing/affiliates',
                {
                    body: t.Object({
                        name: t.String({ minLength: 1, maxLength: 100 }),
                        slug: t.String({ minLength: 1, maxLength: 40 }),
                        code: t.String({ minLength: 3, maxLength: 32 }),
                        percentOff: t.Integer({ minimum: 1, maximum: 100 }),
                        duration: t.Union([
                            t.Literal('once'),
                            t.Literal('forever'),
                            t.Literal('repeating'),
                        ]),
                        durationMonths: t.Optional(
                            t.Nullable(t.Integer({ minimum: 1, maximum: 36 })),
                        ),
                        commissionBps: t.Integer({ minimum: 0, maximum: 10000 }),
                        userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                        notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
                    }),
                    response: { 200: affiliateResponse },
                },
                async ({ body }) => {
                    return growth.createAffiliate({
                        ...body,
                        userEmail: affiliateEmail(body.userEmail),
                    });
                },
            )
            .patch(
                '/billing/affiliates/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({
                        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
                        slug: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
                        code: t.Optional(t.String({ minLength: 3, maxLength: 32 })),
                        percentOff: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
                        duration: t.Optional(
                            t.Union([
                                t.Literal('once'),
                                t.Literal('forever'),
                                t.Literal('repeating'),
                            ]),
                        ),
                        durationMonths: t.Optional(
                            t.Nullable(t.Integer({ minimum: 1, maximum: 36 })),
                        ),
                        commissionBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
                        notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
                        userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                        active: t.Optional(t.Boolean()),
                    }),
                    response: { 200: affiliateResponse },
                },
                async ({ params, body }) => {
                    return growth.updateAffiliate(params.id, {
                        ...body,
                        ...(body.userEmail !== undefined
                            ? { userEmail: affiliateEmail(body.userEmail) }
                            : {}),
                    });
                },
            )
            .delete(
                '/billing/affiliates/:id',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({}),
                    response: { 200: affiliateDeletedResponse },
                },
                async ({ params }) => {
                    return growth.deleteAffiliate(params.id);
                },
            )
            .post(
                '/billing/affiliates/:id/paid',
                {
                    params: t.Object({ id: uuidSchema }),
                    // `expected`: the payout the operator was shown, per currency. Required
                    // with commission safety on (400 without it), and never sent with it off. If
                    // the ledger has moved since, nothing is marked (409).
                    body: t.Object({
                        expected: t.Optional(
                            t.Record(
                                t.String({ pattern: '^[a-z]{3}$' }),
                                t.Object({ owed: minorUnits, netted: minorUnits }),
                            ),
                        ),
                    }),
                    response: { 200: affiliatePaidResponse },
                },
                async ({ params, body, operator }) => {
                    return growth.markAffiliatePaid(params.id, {
                        by: operator.id,
                        expected: body.expected,
                    });
                },
            )
            // Everything below is commission safety (AFFILIATE_V2_ENABLED): the status answers
            // `enabled: false` without it, and the rest answer 404.
            .get(
                '/billing/affiliates/ledger',
                { response: { 200: affiliateLedgerStatusResponse } },
                async ({ set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return growth.affiliateLedgerStatus();
                },
            )
            .get(
                '/billing/affiliates/:id/earnings',
                {
                    params: t.Object({ id: uuidSchema }),
                    response: { 200: affiliateEarningsResponse },
                },
                async ({ params, set }) => {
                    set.headers['Cache-Control'] = 'no-store';
                    return growth.listAffiliateEarnings(params.id);
                },
            )
            .post(
                '/billing/affiliates/:id/earnings/:earning/void',
                {
                    params: earningParams,
                    body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) }),
                    response: { 200: affiliateDoneResponse },
                },
                async ({ params, body, operator }) =>
                    growth.voidAffiliateEarning(params.id, params.earning, {
                        by: operator.id,
                        reason: body.reason,
                    }),
            )
            .post(
                '/billing/affiliates/:id/earnings/:earning/release',
                {
                    params: earningParams,
                    body: t.Object({}),
                    response: { 200: affiliateDoneResponse },
                },
                async ({ params, operator }) =>
                    growth.releaseAffiliateEarning(params.id, params.earning, operator.id),
            )
            .post(
                '/billing/affiliates/:id/earnings/:earning/clawback/confirm',
                {
                    params: earningParams,
                    body: t.Object({}),
                    response: { 200: affiliateDoneResponse },
                },
                async ({ params, operator }) =>
                    growth.confirmAffiliateClawback(params.id, params.earning, operator.id),
            )
            .post(
                '/billing/affiliates/:id/earnings/:earning/clawback/settle',
                {
                    params: earningParams,
                    body: t.Union([
                        t.Object({
                            kind: t.Literal('repaid'),
                            amount: minorUnits,
                            note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
                        }),
                        t.Object({
                            kind: t.Literal('written-off'),
                            note: t.String({ minLength: 1, maxLength: 500 }),
                        }),
                    ]),
                    response: { 200: affiliateDoneResponse },
                },
                async ({ params, body, operator }) =>
                    growth.settleAffiliateClawback(params.id, params.earning, {
                        ...body,
                        by: operator.id,
                    }),
            )
            .delete(
                '/billing/affiliates/:id/record',
                {
                    params: t.Object({ id: uuidSchema }),
                    body: t.Object({}),
                    response: { 200: affiliateDeletedResponse },
                },
                async ({ params }) => growth.deleteAffiliateRecord(params.id),
            ),
    );
