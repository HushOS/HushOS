import type { Plan } from '@hushos/billing/api';
import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PendingLabel } from '@/components/motion';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { localeHintQueryOptions } from '@/lib/billing';
import { billingApi } from '@/lib/billing-api';
import { pickCurrency } from '@/lib/currency';
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
import { currenciesOf, priceOf, tiersOf } from '@/lib/plans';
import { publicOrigin } from '@/lib/social';

/*
 * An offer page: a creator's discount, by their slug or code, or a code the
 * operator made at Polar and shared as a link. The plans are priced with the
 * discount. Signing up from here carries the code, so the discount is already
 * applied at checkout; anyone can also type the code there.
 */
export const Route = createFileRoute('/go/$slug')({
    loader: async ({ context, params }) => {
        const landing = await getOfferLandingServerFn({ data: { slug: params.slug } });
        if (!landing) throw notFound();
        // Priced as the pricing page would price it for this visitor: by their
        // country or language, out of the currencies every plan carries.
        const hint = await context.queryClient.ensureQueryData(localeHintQueryOptions);
        const currencies = currenciesOf(landing.catalogue.plans);
        const currency = pickCurrency({
            hint,
            available: currencies,
            fallback: currencies[0] ?? 'usd',
        });
        return { origin: publicOrigin(), landing, currency };
    },
    headers: () => ({ 'Cache-Control': 'private, no-store' }),
    head: ({ loaderData }) =>
        loaderData
            ? {
                  meta: [
                      {
                          title:
                              loaderData.landing.kind === 'affiliate'
                                  ? `${discountAmount(loaderData.landing.terms)} off HushOS · ${loaderData.landing.name}`
                                  : `${discountAmount(loaderData.landing.terms)} off HushOS`,
                      },
                      {
                          name: 'description',
                          content:
                              loaderData.landing.kind === 'affiliate'
                                  ? `${describeDiscount(loaderData.landing.terms)} on HushOS through ${loaderData.landing.name}: private storage that is simple to use.`
                                  : `${describeDiscount(loaderData.landing.terms)} on HushOS, private storage that is simple to use.`,
                      },
                      { name: 'robots', content: 'noindex' },
                  ],
              }
            : {},
    component: OfferPage,
});

