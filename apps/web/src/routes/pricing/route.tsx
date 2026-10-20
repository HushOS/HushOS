import { FitPlanner } from '@/components/fit-planner';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import {
    container,
    Faq,
    H1,
    H2,
    Lede,
    SitePage,
    SiteSwitch,
    TalkToUs,
    TextLink,
} from '@/components/site';
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
import { faqFor } from '@/lib/pricing-faq';
import { activeFamily, familiesQueryOptions } from '@/lib/families-shell';
import { rememberReturn } from '@/lib/return-to';
import { sessionQueryOptions } from '@/lib/session';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatMoney,
    formatQuota,
    localeHintQueryOptions,
} from '@/lib/queries';
import { publicOrigin, salesContactQueryOptions } from '@/lib/social';
import type { Catalogue, Plan } from '@hushos/billing/api';
import {
    currenciesOf,
    FAMILY_POOL_LINE,
    familyOffers,
    familyPairs,
    personalPairs,
    priceOf,
    pricingLede,
    TAX_LINE,
    tiersOf,
    twoMonthsFree,
    yearlyPrice,
    yearsByMonth,
    type FamilyOffer,
    type Tier,
} from '@/lib/plans';
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
        const faq = faqFor(
            familyOffers(catalogue, 'month', currency),
            currency,
            savesTwoMonths(catalogue, currency),
        );
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

