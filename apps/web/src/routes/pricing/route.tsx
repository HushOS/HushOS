import { SiteFooter, SiteHeader } from '@/components/site-header';
import { container, Faq, H1, H2, Lede, SiteSwitch, TalkToUs, TextLink } from '@/components/site';
import { Button, buttonVariants } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { billingApi } from '@/lib/billing-api';
import { currencyLabel, pickCurrency } from '@/lib/currency';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatQuota,
    formatMoney,
    localeHintQueryOptions,
} from '@/lib/queries';
import { publicOrigin, salesContactQueryOptions } from '@/lib/social';
import type { Plan } from '@hushos/billing/api';
import { currenciesOf, priceOf, tiersOf } from '@/lib/plans';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/pricing')({
    // In the address, so a link can open the Business plans (/pricing?for=business, from the
    // teams page) and Back returns to the same choice; Personal, the default, adds nothing.
    validateSearch: (search: Record<string, unknown>): { currency?: string; for?: 'business' } => ({
        ...(typeof search.currency === 'string' && /^[a-z]{3}$/.test(search.currency)
            ? { currency: search.currency }
            : {}),
        ...(search.for === 'business' ? { for: 'business' as const } : {}),
    }),
    loaderDeps: ({ search }) => ({ currency: search.currency }),
    loader: async ({ context, deps }) => {
        const catalogue = await context.queryClient.ensureQueryData(catalogueQueryOptions);
        if (!catalogue.enabled) throw notFound();
        // With a session cookie, the buttons can say "Current" and "Switch" on first paint.
        if (context.hasSession)
            await context.queryClient.ensureQueryData(billingQueryOptions).catch(() => null);
        // The currency the visitor chose, else the one their country or language
        // suggests, out of those every plan is priced in; Polar charges in the same one.
        const hint = await context.queryClient.ensureQueryData(localeHintQueryOptions);
        const currencies = currenciesOf(catalogue.plans);
        const detected = pickCurrency({
            hint,
            available: currencies,
            fallback: currencies[0] ?? 'usd',
        });
        const currency = pickCurrency({
            requested: deps.currency,
            hint,
            available: currencies,
            fallback: detected,
        });
        // With a trusted country header the currency is settled and there is nothing to
        // choose; otherwise the visitor may read the page in another one, and the
        // checkout still charges by address.
        return {
            origin: publicOrigin(),
            catalogue,
            currency,
            currencies: hint.trusted ? [] : currencies,
            detected,
        };
    },
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' }),
    head: ({ loaderData }) => {
        if (!loaderData) return {};
        const { origin, catalogue, currency } = loaderData;
        const description = `Start free with ${formatQuota(catalogue.freeQuotaBytes)} of end-to-end encrypted storage. Paid plans add space, from ${cheapest(catalogue.plans, currency)} a month, billed by Polar with tax handled at checkout.`;
        return {
            meta: [
                { title: 'Pricing · HushOS' },
                { name: 'description', content: description },
                { property: 'og:type', content: 'website' },
                { property: 'og:site_name', content: 'HushOS' },
                { property: 'og:title', content: 'HushOS pricing' },
                { property: 'og:description', content: description },
                { property: 'og:url', content: `${origin}/pricing` },
                { property: 'og:image', content: `${origin}/og/pricing.jpg` },
                { name: 'twitter:card', content: 'summary_large_image' },
                { name: 'twitter:title', content: 'HushOS pricing' },
                { name: 'twitter:description', content: description },
                { name: 'twitter:image', content: `${origin}/og/pricing.jpg` },
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
                                        description: `${formatQuota(catalogue.freeQuotaBytes)} of encrypted storage`,
                                        price: '0',
                                        priceCurrency: currency.toUpperCase(),
                                        url: `${origin}/register`,
                                    },
                                    ...catalogue.plans.map((plan) => {
                                        const price = priceOf(plan, currency);
                                        return {
                                            '@type': 'Offer',
                                            name: plan.name,
                                            description: `${formatQuota(plan.quotaBytes)} of encrypted storage, billed ${plan.interval === 'year' ? 'yearly' : 'monthly'}`,
                                            price: (price.amount / 100).toFixed(2),
                                            priceCurrency: price.currency.toUpperCase(),
                                            url: `${origin}/pricing`,
                                            priceSpecification: {
                                                '@type': 'UnitPriceSpecification',
                                                price: (price.amount / 100).toFixed(2),
                                                priceCurrency: price.currency.toUpperCase(),
                                                billingDuration: 1,
                                                unitCode: plan.interval === 'year' ? 'ANN' : 'MON',
                                            },
                                        };
                                    }),
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
        a: 'Storage, and nothing else. Every plan protects your files the same way: your password never leaves your device and your keys are made on it. Paying only buys more room.',
    },
    {
        q: 'Who bills me?',
        a: 'Polar, our merchant of record. Polar takes the payment, works out sales tax or VAT for your country at checkout, and sends the invoices. Your card details never reach HushOS.',
    },
    {
        q: 'What happens when I cancel?',
        a: 'Your plan stays until the end of the time you paid for, and you can change your mind before then. After that you are back on Free. Nothing is deleted; uploads pause until you are under your space again.',
    },
    {
        q: 'Can I switch between monthly and yearly?',
        a: 'Yes. Choose the one you want and the difference is charged, or credited, to your saved card straight away. Paying yearly gets you two months free.',
    },
    {
        q: 'Is running it myself free?',
        a: 'Yes. HushOS is open source under the AGPL-3.0. Run your own copy with Docker Compose and give everyone as much space as you like. These plans are only for the service we run.',
    },
];

