import type { Plan } from '@hushos/billing/api';
import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PendingLabel } from '@/components/motion';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { billingApi } from '@/lib/billing-api';
import { authError } from '@/lib/form';
import { formatGiB, formatMoney } from '@/lib/format';
import { usePageRestored } from '@/lib/page-restore';
import {
    describeDiscount,
    discountAmount,
    discounted,
    getOfferLandingServerFn,
} from '@/lib/growth';
import { growthApi } from '@/lib/growth-api';
import { priceOf, tiersOf } from '@/lib/plans';
import { publicOrigin } from '@/lib/social';

/*
 * An offer page: a creator's discount, by their slug or code, or a code the
 * operator made at Polar and shared as a link. The plans are priced with the
 * discount. Signing up from here carries the code, so the discount is already
 * applied at checkout; anyone can also type the code there.
 */
export const Route = createFileRoute('/go/$slug')({
    loader: async ({ params }) => {
        const landing = await getOfferLandingServerFn({ data: { slug: params.slug } });
        if (!landing) throw notFound();
        return { origin: publicOrigin(), landing };
    },
    headers: () => ({ 'Cache-Control': 'private, no-store' }),
    head: ({ loaderData }) =>
        loaderData
            ? {
                  meta: [
                      {
                          title:
                              loaderData.landing.kind === 'affiliate'
                                  ? `${discountAmount(loaderData.landing.terms)} off HushOS with ${loaderData.landing.name}`
                                  : `${discountAmount(loaderData.landing.terms)} off HushOS`,
                      },
                      {
                          name: 'description',
                          content:
                              loaderData.landing.kind === 'affiliate'
                                  ? `${loaderData.landing.name} gets you ${describeDiscount(loaderData.landing.terms)} on HushOS, private storage that is simple to use.`
                                  : `${describeDiscount(loaderData.landing.terms)} on HushOS, private storage that is simple to use.`,
                      },
                      { name: 'robots', content: 'noindex' },
                  ],
              }
            : {},
    component: OfferPage,
});

