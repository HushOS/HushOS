import { SiteFooter, SiteHeader } from '@/components/site-header';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { billingApi } from '@/lib/billing-api';
import { authError } from '@/lib/form';
import { billingQueryOptions, catalogueQueryOptions, formatGiB, formatMoney } from '@/lib/queries';
import { publicOrigin } from '@/lib/social';
import type { Plan } from '@hushos/billing/api';
import { tiersOf } from '@/lib/plans';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/pricing')({
    loader: async ({ context }) => {
        const catalogue = await context.queryClient.ensureQueryData(catalogueQueryOptions);
        if (!catalogue.enabled) throw notFound();
        // With a session cookie, the buttons can say "Current" and "Switch" on first paint.
        if (context.hasSession)
            await context.queryClient.ensureQueryData(billingQueryOptions).catch(() => null);
        return { origin: publicOrigin(), catalogue };
    },
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' }),
    head: ({ loaderData }) => {
        if (!loaderData) return {};
        const { origin, catalogue } = loaderData;
        const description = `Start free with ${formatGiB(catalogue.freeQuotaBytes)} of end-to-end encrypted storage. Paid plans add space, from ${cheapest(catalogue.plans)} a month, billed by Polar with tax handled at checkout.`;
        return {
            meta: [
                { title: 'Pricing · HushOS' },
                { name: 'description', content: description },
                { property: 'og:type', content: 'website' },
                { property: 'og:site_name', content: 'HushOS' },
                { property: 'og:title', content: 'HushOS pricing' },
                { property: 'og:description', content: description },
                { property: 'og:url', content: `${origin}/pricing` },
                { property: 'og:image', content: `${origin}/og.jpg` },
                { name: 'twitter:card', content: 'summary_large_image' },
                { name: 'twitter:title', content: 'HushOS pricing' },
                { name: 'twitter:description', content: description },
                { name: 'twitter:image', content: `${origin}/og.jpg` },
            ],
            links: [{ rel: 'canonical', href: `${origin}/pricing` }],
            scripts: [
                {
                    type: 'application/ld+json',
                    children: JSON.stringify({
                        '@context': 'https://schema.org',
                        '@graph': [
                            {
                                '@type': 'SoftwareApplication',
                                '@id': `${origin}/#app`,
                                name: 'HushOS',
                                applicationCategory: 'BusinessApplication',
                                operatingSystem: 'Web',
                                url: origin,
                                offers: [
                                    {
                                        '@type': 'Offer',
                                        name: 'Free',
                                        description: `${formatGiB(catalogue.freeQuotaBytes)} of encrypted storage`,
                                        price: '0',
                                        priceCurrency: 'USD',
                                        url: `${origin}/register`,
                                    },
                                    ...catalogue.plans.map((plan) => ({
                                        '@type': 'Offer',
                                        name: plan.name,
                                        description: `${formatGiB(plan.quotaBytes)} of encrypted storage, billed ${plan.interval === 'year' ? 'yearly' : 'monthly'}`,
                                        price: (plan.amount / 100).toFixed(2),
                                        priceCurrency: plan.currency.toUpperCase(),
                                        url: `${origin}/pricing`,
                                        priceSpecification: {
                                            '@type': 'UnitPriceSpecification',
                                            price: (plan.amount / 100).toFixed(2),
                                            priceCurrency: plan.currency.toUpperCase(),
                                            billingDuration: 1,
                                            unitCode: plan.interval === 'year' ? 'ANN' : 'MON',
                                        },
                                    })),
                                ],
                            },
                            {
                                '@type': 'FAQPage',
                                mainEntity: faq.map(({ q, a }) => ({
                                    '@type': 'Question',
                                    name: q,
                                    acceptedAnswer: { '@type': 'Answer', text: a },
                                })),
                            },
                        ],
                    }),
                },
            ],
        };
    },
    component: PricingPage,
});

const faq = [
    {
        q: 'What do paid plans add?',
        a: 'Storage, and nothing else. Every plan is end-to-end encrypted the same way: your password never leaves your device and your keys are made in your browser. Paying only buys more room.',
    },
    {
        q: 'Who bills me?',
        a: 'Polar, our merchant of record. Polar collects payment, works out sales tax or VAT for your country, and issues invoices. Your card details never touch HushOS.',
    },
    {
        q: 'What happens when I cancel?',
        a: 'Your plan stays active until the end of the period you paid for, and you can resume before then. After that your allowance returns to the free tier. Nothing is deleted; uploads pause until you are back under your allowance.',
    },
    {
        q: 'Can I switch between monthly and yearly?',
        a: 'Yes. Monthly and yearly are separate plans. Choose the one you want and the prorated difference is charged, or credited, to your saved card straight away. Yearly plans cost ten months.',
    },
    {
        q: 'Is self-hosting free?',
        a: 'Yes. HushOS is AGPL-3.0. Run your own instance with Docker Compose and set any allowance you like. These plans apply only to the hosted service.',
    },
];