/* The lowest monthly price in the page's currency, for the description tag. */
function cheapest(plans: Plan[], currency: string) {
    const monthly = plans.filter((plan) => plan.interval === 'month');
    const plan = monthly.length
        ? monthly.reduce((a, b) =>
              priceOf(a, currency).amount <= priceOf(b, currency).amount ? a : b,
          )
        : plans[0];
    if (!plan) return formatMoney(0, currency);
    const price = priceOf(plan, currency);
    return formatMoney(price.amount, price.currency);
}

type Interval = 'month' | 'year';
type Audience = 'personal' | 'business';

const included = [
    'Everything locked on your device, on every plan',
    'Share with people, or by link with a password and an end date',
    'Trash keeps things for 30 days',
    'Replacing a file keeps the one before',
    'On any computer or phone, in the browser',
    'Kept in the EU',
];

/* What each size is for, by plan name; a plan without one shows none rather than its size again. */
const blurbs: Record<string, string> = {
    plus: 'For your photos and paperwork.',
    pro: 'For a large photo library and the folders you share.',
    max: 'For everything, with room to spare.',
};
const blurbOf = (name: string, description: string | null) =>
    blurbs[name.toLowerCase()] ??
    (description && !/\b\d+(\.\d+)?\s*(GiB|GB|TiB|TB)\b/.test(description) ? description : null);

const teamToday = [
    'Share a folder with each person, to view or to edit',
    'An editor’s uploads count against the folder owner’s space',
    'Links with a password and an end date, turned off at any time',
    'Every file shows who can open it',
    'Run HushOS on your own server, free, for the whole team',
];

const teamPlanned = [
    'One bill for the whole team',
    'Folders that belong to the team, not to one person',
    'Add and remove people in one place',
    'The same protection as every plan',
];

