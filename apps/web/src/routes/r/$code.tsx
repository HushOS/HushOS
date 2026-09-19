import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { formatGiB } from '@/lib/format';
import { getReferralLandingServerFn } from '@/lib/growth';
import { publicOrigin } from '@/lib/social';

/*
 * An invite link. It says who invited you and what you both get, and takes you
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
        ],
    }),
    component: InvitePage,
});

function InvitePage() {
    const { landing } = Route.useLoaderData();
    const { code } = Route.useParams();
    const { hasSession } = Route.useRouteContext();
    return (
        <div className="flex min-h-svh flex-col">
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
                                    Private storage for your files, simple to use. Join through this
                                    link and you both get an extra {formatGiB(landing.bonusBytes)}{' '}
                                    of space, on top of what every account starts with. If you ever
                                    take a paid plan, {landing.inviter.split(' ')[0]} gets{' '}
                                    {formatGiB(landing.paidBonusBytes)} more, at no cost to you.
                                </p>
                                <div className="flex flex-wrap gap-3">
                                    {hasSession ? (
                                        <Button
                                            render={<Link to="/app/drive" />}
                                            nativeButton={false}
                                            size="lg"
                                        >
                                            Open Drive <ArrowRightIcon aria-hidden="true" />
                                        </Button>
                                    ) : (
                                        <Button
                                            render={<Link to="/register" search={{ ref: code }} />}
                                            nativeButton={false}
                                            size="lg"
                                        >
                                            Create your account{' '}
                                            <ArrowRightIcon aria-hidden="true" />
                                        </Button>
                                    )}
                                    <Button
                                        render={<Link to="/about" />}
                                        nativeButton={false}
                                        size="lg"
                                        variant="outline"
                                    >
                                        What is HushOS?
                                    </Button>
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
                                    <Button
                                        render={<Link to="/register" />}
                                        nativeButton={false}
                                        size="lg"
                                    >
                                        Create your account <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                    <aside className="sheet px-6 py-6">
                        <p className="eyebrow text-muted-foreground">What you get</p>
                        <dl className="mt-2 text-sm">
                            {[
                                ['Your files', 'Locked on your device'],
                                ['Your password', 'Never sent to us'],
                                [
                                    'Storage',
                                    landing
                                        ? `${formatGiB(landing.freeBytes)} + ${formatGiB(landing.bonusBytes)}`
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
                    </aside>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