function OfferPage() {
    const { landing } = Route.useLoaderData();
    const { hasSession } = Route.useRouteContext();
    const limited = new Set(landing.productIds);
    // An offer limited to some plans shows only those, and only the intervals it covers.
    const tiers = tiersOf(landing.catalogue.plans)
        .map((tier) => ({
            ...tier,
            month:
                tier.month && (!limited.size || limited.has(tier.month.id))
                    ? tier.month
                    : undefined,
            year: tier.year && (!limited.size || limited.has(tier.year.id)) ? tier.year : undefined,
        }))
        .filter((tier) => tier.month || tier.year);
    const offer = describeDiscount(landing.terms);
    const appliesTo = limited.size
        ? landing.catalogue.plans
              .filter((plan) => limited.has(plan.id))
              .map((plan) => plan.name)
              .join(', ') || 'Selected plans'
        : 'Every paid plan';
    const ends = landing.endsAt
        ? new Date(landing.endsAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
          })
        : null;
    // Signed in: the code is kept for this account's next checkout, so it applies without typing.
    const [remembered, setRemembered] = useState<'pending' | 'done' | 'failed'>('pending');
    const remembering = useRef<Promise<unknown> | null>(null);
    useEffect(() => {
        if (!hasSession) return;
        remembering.current = growthApi.rememberCoupon(landing.code).then(
            () => setRemembered('done'),
            () => setRemembered('failed'),
        );
    }, [hasSession, landing.code]);
    // Signed in, the plan's button is the checkout itself, once the code is on record.
    const navigate = useNavigate();
    const [starting, setStarting] = useState<string | null>(null);
    const [checkoutError, setCheckoutError] = useState('');
    usePageRestored(() => {
        setStarting(null);
        setCheckoutError('');
    });
    async function startCheckout(plan: Plan) {
        setStarting(plan.id);
        setCheckoutError('');
        try {
            await remembering.current;
            const { url } = await billingApi.checkout(plan.id);
            if (url) {
                window.location.assign(url);
                return;
            }
            void navigate({ to: '/app/billing' });
        } catch (error) {
            setCheckoutError(authError(error));
            setStarting(null);
        }
    }
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 flex-col">
                <section className="grid border-b lg:grid-cols-12">
                    <div className="flex flex-col gap-8 px-5 py-14 sm:px-10 lg:col-span-8 lg:py-20">
                        <p className="eyebrow text-muted-foreground">
                            {landing.kind === 'affiliate'
                                ? `An offer from ${landing.name}`
                                : landing.name}
                        </p>
                        <h1 className="max-w-3xl font-mono text-[2.5rem] leading-[1.05] font-medium tracking-tight text-balance sm:text-6xl">
                            {discountAmount(landing.terms)} off HushOS.
                        </h1>
                        <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                            Private storage for your files, simple to use. Sign up through this page
                            and the code{' '}
                            <span className="font-mono text-foreground">{landing.code}</span> is
                            applied for you: {offer}. Every account starts free with{' '}
                            {formatGiB(landing.catalogue.freeQuotaBytes)}.
                        </p>
                        <div className="flex flex-wrap gap-3">
                            {hasSession ? (
                                <Button
                                    render={<Link to="." hash="plans" />}
                                    nativeButton={false}
                                    size="lg"
                                >
                                    Pick a plan <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            ) : (
                                <Button
                                    render={<Link to="/register" search={{ ref: landing.code }} />}
                                    nativeButton={false}
                                    size="lg"
                                    data-cuelume-press="pulse"
                                >
                                    Create your account <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            )}
                        </div>
                        {hasSession && (
                            <p
                                className="font-mono text-xs text-muted-foreground"
                                aria-live="polite"
                            >
                                {remembered === 'done'
                                    ? `${landing.code} will be applied at your next checkout.`
                                    : remembered === 'failed'
                                      ? `Type ${landing.code} at checkout to use this offer.`
                                      : 'Keeping this code for your checkout…'}
                            </p>
                        )}
                    </div>
                    <aside className="flex flex-col border-t lg:col-span-4 lg:border-t-0 lg:border-l">
                        <p className="eyebrow border-b px-5 py-4 text-muted-foreground">
                            The offer
                        </p>
                        <dl className="flex-1 px-5 py-4 font-mono text-[13px]">
                            {[
                                ['Code', landing.code],
                                ['Discount', offer],
                                ['Applies to', appliesTo],
                                ...(ends ? [['Ends', ends]] : []),
                                ['Free to start', formatGiB(landing.catalogue.freeQuotaBytes)],
                            ].map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex justify-between gap-6 border-b border-dotted py-2.5 last:border-b-0"
                                >
                                    <dt className="eyebrow self-center text-muted-foreground">
                                        {key}
                                    </dt>
                                    <dd className="text-right">{value}</dd>
                                </div>
                            ))}
                        </dl>
                    </aside>
                </section>

                {tiers.length > 0 && (
                    <section id="plans" aria-labelledby="plans-title" className="border-b">
                        <div className="border-b px-5 py-4 sm:px-10">
                            <h2 id="plans-title" className="eyebrow text-muted-foreground">
                                Plans with {landing.code} applied
                            </h2>
                        </div>
                        <div className="grid md:grid-cols-2 lg:grid-cols-3">
                            {tiers.map((tier) => (
                                <article
                                    key={tier.key}
                                    className="flex flex-col border-b md:border-r md:even:border-r-0 lg:border-r lg:even:border-r lg:nth-[3n]:border-r-0"
                                >
                                    <div className="flex flex-1 flex-col gap-4 px-5 py-6 sm:px-10">
                                        <p className="eyebrow text-muted-foreground">{tier.name}</p>
                                        <p className="font-mono text-3xl font-medium tracking-tight tabular-nums">
                                            {formatGiB(tier.quotaBytes)}
                                        </p>
                                        {tier.description && (
                                            <p className="text-sm leading-relaxed text-muted-foreground">
                                                {tier.description}
                                            </p>
                                        )}
                                    </div>
                                    <dl className="border-t font-mono text-sm tabular-nums">
                                        {(['month', 'year'] as const).map((interval) => {
                                            const plan = tier[interval];
                                            if (!plan) return null;
                                            const price = priceOf(plan, plan.currency);
                                            const after = discounted(
                                                price.amount,
                                                price.currency,
                                                landing.terms,
                                            );
                                            return (
                                                <div
                                                    key={interval}
                                                    className="flex items-baseline justify-between gap-4 border-b px-5 py-3 last:border-b-0 sm:px-10"
                                                >
                                                    <dt className="eyebrow text-muted-foreground">
                                                        Per {interval}
                                                    </dt>
                                                    <dd className="flex items-baseline gap-3">
                                                        {after === null ? (
                                                            <span className="text-lg font-medium">
                                                                {formatMoney(
                                                                    price.amount,
                                                                    price.currency,
                                                                )}
                                                            </span>
                                                        ) : (
                                                            <>
                                                                <s className="text-muted-foreground">
                                                                    {formatMoney(
                                                                        price.amount,
                                                                        price.currency,
                                                                    )}
                                                                </s>
                                                                <span className="text-lg font-medium">
                                                                    {formatMoney(
                                                                        after,
                                                                        price.currency,
                                                                    )}
                                                                </span>
                                                            </>
                                                        )}
                                                    </dd>
                                                </div>
                                            );
                                        })}
                                    </dl>
                                    <div className="border-t">
                                        {hasSession ? (
                                            // One button per period: the checkout opens with the code applied.
                                            (['year', 'month'] as const).map((interval) => {
                                                const plan = tier[interval];
                                                if (!plan) return null;
                                                return (
                                                    <Button
                                                        key={plan.id}
                                                        variant="row"
                                                        className="h-14 w-full justify-between border-0 border-b px-5 last:border-b-0 sm:px-10"
                                                        disabled={starting !== null}
                                                        onClick={() => void startCheckout(plan)}
                                                    >
                                                        <PendingLabel
                                                            pending={starting === plan.id}
                                                            idle={`Subscribe per ${interval}`}
                                                            busy="Opening checkout…"
                                                        />
                                                        <ArrowRightIcon aria-hidden="true" />
                                                    </Button>
                                                );
                                            })
                                        ) : (
                                            <Button
                                                render={
                                                    <Link
                                                        to="/register"
                                                        search={{
                                                            ref: landing.code,
                                                            plan: (tier.year ?? tier.month)?.id,
                                                        }}
                                                    />
                                                }
                                                nativeButton={false}
                                                variant="row"
                                                className="h-14 w-full justify-between border-0 px-5 sm:px-10"
                                            >
                                                Start with this plan
                                                <ArrowRightIcon aria-hidden="true" />
                                            </Button>
                                        )}
                                    </div>
                                </article>
                            ))}
                        </div>
                        {checkoutError && (
                            <p
                                role="alert"
                                className="border-b px-5 py-3 text-sm text-destructive sm:px-10"
                            >
                                {checkoutError}
                            </p>
                        )}
                        <p className="px-5 py-4 font-mono text-[11px] text-muted-foreground sm:px-10">
                            Prices before tax, in the plan's default currency; the checkout shows
                            your own, and takes a fixed amount off in its own currency. The discount
                            comes off every payment it applies to, as described above.
                        </p>
                    </section>
                )}
            </main>
            <SiteFooter />
        </div>
    );
}