/* "2 months free", for the toggle and the questions: true of every personal and family plan here. */
const savesTwoMonths = (catalogue: Pick<Catalogue, 'plans' | 'families'>, currency: string) =>
    twoMonthsFree([
        ...personalPairs(catalogue.plans, currency),
        ...familyPairs(catalogue.families, currency),
    ]);

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
/* Where a plan's button sits: on its card, or under the planner's answer. */
type Place = 'card' | 'planner';
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
    // Every year by its month, or every year by the year, across both rows of cards.
    const byMonth = yearsByMonth(catalogue, currency);
    // "2 months free" beside Yearly only while it is true of every plan in this currency.
    const saving = savesTwoMonths(catalogue, currency);
    // Only where the server serves families and sells plans: it lists none otherwise.
    const family = familyOffers(catalogue, interval, currency, byMonth);
    const questions = faqFor(familyOffers(catalogue, 'month', currency), currency, saving);
    // Signed in: the buttons say where this person stands rather than "start".
    const { data: summary } = useQuery({ ...billingQueryOptions, enabled: hasSession });
    const live =
        summary?.subscription && !summary.subscription.endedAt ? summary.subscription : null;
    const onFree = hasSession && summary !== undefined && !live;
    // Signed in and not yet paying: the button starts Polar's checkout itself, no stop
    // on the billing page. Paying subscribers go there for the confirmation step.
    const [starting, setStarting] = useState<string | null>(null);
    const [checkoutError, setCheckoutError] = useState('');
    // Where the checkout was started, so a failure shows beside the button that was pressed.
    const [startedFrom, setStartedFrom] = useState<Place>('card');
    // The tier whose checkout failed, so the planner shows the error only while it names that tier.
    const [failedTier, setFailedTier] = useState<string | null>(null);
    // Back from Polar's checkout restores this page with `starting` still set.
    usePageRestored(() => {
        setStarting(null);
        setCheckoutError('');
        setFailedTier(null);
        setStartedFrom('card');
    });
    async function startCheckout(plan: Plan, place: Place, tierKey: string) {
        setStarting(plan.id);
        setStartedFrom(place);
        setFailedTier(null);
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
            setFailedTier(tierKey);
            setStarting(null);
        }
    }
    /*
     * What choosing a plan does, the same from its card and from the planner's
     * answer: Free (null) or a tier, priced at the interval chosen above. On a
     * card the recommended plan leads; in the planner the plan it names does.
     */
    function planAction(tier: Tier | null, place: Place) {
        const size = 'lg' as const;
        const width = place === 'card' ? 'w-full' : 'w-full sm:w-fit';
        // The plan already held is a disabled button, not a link that still follows on Enter.
        const held = (
            <Button variant="outline" size={size} className={width} disabled>
                Your plan
            </Button>
        );
        if (!tier) {
            if (onFree) return held;
            return (
                <Link
                    to={hasSession ? '/app/drive' : '/register'}
                    className={buttonVariants({
                        size,
                        // Primary in the planner only for a newcomer; a subscriber is not sold Free.
                        variant: place === 'planner' && !hasSession ? 'default' : 'outline',
                        className: width,
                    })}
                >
                    {hasSession ? 'Go to Drive' : 'Start free'}
                </Link>
            );
        }
        const plan = tier[interval] ?? tier.month ?? tier.year;
        if (!plan) return null;
        if (live?.productId === plan.id) return held;
        /*
         * On a card the recommended plan leads. Under the planner its answer leads too,
         * except when that answer is the recommended plan: its card already has the blue
         * button, and the two can be on screen together. A subscriber is never led.
         */
        const lead = place === 'planner' ? !live && !tier.recommended : tier.recommended;
        const label = !hasSession
            ? `Start with ${tier.name}`
            : live
              ? `Switch to ${tier.name}`
              : `Choose ${tier.name}`;
        return onFree ? (
            <Button
                variant={lead ? 'default' : 'outline'}
                size={size}
                className={width}
                disabled={starting !== null}
                onClick={() => void startCheckout(plan, place, tier.key)}
            >
                {starting === plan.id && startedFrom === place ? 'Opening checkout…' : label}
            </Button>
        ) : (
            <Link
                to={hasSession ? '/app/billing' : '/register'}
                search={{ plan: plan.id }}
                className={buttonVariants({
                    size,
                    variant: lead ? 'default' : 'outline',
                    className: width,
                })}
            >
                {label}
            </Link>
        );
    }
    /* What the planner's button will charge, at the interval chosen above the cards. */
    function priceNote(tier: Tier | null) {
        // Free's note is for a newcomer; to a subscriber it would read as a pitch to downgrade.
        if (!tier) return hasSession ? '' : 'No card needed.';
        const plan = tier[interval] ?? tier.month ?? tier.year;
        if (!plan) return '';
        const price = amount(plan);
        return plan.interval === 'year'
            ? yearlyPrice(price.amount, price.currency, byMonth).line
            : `${money(price.amount, price.currency)} a month, billed monthly.`;
    }
    return (
        <SitePage identity="pricing">
            <SiteHeader />
            <main className="flex-1">
                <section className={cn(container, 'pt-10 pb-8 lg:pt-20 lg:pb-10')}>
                    <div className="flex max-w-[760px] flex-col gap-5">
                        <H1 className="lg:text-[56px]">
                            Start free. Pay for room, not for privacy.
                        </H1>
                        <Lede>{pricingLede(family)}</Lede>
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
                                                    {saving && (
                                                        <span className="font-semibold text-primary">
                                                            2 months free
                                                        </span>
                                                    )}
                                                </>
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                        )}
                    </div>
                    {checkoutError && startedFrom === 'card' && (
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
                                    action={planAction(null, 'card')}
                                />
                                {tiers.map((tier) => {
                                    const plan = tier[interval] ?? tier.month ?? tier.year;
                                    if (!plan) return null;
                                    const yearly = tier.year ? amount(tier.year) : null;
                                    const price = amount(plan);
                                    const byYear =
                                        plan.interval === 'year'
                                            ? yearlyPrice(price.amount, price.currency, byMonth)
                                            : null;
                                    return (
                                        <PlanCard
                                            key={tier.key}
                                            name={tier.name}
                                            storage={formatQuota(tier.quotaBytes)}
                                            blurb={blurbOf(tier.name, tier.description)}
                                            recommended={tier.recommended}
                                            price={
                                                byYear
                                                    ? byYear.price
                                                    : `${money(price.amount, price.currency)} a month`
                                            }
                                            note={
                                                byYear
                                                    ? byYear.billed
                                                    : yearly
                                                      ? `Billed monthly. ${money(yearly.amount, yearly.currency)} a year if you pay yearly.`
                                                      : 'Billed monthly.'
                                            }
                                            action={planAction(tier, 'card')}
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
                            {family.length > 0 && (
                                <FamilySection offers={family} hasSession={hasSession} />
                            )}

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
                {audience === 'personal' && (
                    <div className={container}>
                        <FitPlanner
                            plans={[
                                {
                                    key: 'free',
                                    name: 'Free',
                                    quotaBytes: Number(catalogue.freeQuotaBytes),
                                    action: planAction(null, 'planner'),
                                    note: priceNote(null),
                                },
                                ...tiers.map((tier) => ({
                                    key: tier.key,
                                    name: tier.name,
                                    quotaBytes: Number(tier.quotaBytes),
                                    action: planAction(tier, 'planner'),
                                    note: priceNote(tier),
                                })),
                            ]}
                            error={
                                startedFrom === 'planner' && failedTier && checkoutError
                                    ? { key: failedTier, message: checkoutError }
                                    : null
                            }
                        />
                    </div>
                )}
                <section aria-labelledby="pricing-faq" className="mt-20 border-t border-rule">
                    <div
                        className={cn(
                            container,
                            'grid items-start gap-6 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-20',
                        )}
                    >
                        <H2 id="pricing-faq">Questions</H2>
                        <Faq items={questions} />
                    </div>
                </section>
            </main>
            <SiteFooter />
        </SitePage>
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

/*
 * The family section's button. Create a family is offered only to someone in no family (one
 * per account), and leads to Plans (/app/billing), where the family tiers sit beside the
 * personal plans, each creating a family and going to its checkout
 * (docs/families-shared-pool.md 7.4); signed out, it signs up first and lands there. Someone
 * already in a family opens theirs instead.
 * Nothing shows until that is known, so the button never offers what the server would refuse;
 * if the families can't be read, it opens /app/family, which shows whichever is true. A
 * session cookie that turns out to have expired (no account behind it) is treated as signed out.
 */
function FamilyAction({ hasSession }: { hasSession: boolean }) {
    const session = useQuery({ ...sessionQueryOptions, enabled: hasSession });
    const userId = session.data?.id;
    const families = useQuery({ ...familiesQueryOptions(userId ?? ''), enabled: Boolean(userId) });
    const className = buttonVariants({ size: 'lg', className: 'w-full shrink-0 lg:w-fit' });
    const signedOut = !hasSession || (session.isSuccess && !session.data);
    if (signedOut)
        return (
            <Link
                to="/register"
                onClick={() => rememberReturn('/app/billing')}
                className={className}
            >
                Create a family
            </Link>
        );
    if (session.isError || families.isError)
        return (
            <Link to="/app/family" className={className}>
                Family
            </Link>
        );
    if (!userId || families.isPending) return null;
    const yours = activeFamily(families.data);
    return yours ? (
        <Link to="/app/family" className={className}>
            Open {yours.name}
        </Link>
    ) : (
        <Link to="/app/billing" className={className}>
            Create a family
        </Link>
    );
}

function FamilySection({ offers, hasSession }: { offers: FamilyOffer[]; hasSession: boolean }) {
    // The same on every tier (a tier change keeps the family's places), as the questions say too.
    const { includedMembers, maxMembers } = offers[0]!.plan;
    return (
        <section
            aria-labelledby="family-plan"
            data-family-plan
            className="flex flex-col gap-6 rounded-xl border border-rule bg-card p-6 lg:p-7"
        >
            <div className="flex flex-col gap-3">
                <h2 id="family-plan" className="text-[17px] font-bold">
                    Family
                </h2>
                {/* The button sits level with the headline's first line on a wide screen, under the words on a phone. */}
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
                    <div className="flex flex-col gap-3">
                        <p className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] text-balance sm:text-[32px]">
                            Family folders for up to {maxMembers} people.
                        </p>
                        <p className="max-w-[40em] text-base leading-relaxed">
                            Each plan includes {includedMembers} members, and every member can open
                            the folders. {FAMILY_POOL_LINE}
                        </p>
                    </div>
                    <FamilyAction hasSession={hasSession} />
                </div>
            </div>
            <ul className="grid gap-4 lg:grid-cols-3">
                {offers.map((offer) => (
                    <li
                        key={offer.plan.id}
                        data-family-tier={offer.plan.tier ?? offer.plan.id}
                        className="flex flex-col gap-4 rounded-lg border border-rule p-5"
                    >
                        <div className="flex flex-col gap-2">
                            <span className="text-[17px] font-bold">{offer.name}</span>
                            <span className="text-[32px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">
                                {offer.storage}
                            </span>
                        </div>
                        <div className="flex flex-col gap-1 border-t border-rule pt-4 tabular-nums">
                            <span className="text-[22px] font-bold">{offer.price}</span>
                            <span className="text-sm leading-snug text-muted-foreground">
                                {offer.billed}
                            </span>
                            {offer.extra && (
                                <span className="text-sm leading-snug text-muted-foreground">
                                    {offer.extra}
                                </span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
            <p className="text-sm text-muted-foreground">
                {TAX_LINE} Family folders are on the web for now.
            </p>
        </section>
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
