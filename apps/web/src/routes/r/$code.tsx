import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon, PlusIcon } from 'lucide-react';
import { DitherMark } from '@/components/dither-mark';
import { SitePage } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { buttonVariants } from '@/components/ui/button';
import { formatQuota } from '@/lib/format';
import { getReferralLandingServerFn } from '@/lib/growth';
import { cardMeta, publicOrigin } from '@/lib/social';

/*
 * An invite link. It says who invited you and what you get, and takes you
 * to sign-up with the code attached. Nothing about the inviter beyond their
 * name is shown, and an invite that no longer resolves says so plainly.
 */
export const Route = createFileRoute('/r/$code')({
    loader: async ({ params }) => ({
        origin: publicOrigin(),
        landing: await getReferralLandingServerFn({ data: { code: params.code } }),
    }),
    headers: () => ({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }),
    head: ({ loaderData }) => ({
        meta: [
            {
                title: loaderData?.landing
                    ? `${loaderData.landing.inviter} invited you to HushOS`
                    : 'Invite · HushOS',
            },
            { name: 'robots', content: 'noindex' },
            { name: 'referrer', content: 'no-referrer' },
            // One card for every invite: it names nobody, so a pasted link shows no one's name in its picture.
            ...(loaderData?.landing
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'invite',
                      title: 'You’re invited to HushOS',
                      description:
                          // A server can give no bonus at all; then the preview promises none.
                          Number(loaderData.landing.bonusBytes) > 0
                              ? 'Join through this link for extra space. Private storage, simple to use.'
                              : 'Join HushOS through this link. Private storage, simple to use.',
                  })
                : []),
        ],
    }),
    component: InvitePage,
});

function InvitePage() {
    const { landing } = Route.useLoaderData();
    const { code } = Route.useParams();
    const { hasSession } = Route.useRouteContext();
    const bonus = Number(landing?.bonusBytes ?? 0);
    const paidBonus = Number(landing?.paidBonusBytes ?? 0);
    return (
        <SitePage identity="invite">
            <SiteHeader />
            <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-12 sm:px-8 sm:py-20">
                <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
                    <div className="flex flex-col gap-6">
                        {landing ? (
                            <>
                                <p className="eyebrow text-muted-foreground">An invitation</p>
                                <h1 className="max-w-3xl text-5xl font-bold tracking-tight text-balance sm:text-6xl">
                                    {landing.inviter} invited you to HushOS.
                                </h1>
                                <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                                    Private storage for your files, simple to use.
                                    {/* A server can turn either reward off; then the page does not promise it. */}
                                    {bonus > 0 &&
                                        ` Join through this link and you get an extra ${formatQuota(bonus, 'en-GB')} of space, on top of what every account starts with, and ${landing.inviter.split(' ')[0]} gets the same, up to a limit.`}
                                    {paidBonus > 0 &&
                                        ` If you ever take a paid plan, ${landing.inviter.split(' ')[0]} gets ${formatQuota(paidBonus, 'en-GB')} more, at no cost to you.`}
                                </p>
                                <div className="flex flex-wrap gap-3">
                                    {hasSession ? (
                                        <Link
                                            to="/app/drive"
                                            className={buttonVariants({ size: 'lg' })}
                                        >
                                            Open Drive <ArrowRightIcon aria-hidden="true" />
                                        </Link>
                                    ) : (
                                        <Link
                                            to="/register"
                                            search={{ ref: code }}
                                            className={buttonVariants({ size: 'lg' })}
                                        >
                                            Create your account{' '}
                                            <ArrowRightIcon aria-hidden="true" />
                                        </Link>
                                    )}
                                    <Link
                                        to="/about"
                                        className={buttonVariants({
                                            size: 'lg',
                                            variant: 'outline',
                                        })}
                                    >
                                        What is HushOS?
                                    </Link>
                                </div>
                                {hasSession && (
                                    <p className="text-sm text-muted-foreground">
                                        You already have an account, so this invite is for someone
                                        else. Your own link is under Invite friends in Drive.
                                    </p>
                                )}
                            </>
                        ) : (
                            <>
                                <p className="eyebrow text-muted-foreground">An invitation</p>
                                <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                                    This invite link is not valid any more.
                                </h1>
                                <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                                    It may have been typed wrong, or the account behind it is gone.
                                    You can still create an account the ordinary way.
                                </p>
                                <div>
                                    <Link to="/register" className={buttonVariants({ size: 'lg' })}>
                                        Create your account <ArrowRightIcon aria-hidden="true" />
                                    </Link>
                                </div>
                            </>
                        )}
                    </div>
                    <aside className="overflow-hidden rounded-xl border border-rule bg-[var(--id-raised,var(--card))]">
                        {landing && (
                            // The inviter, and a seat kept for you: decoration, the sentence beside it says it all.
                            <div
                                aria-hidden="true"
                                className="flex flex-col items-center gap-4 border-b border-rule bg-muted px-6 pt-8 pb-6"
                            >
                                <div className="flex items-center gap-3">
                                    <DitherMark
                                        name={landing.inviter}
                                        size={64}
                                        className="rounded-full"
                                    />
                                    <PlusIcon className="size-5 text-muted-foreground" />
                                    <span className="invite-seat grid size-16 place-items-center rounded-full text-sm font-semibold">
                                        You
                                    </span>
                                </div>
                                {bonus > 0 && (
                                    <p className="text-2xl font-extrabold tracking-[-0.02em] tabular-nums">
                                        +{formatQuota(bonus, 'en-GB')} for you
                                    </p>
                                )}
                            </div>
                        )}
                        <div className="px-6 py-6">
                            <p className="eyebrow text-muted-foreground">What you get</p>
                            <dl className="mt-2 text-sm">
                                {[
                                    ['Your files', 'Locked on your device'],
                                    ['Your password', 'Never sent to us'],
                                    [
                                        'Storage',
                                        landing
                                            ? bonus > 0
                                                ? `${formatQuota(landing.freeBytes, 'en-GB')} + ${formatQuota(bonus, 'en-GB')}`
                                                : formatQuota(landing.freeBytes, 'en-GB')
                                            : 'Free to start',
                                    ],
                                    ['Sharing', 'With people, or by link'],
                                    ['Cost', 'Free to start'],
                                ].map(([key, value]) => (
                                    <div
                                        key={key}
                                        className="flex justify-between gap-6 border-b border-dotted border-rule py-2.5 last:border-b-0"
                                    >
                                        <dt className="text-muted-foreground">{key}</dt>
                                        <dd className="text-right">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    </aside>
                </section>
            </main>
            <SiteFooter />
        </SitePage>
    );
}
