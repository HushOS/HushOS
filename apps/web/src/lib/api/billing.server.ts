import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as auth from '@hushos/auth/server';
import { guardAuthMutation } from '@hushos/auth/http';
import * as billing from '@hushos/billing/server';
import * as growth from '@hushos/billing/growth';
import { chargeableCurrency } from '@/lib/currency';
import {
    affiliateEmail,
    billingMutation,
    billingUser,
    cancellationSchema,
    requestAddress,
    requestContext,
    requestCountry,
    uuidSchema,
} from '@/lib/api/shared.server';

/* Plans, checkout, families' billing, referrals and affiliates (/api/billing). */
export const billingApi = new Elysia()
    .use(requestContext)
    .get('/billing/catalogue', ({ set }) => {
        set.headers['Cache-Control'] = 'public, max-age=60';
        return billing.listCatalogue();
    })
    .get('/billing', async ({ sessionToken }) =>
        billing.getSummary(await billingUser(sessionToken)),
    )
    .post(
        '/billing/checkout',
        {
            body: t.Object({
                productId: t.String({ minLength: 1, maxLength: 100 }),
                currency: t.Optional(t.String({ pattern: '^[a-z]{3}$' })),
            }),
        },
        async ({ request, sessionToken, body }) =>
            billing.startCheckout(
                await billingMutation(request, sessionToken),
                body.productId,
                requestAddress(request),
                // The page's currency is a display choice; Polar is told it only when
                // the visitor's country pays in it, else Polar decides from the address.
                chargeableCurrency(body.currency, requestCountry(request)) ?? undefined,
            ),
    )
    // Referrals and affiliates: a person's own invite, and the operator's creators.
    .get('/billing/referrals', async ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        const user = await billingUser(sessionToken);
        return growth.getReferralSummary(user.id);
    })
    .post(
        '/billing/coupon',
        { body: t.Object({ code: t.String({ minLength: 3, maxLength: 32 }) }) },
        async ({ request, sessionToken, body }) => {
            const user = await billingMutation(request, sessionToken);
            return growth.rememberCoupon(user.id, body.code);
        },
    )
    .get('/billing/affiliates', async ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        await auth.requireAdmin(sessionToken);
        return growth.listAffiliates();
    })
    // Whether a slug or code is free, as the admin form types it. A convenience only:
    // create and update check the same rule again, and their answer is the one that counts.
    .get(
        '/billing/affiliates/handle',
        {
            query: t.Object({
                value: t.String({ minLength: 1, maxLength: 64 }),
                except: t.Optional(uuidSchema),
            }),
        },
        async ({ sessionToken, query, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            await auth.requireAdmin(sessionToken);
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
                durationMonths: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 36 }))),
                commissionBps: t.Integer({ minimum: 0, maximum: 10000 }),
                userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            }),
        },
        async ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.createAffiliate({ ...body, userEmail: affiliateEmail(body.userEmail) });
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
                    t.Union([t.Literal('once'), t.Literal('forever'), t.Literal('repeating')]),
                ),
                durationMonths: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 36 }))),
                commissionBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
                notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
                userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                active: t.Optional(t.Boolean()),
            }),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
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
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.deleteAffiliate(params.id);
        },
    )
    .post(
        '/billing/affiliates/:id/paid',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.markAffiliatePaid(params.id);
        },
    )
    .post('/billing/portal', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.createPortalSession(await billingMutation(request, sessionToken)),
    )
    .post('/billing/sync', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.sync(await billingMutation(request, sessionToken)),
    )
    .post(
        '/billing/cancel',
        { body: cancellationSchema },
        async ({ request, sessionToken, body }) =>
            billing.cancelAtPeriodEnd(await billingMutation(request, sessionToken), body),
    )
    .post('/billing/resume', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.resume(await billingMutation(request, sessionToken)),
    )
    // The family tier chosen at signup, once the app has opened Create a family with it.
    .post(
        '/billing/intended-family/forget',
        { body: t.Object({}) },
        async ({ request, sessionToken }) => {
            await billing.forgetIntendedFamily(await billingMutation(request, sessionToken));
            return { success: true as const };
        },
    )
    // A family's plan (docs/groups-design.md 3.5): only with GROUPS_ENABLED and billing on,
    // which the billing functions check; managers see it, the payer changes it.
    .get(
        '/billing/groups/:id',
        { params: t.Object({ id: uuidSchema }) },
        async ({ sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return billing.getGroupBilling(await billingUser(sessionToken), params.id);
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
        },
        async ({ request, sessionToken, params, body }) =>
            billing.startGroupCheckout(await billingMutation(request, sessionToken), params.id, {
                productId: body.productId,
                units: body.units,
                endLapsed: body.endLapsed,
                address: requestAddress(request),
                currency: chargeableCurrency(body.currency, requestCountry(request)) ?? undefined,
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
        },
        async ({ request, sessionToken, params, body }) =>
            billing.setGroupUnits(
                await billingMutation(request, sessionToken),
                params.id,
                body.units,
                body.from,
            ),
    )
    .post(
        '/billing/groups/:id/plan',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ productId: t.String({ minLength: 1, maxLength: 100 }) }),
        },
        async ({ request, sessionToken, params, body }) =>
            billing.changeGroupPlan(
                await billingMutation(request, sessionToken),
                params.id,
                body.productId,
            ),
    )
    .post(
        '/billing/groups/:id/portal',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) =>
            billing.createGroupPortalSession(
                await billingMutation(request, sessionToken),
                params.id,
            ),
    )
    .post(
        '/billing/groups/:id/cancel',
        { params: t.Object({ id: uuidSchema }), body: cancellationSchema },
        async ({ request, sessionToken, params, body }) =>
            billing.cancelGroupPlan(await billingMutation(request, sessionToken), params.id, body),
    )
    .post(
        '/billing/groups/:id/resume',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) =>
            billing.resumeGroupPlan(await billingMutation(request, sessionToken), params.id),
    )
    .post(
        '/billing/groups/:id/sync',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) =>
            billing.syncGroup(await billingMutation(request, sessionToken), params.id),
    );