function PricingPage() {
    const { catalogue, currency, currencies, detected } = Route.useLoaderData();
    const { hasSession } = Route.useRouteContext();
    const navigate = useNavigate();
    const amount = (plan: Plan) => priceOf(plan, currency);
    const money = (minor: number, code = currency) => formatMoney(minor, code);
    const search = Route.useSearch();
    const audience: Audience = search.for === 'business' ? 'business' : 'personal';
    const setAudience = (value: Audience) =>
        void navigate({
            to: '/pricing',
            search: (previous) => ({
                ...previous,
                for: value === 'business' ? ('business' as const) : undefined,
            }),
            replace: true,
            resetScroll: false,
        });
    const [interval, setInterval] = useState<Interval>('year');
    const tiers = tiersOf(catalogue.plans);
    const free = formatQuota(catalogue.freeQuotaBytes);
    // Signed in: the buttons say where this person stands rather than "start".
    const { data: summary } = useQuery({ ...billingQueryOptions, enabled: hasSession });
    const live =
        summary?.subscription && !summary.subscription.endedAt ? summary.subscription : null;
    const onFree = hasSession && summary !== undefined && !live;
    // Signed in and not yet paying: the button starts Polar's checkout itself, no stop
    // on the billing page. Paying subscribers go there for the confirmation step.
    const [starting, setStarting] = useState<string | null>(null);
    const [checkoutError, setCheckoutError] = useState('');
    // Back from Polar's checkout restores this page with `starting` still set.
    usePageRestored(() => {
        setStarting(null);
        setCheckoutError('');
    });
    async function startCheckout(plan: Plan) {
        setStarting(plan.id);
        setCheckoutError('');
        try {
            const { url } = await billingApi.checkout(plan.id, currency);
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
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <section className={cn(container, 'pt-10 pb-8 lg:pt-20 lg:pb-10')}>
                    <div className="flex max-w-[760px] flex-col gap-5">
                        <H1 className="lg:text-[56px]">
                            Start free. Pay for room, not for privacy.
                        </H1>
                        <Lede>
                            Every plan protects your files the same way. Paid plans add space, and
                            nothing else.
                        </Lede>
                    </div>
                </section>
                <section aria-label="Plans" className={container}>
                    <div className="flex flex-col gap-3 pb-8 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                        <SiteSwitch
                            label="Who it is for"
                            value={audience}
                            onChange={setAudience}
                            className="sm:w-fit"
                            options={[
                                { value: 'personal', label: 'Personal' },
                                { value: 'business', label: 'Business' },
                            ]}
                        />
                        {audience === 'personal' && (
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                                {currencies.length > 1 && (
                                    <Select
                                        value={currency}
                                        onValueChange={(value) => {
                                            if (typeof value === 'string' && value !== currency)
                                                void navigate({
                                                    to: '/pricing',
                                                    search: (previous) => ({
                                                        ...previous,
                                                        currency: value,
                                                    }),
                                                    replace: true,
                                                    // Only the prices change; stay where the reader is.
                                                    resetScroll: false,
                                                });
                                        }}
                                        items={currencies.map((code) => ({
                                            value: code,
                                            label: `${code.toUpperCase()} · ${currencyLabel(code)}`,
                                        }))}
                                    >
                                        <SelectTrigger
                                            aria-label="Currency"
                                            className="h-12 w-full sm:w-auto sm:min-w-56"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {currencies.map((code) => (
                                                <SelectItem key={code} value={code}>
                                                    {code.toUpperCase()} · {currencyLabel(code)}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                                <SiteSwitch
                                    label="How often you pay"
                                    value={interval}
                                    onChange={setInterval}
                                    className="sm:w-fit"
                                    options={[
                                        { value: 'month', label: 'Monthly' },
                                        {
                                            value: 'year',
                                            label: (
                                                <>
                                                    Yearly
                                                    <span className="font-semibold text-primary">
                                                        2 months free
                                                    </span>
                                                </>
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                        )}
                    </div>
                    {checkoutError && (
                        <p
                            role="alert"
                            className="mb-4 rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                        >
                            {checkoutError}
                        </p>
                    )}
                    {audience === 'business' ? (
                        <Business />
                    ) : (
                        <div className="flex flex-col gap-10">
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <PlanCard
                                    name="Free"
                                    storage={free}
                                    blurb="To try it, or for the few things that matter most."
                                    price={money(0)}
                                    note="No card needed."
                                    action={
                                        <Link
                                            to={hasSession ? '/app/drive' : '/register'}
                                            aria-disabled={onFree || undefined}
                                            className={buttonVariants({
                                                size: 'lg',
                                                variant: 'outline',
                                                className: cn(
                                                    'w-full',
                                                    onFree && 'pointer-events-none opacity-60',
                                                ),
                                            })}
                                        >
                                            {onFree
                                                ? 'Your plan'
                                                : hasSession
                                                  ? 'Go to Drive'
                                                  : 'Start free'}
                                        </Link>
                                    }
                                />
                                {tiers.map((tier) => {
                                    const plan = tier[interval] ?? tier.month ?? tier.year;
                                    if (!plan) return null;
                                    const yearly = tier.year ? amount(tier.year) : null;
                                    const price = amount(plan);
                                    const current = live?.productId === plan.id;
                                    const label = !hasSession
                                        ? `Start with ${tier.name}`
                                        : current
                                          ? 'Your plan'
                                          : live
                                            ? `Switch to ${tier.name}`
                                            : `Choose ${tier.name}`;
                                    return (
                                        <PlanCard
                                            key={tier.key}
                                            name={tier.name}
                                            storage={formatQuota(tier.quotaBytes)}
                                            blurb={blurbOf(tier.name, tier.description)}
                                            recommended={tier.recommended}
                                            price={`${
                                                plan.interval === 'year'
                                                    ? money(
                                                          Math.round(price.amount / 12),
                                                          price.currency,
                                                      )
                                                    : money(price.amount, price.currency)
                                            } a month`}
                                            note={
                                                plan.interval === 'year'
                                                    ? `Billed ${money(price.amount, price.currency)} yearly.`
                                                    : yearly
                                                      ? `Billed monthly. ${money(yearly.amount, yearly.currency)} a year if you pay yearly.`
                                                      : 'Billed monthly.'
                                            }
                                            action={
                                                onFree ? (
                                                    <Button
                                                        variant={
                                                            tier.recommended ? 'default' : 'outline'
                                                        }
                                                        size="lg"
                                                        className="w-full"
                                                        disabled={starting !== null}
                                                        onClick={() => void startCheckout(plan)}
                                                    >
                                                        {starting === plan.id
                                                            ? 'Opening checkout…'
                                                            : label}
                                                    </Button>
                                                ) : (
                                                    <Link
                                                        to={
                                                            hasSession
                                                                ? '/app/billing'
                                                                : '/register'
                                                        }
                                                        search={{ plan: plan.id }}
                                                        aria-disabled={current || undefined}
                                                        className={buttonVariants({
                                                            size: 'lg',
                                                            variant:
                                                                tier.recommended && !current
                                                                    ? 'default'
                                                                    : 'outline',
                                                            className: cn(
                                                                'w-full',
                                                                current &&
                                                                    'pointer-events-none opacity-60',
                                                            ),
                                                        })}
                                                    >
                                                        {label}
                                                    </Link>
                                                )
                                            }
                                        />
                                    );
                                })}
                            </div>
                            <p className="-mt-4 text-[15px] text-muted-foreground">
                                Prices in {currency.toUpperCase()}. Polar, our merchant of record,
                                adds any tax for your country at checkout.
                                {currency !== detected &&
                                    ' Checkout charges in the currency of the country you are in.'}
                            </p>

                            <div className="flex flex-col gap-4 rounded-xl bg-muted p-6">
                                <h2 className="text-lg font-bold">Every plan, including Free</h2>
                                <ul className="grid gap-x-8 gap-y-3 lg:grid-cols-3">
                                    {included.map((line) => (
                                        <li
                                            key={line}
                                            className="flex gap-2.5 text-[15px] leading-snug"
                                        >
                                            <CheckIcon
                                                className="mt-0.5 size-[18px] shrink-0 text-primary"
                                                strokeWidth={2.6}
                                                aria-hidden="true"
                                            />
                                            {line}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
                                <h2 className="text-lg font-bold">
                                    Invite a friend, both get more space
                                </h2>
                                <p className="text-[15px] leading-relaxed text-muted-foreground">
                                    Every friend who signs up with your link or code gives you both
                                    more room. Find your link under Invite friends once you’re in.
                                </p>
                            </div>
                        </div>
                    )}
                </section>
                <section aria-labelledby="pricing-faq" className="mt-20 border-t border-rule">
                    <div
                        className={cn(
                            container,
                            'grid items-start gap-6 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-20',
                        )}
                    >
                        <H2 id="pricing-faq">Questions</H2>
                        <Faq items={faq} />
                    </div>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}

/* The team plan: coming, not for sale, with what teams can already do beside it. */
function Business() {
    const { data: contact } = useQuery(salesContactQueryOptions);
    return (
        <div className="grid items-start gap-6 lg:grid-cols-[7fr_5fr] lg:gap-10">
            <div className="flex flex-col gap-5 rounded-xl border border-rule bg-card p-7">
                <div className="flex flex-col gap-2">
                    <span className="flex items-baseline gap-2 text-[17px] font-bold">
                        Team
                        <span className="text-[15px] font-semibold text-muted-foreground">
                            · coming soon
                        </span>
                    </span>
                    <span className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] text-balance sm:text-[32px]">
                        For small teams that share folders every day.
                    </span>
                </div>
                <ul className="flex flex-col gap-3">
                    {teamPlanned.map((line) => (
                        <li key={line} className="flex gap-2.5 text-base leading-snug">
                            <CheckIcon
                                className="mt-0.5 size-[18px] shrink-0 text-muted-foreground"
                                strokeWidth={2.4}
                                aria-hidden="true"
                            />
                            {line}
                        </li>
                    ))}
                </ul>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                    {contact
                        ? 'It isn’t for sale yet. Tell us about your team and we’ll write to you when it is.'
                        : 'It isn’t for sale yet. Until it is, share folders with your team on any plan.'}
                </p>
                <TalkToUs className="w-full sm:w-fit" />
            </div>
            <div className="flex flex-col gap-4 pt-1">
                <h2 className="text-lg font-bold">What teams can do today</h2>
                <ul className="flex flex-col">
                    {teamToday.map((line) => (
                        <li
                            key={line}
                            className="border-b border-rule py-3 text-[15px] leading-snug first:pt-0"
                        >
                            {line}
                        </li>
                    ))}
                </ul>
                <TextLink to="/teams">More for teams</TextLink>
            </div>
        </div>
    );
}

function PlanCard({
    name,
    storage,
    blurb,
    price,
    note,
    recommended = false,
    action,
}: {
    name: string;
    storage: string;
    blurb: string | null;
    price: string;
    note: string;
    recommended?: boolean;
    action: React.ReactNode;
}) {
    return (
        <div
            data-plan={name}
            className={cn(
                'flex flex-col gap-5 rounded-xl bg-card p-6',
                recommended ? 'border-2 border-primary shadow-md' : 'border border-rule',
            )}
        >
            <div className="flex flex-1 flex-col gap-2">
                <span className="flex items-center justify-between text-[17px] font-bold">
                    {name}
                    {recommended && (
                        <span className="text-sm font-bold text-primary">Recommended</span>
                    )}
                </span>
                <span className="text-[40px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">
                    {storage}
                </span>
                {blurb && (
                    <span className="text-[15px] leading-snug text-muted-foreground">{blurb}</span>
                )}
            </div>
            <div className="flex flex-col gap-1 border-t border-rule pt-4 tabular-nums">
                <span className="text-[22px] font-bold">{price}</span>
                <span className="min-h-10 text-sm leading-snug text-muted-foreground">{note}</span>
            </div>
            {action}
        </div>
    );
}