function OfferPage() {
    const { landing, currency } = Route.useLoaderData();
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
            <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-16 px-4 py-12 sm:px-8 sm:py-20">
                <section className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
                    <div className="flex flex-col gap-6">
                        <p className="eyebrow text-muted-foreground">
                            {/* Whoever carries the offer, a creator or a campaign, named without claiming the offer is theirs. */}
                            Offer · {landing.name}
                        </p>
                        <h1 className="max-w-3xl text-5xl font-bold tracking-tight text-balance sm:text-6xl">
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
                                >
                                    Create your account <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            )}
                        </div>
                        {hasSession && (
                            <p className="text-sm text-muted-foreground" aria-live="polite">
                                {remembered === 'done'
                                    ? `${landing.code} will be applied at your next checkout.`
                                    : remembered === 'failed'
                                      ? `Type ${landing.code} at checkout to use this offer.`
                                      : 'Keeping this code for your checkout…'}
                            </p>
                        )}
                    </div>
                    <aside className="sheet px-6 py-6">
                        <p className="eyebrow text-muted-foreground">The offer</p>
                        <dl className="mt-2 text-sm">
                            {[
                                ['Code', landing.code],
                                ['Discount', offer],
                                ['Applies to', appliesTo],
                                ...(ends ? [['Ends', ends]] : []),
                                ['Free to start', formatGiB(landing.catalogue.freeQuotaBytes)],
                            ].map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex justify-between gap-6 border-b border-dotted border-rule py-2.5 last:border-b-0"
                                >
                                    <dt className="text-muted-foreground">{key}</dt>
                                    <dd
                                        className={`text-right ${key === 'Code' ? 'font-mono' : ''}`}
                                    >
                                        {value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </aside>
                </section>

                {tiers.length > 0 && (
                    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-8">
                        <h2 id="plans-title" className="text-lg font-bold">
                            Plans with {landing.code} applied
                        </h2>
                        <div
                            className={`mt-6 grid gap-6 md:grid-cols-2 ${tiers.length + 1 === 4 ? 'xl:grid-cols-4' : 'lg:grid-cols-3'}`}
                        >
                            {/* The offer is on paid plans, but nobody has to take one: free is a choice here too. */}
                            <article className="flex sheet flex-col gap-6 border border-transparent px-6 py-6">
                                <div className="flex flex-1 flex-col gap-2">
                                    <p className="eyebrow text-muted-foreground">Free</p>
                                    <p className="text-3xl font-bold tracking-tight tabular-nums">
                                        {formatGiB(landing.catalogue.freeQuotaBytes)}
                                    </p>
                                    <p className="text-sm leading-relaxed text-muted-foreground">
                                        The same protection as every paid plan, with no card. The
                                        code stays on your account if you want more room later.
                                    </p>
                                </div>
                                {hasSession ? (
                                    <Button
                                        variant="outline"
                                        render={<Link to="/app/drive" />}
                                        nativeButton={false}
                                    >
                                        Go to Drive
                                    </Button>
                                ) : (
                                    <Button
                                        variant="outline"
                                        render={
                                            <Link to="/register" search={{ ref: landing.code }} />
                                        }
                                        nativeButton={false}
                                    >
                                        Start free
                                    </Button>
                                )}
                            </article>
                            {tiers.map((tier) => (
                                <article
                                    key={tier.key}
                                    className={`flex sheet flex-col gap-6 border px-6 py-6 ${tier.recommended ? 'border-primary ring-3 ring-accent' : 'border-transparent'}`}
                                >
                                    <div className="flex flex-1 flex-col gap-2">
                                        <p className="eyebrow text-muted-foreground">{tier.name}</p>
                                        <p className="text-3xl font-bold tracking-tight tabular-nums">
                                            {formatGiB(tier.quotaBytes)}
                                        </p>
                                        {tier.description && (
                                            <p className="text-sm leading-relaxed text-muted-foreground">
                                                {tier.description}
                                            </p>
                                        )}
                                    </div>
                                    <dl className="text-sm tabular-nums">
                                        {(['month', 'year'] as const).map((interval) => {
                                            const plan = tier[interval];
                                            if (!plan) return null;
                                            const price = priceOf(plan, currency);
                                            const after = discounted(
                                                price.amount,
                                                price.currency,
                                                landing.terms,
                                            );
                                            return (
                                                <div
                                                    key={interval}
                                                    className="flex items-baseline justify-between gap-4 border-b border-dotted border-rule py-2.5 last:border-b-0"
                                                >
                                                    <dt className="text-muted-foreground">
                                                        Per {interval}
                                                    </dt>
                                                    <dd className="flex items-baseline gap-3">
                                                        {after === null ? (
                                                            <span className="text-lg font-bold">
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
                                                                <span className="text-lg font-bold">
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
                                    <div className="flex flex-col gap-2">
                                        {hasSession ? (
                                            // One button per period: the checkout opens with the code applied.
                                            (['year', 'month'] as const).map((interval) => {
                                                const plan = tier[interval];
                                                if (!plan) return null;
                                                return (
                                                    <Button
                                                        key={plan.id}
                                                        variant={
                                                            tier.recommended && interval === 'year'
                                                                ? 'default'
                                                                : 'outline'
                                                        }
                                                        className="w-full justify-between"
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
                                                variant={tier.recommended ? 'default' : 'outline'}
                                                className="w-full justify-between"
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
                                className="mt-6 rounded-xs bg-destructive-soft px-4 py-3 text-sm text-destructive"
                            >
                                {checkoutError}
                            </p>
                        )}
                        <p className="mt-6 max-w-3xl text-xs leading-relaxed text-muted-foreground">
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