/* The lowest monthly price, for the description tag. */
function cheapest(plans: Plan[]) {
    const monthly = plans.filter((plan) => plan.interval === 'month');
    const plan = monthly.length
        ? monthly.reduce((a, b) => (a.amount <= b.amount ? a : b))
        : plans[0];
    return plan ? formatMoney(plan.amount, plan.currency) : '$0';
}

type Interval = 'month' | 'year';

function PricingPage() {
    const { catalogue } = Route.useLoaderData();
    const { hasSession } = Route.useRouteContext();
    const navigate = useNavigate();
    const [interval, setInterval] = useState<Interval>('year');
    const tiers = tiersOf(catalogue.plans);
    const free = formatGiB(catalogue.freeQuotaBytes);
    // Signed in: the buttons say where this person stands rather than "start".
    const { data: summary } = useQuery({ ...billingQueryOptions, enabled: hasSession });
    const live =
        summary?.subscription && !summary.subscription.endedAt ? summary.subscription : null;
    const onFree = hasSession && summary !== undefined && !live;
    // Signed in and not yet paying: the button starts Polar's checkout itself, no stop
    // on the billing page. Paying subscribers go there for the confirmation step.
    const [starting, setStarting] = useState<string | null>(null);
    const [checkoutError, setCheckoutError] = useState('');
    async function startCheckout(plan: Plan) {
        setStarting(plan.id);
        setCheckoutError('');
        try {
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
                <section className="border-b px-5 py-14 sm:px-10 lg:py-20">
                    <p className="eyebrow text-muted-foreground">Pricing</p>
                    <h1 className="mt-6 max-w-3xl font-mono text-4xl leading-[1.05] font-medium tracking-tight text-balance sm:text-5xl">
                        Start free. Pay for room, not for privacy.
                    </h1>
                    <p className="mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                        Every plan is end-to-end encrypted the same way. Paid plans only add
                        storage. Yearly plans cost ten months. Billing runs through Polar, our
                        merchant of record, so tax is handled at checkout.
                    </p>
                </section>
                <section aria-label="Plans" className="border-b px-5 py-10 sm:px-10 lg:py-14">
                    <div aria-label="Billing period" className="mb-6 inline-flex border bg-card">
                        <IntervalButton
                            active={interval === 'year'}
                            onClick={() => setInterval('year')}
                        >
                            Yearly · 2 months free
                        </IntervalButton>
                        <IntervalButton
                            active={interval === 'month'}
                            onClick={() => setInterval('month')}
                        >
                            Monthly
                        </IntervalButton>
                    </div>
                    {checkoutError && (
                        <p
                            role="alert"
                            className="mb-4 bg-destructive/15 px-4 py-3 font-mono text-xs text-foreground"
                        >
                            {checkoutError}
                        </p>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2 sm:gap-0 sm:border sm:bg-card lg:grid-cols-4 sm:*:border-r lg:[&>*:last-child]:border-r-0 sm:[&>*:nth-child(2n)]:border-r-0 lg:[&>*:nth-child(2n)]:border-r">
                        <PlanColumn
                            name="Free"
                            description="Everything, with a starter allowance."
                            storage={free}
                            price="$0"
                            note="No card needed."
                            action={
                                <Button
                                    render={<Link to={hasSession ? '/app' : '/register'} />}
                                    nativeButton={false}
                                    variant="outline"
                                    size="lg"
                                    className="w-full justify-between"
                                    disabled={onFree}
                                >
                                    {onFree
                                        ? 'Current plan'
                                        : hasSession
                                          ? 'Open app'
                                          : 'Start for free'}
                                    {!onFree && <ArrowRightIcon aria-hidden="true" />}
                                </Button>
                            }
                        />
                        {tiers.map((tier) => {
                            const plan = tier[interval] ?? tier.month ?? tier.year;
                            if (!plan) return null;
                            const other = interval === 'month' ? tier.year : tier.month;
                            const current = live?.productId === plan.id;
                            const label = !hasSession
                                ? `Start with ${tier.name}`
                                : current
                                  ? 'Current plan'
                                  : live
                                    ? `Switch to ${tier.name}`
                                    : summary
                                      ? `Upgrade to ${tier.name}`
                                      : `Choose ${tier.name}`;
                            return (
                                <PlanColumn
                                    key={tier.key}
                                    name={tier.name}
                                    description={tier.description}
                                    storage={formatGiB(tier.quotaBytes)}
                                    recommended={tier.recommended}
                                    price={`${formatMoney(plan.amount, plan.currency)} / ${plan.interval}`}
                                    note={
                                        plan.interval === 'year'
                                            ? `Billed ${formatMoney(plan.amount, plan.currency)} once a year.`
                                            : other
                                              ? `Or ${formatMoney(other.amount, other.currency)} a year.`
                                              : 'Billed monthly.'
                                    }
                                    action={
                                        onFree ? (
                                            <Button
                                                variant={tier.recommended ? 'default' : 'outline'}
                                                size="lg"
                                                className={`w-full justify-between ${tier.recommended ? recommendedButton : ''}`}
                                                disabled={starting !== null}
                                                data-cuelume-press="pulse"
                                                onClick={() => void startCheckout(plan)}
                                            >
                                                <PendingLabel
                                                    pending={starting === plan.id}
                                                    idle={label}
                                                    busy="Opening checkout…"
                                                />
                                                <ArrowRightIcon aria-hidden="true" />
                                            </Button>
                                        ) : (
                                            <Button
                                                render={
                                                    hasSession ? (
                                                        <Link
                                                            to="/app/billing"
                                                            search={{ plan: plan.id }}
                                                        />
                                                    ) : (
                                                        <Link
                                                            to="/register"
                                                            search={{ plan: plan.id }}
                                                        />
                                                    )
                                                }
                                                nativeButton={false}
                                                variant={
                                                    tier.recommended && !current
                                                        ? 'default'
                                                        : 'outline'
                                                }
                                                size="lg"
                                                className={`w-full justify-between ${tier.recommended && !current ? recommendedButton : ''}`}
                                                disabled={current}
                                                data-cuelume-press="pulse"
                                            >
                                                {label}
                                                {!current && <ArrowRightIcon aria-hidden="true" />}
                                            </Button>
                                        )
                                    }
                                />
                            );
                        })}
                    </div>
                </section>
                <section aria-labelledby="pricing-faq" className="px-5 py-12 sm:px-10 lg:py-16">
                    <h2 id="pricing-faq" className="eyebrow text-muted-foreground">
                        Questions
                    </h2>
                    <dl className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-2">
                        {faq.map(({ q, a }) => (
                            <div key={q}>
                                <dt className="font-mono text-[15px] font-medium">{q}</dt>
                                <dd className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                                    {a}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}

function IntervalButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            data-cuelume-press="press"
            className={`eyebrow h-10 cursor-pointer px-4 transition-colors outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${active ? 'bg-ink text-secondary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        >
            {children}
        </button>
    );
}

const recommendedButton =
    'border-success bg-success text-success-foreground hover:border-success hover:bg-[color-mix(in_oklch,var(--success),var(--ink)_12%)]';

function PlanColumn({
    name,
    description,
    storage,
    price,
    note,
    recommended = false,
    action,
}: {
    name: string;
    description: string | null;
    storage: string;
    price: string;
    note: string;
    recommended?: boolean;
    action: React.ReactNode;
}) {
    return (
        <div className="flex flex-col border bg-card sm:border-0 sm:border-b lg:border-b-0">
            <div className="flex flex-1 flex-col gap-5 px-5 py-6 sm:px-6 sm:py-8">
                <p className="eyebrow flex items-center justify-between gap-3 text-muted-foreground">
                    {name}
                    {recommended && (
                        <span className="bg-success px-2 py-0.5 text-success-foreground">
                            Recommended
                        </span>
                    )}
                </p>
                <p className="font-mono text-3xl font-medium tracking-tight tabular-nums">
                    {storage}
                </p>
                {description && (
                    <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
                )}
            </div>
            <div className="border-t px-5 py-4 font-mono tabular-nums sm:px-6">
                <p className="text-xl font-medium">{price}</p>
                <p className="mt-1 text-xs text-muted-foreground">{note}</p>
            </div>
            <div className="flex border-t *:h-14 *:border-0">{action}</div>
        </div>
    );
}
