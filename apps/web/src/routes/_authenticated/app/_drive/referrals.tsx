import { createFileRoute } from '@tanstack/react-router';
import { CheckIcon, CopyIcon, RotateCcwIcon, Share2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyValue } from '@/components/copy-value';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatQuota, formatMoney } from '@/lib/format';
import { describeCommission, describeDiscount, referralsQueryOptions } from '@/lib/growth';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/referrals')({
    head: () => ({ meta: [{ title: 'Invite friends · HushOS' }] }),
    component: ReferralsPage,
});

/*
 * A person's invite link and what it has earned. Rewards are storage, granted
 * to both sides when someone joins through the link, up to a cap. Nothing
 * about the people who joined is shown beyond the count: who they are is
 * their business.
 */
function ReferralsPage() {
    return (
        <>
            <Referrals />
        </>
    );
}

/*
 * The link is the one thing to do here, so it leads: in a field, with Copy and,
 * where the device can, Share. The code is for people who type it at sign-up.
 */
function InviteLink({ url, code, bonus }: { url: string; code: string; bonus: string }) {
    const [copied, setCopied] = useState(false);
    const [canShare] = useState(() => typeof navigator !== 'undefined' && 'share' in navigator);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 2_000);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        try {
            await navigator.clipboard.writeText(url);
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
        }
    }
    return (
        <div className="flex flex-col gap-3 rounded-2xl bg-muted p-5">
            <label htmlFor="invite-link" className="text-sm font-semibold">
                Your invite link
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                    id="invite-link"
                    readOnly
                    value={url}
                    onFocus={(event) => event.currentTarget.select()}
                    className="bg-card font-mono text-[15px]"
                />
                <div className="flex shrink-0 gap-2">
                    <Button size="lg" className="flex-1 sm:flex-none" onClick={() => void copy()}>
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        {copied ? 'Copied' : 'Copy link'}
                    </Button>
                    {canShare && (
                        <Button
                            variant="outline"
                            size="lg"
                            className="flex-1 bg-card sm:flex-none"
                            onClick={() =>
                                void navigator
                                    .share({
                                        title: 'Join me on HushOS',
                                        text: `We both get ${bonus} more space when you join.`,
                                        url,
                                    })
                                    .catch(() => {})
                            }
                        >
                            <Share2Icon />
                            Share
                        </Button>
                    )}
                </div>
            </div>
            <p className="text-sm text-muted-foreground">
                Or they can type your code{' '}
                <span className="font-mono font-semibold text-foreground">
                    <CopyValue value={code} label="Invite code" />
                </span>{' '}
                when they create an account.
            </p>
        </div>
    );
}

/* Earned so far against the most this kind of invite can earn. */
function Earned({
    kind,
    title,
    earned,
    cap,
    line,
}: {
    kind: string;
    title: string;
    earned: string;
    cap: string;
    line: string;
}) {
    const share = Number(cap) > 0 ? Math.min(1, Number(earned) / Number(cap)) : 0;
    return (
        <div data-earned={kind} className="flex flex-col gap-2 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="text-[15px] font-semibold">{title}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                    <span className="font-semibold text-foreground">{formatQuota(earned)}</span> of{' '}
                    {formatQuota(cap)}
                </span>
            </div>
            <meter
                min={0}
                max={1}
                value={share}
                aria-label={`${title}: ${formatQuota(earned)} of ${formatQuota(cap)}`}
                className="sr-only"
            />
            <span aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-rule">
                <span
                    className="rounded-full bg-primary"
                    style={{ width: share > 0 ? `${Math.max(2, share * 100)}%` : '0%' }}
                />
            </span>
            <span className="text-[13px] text-muted-foreground">{line}</span>
        </div>
    );
}

function Referrals() {
    const summary = useQuery(referralsQueryOptions);
    if (summary.isPending)
        return (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Spinner />
            </div>
        );
    if (summary.isError || !summary.data)
        return (
            <div className="flex flex-col">
                <PageHeader title="Invite friends" />
                <div className="flex flex-col items-start gap-3 px-5 sm:px-8">
                    <p role="alert" className="text-[15px]">
                        Your invite didn’t load.
                    </p>
                    <Button variant="outline" onClick={() => void summary.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </div>
            </div>
        );
    const data = summary.data;
    const bonus = formatQuota(data.signup.bonusBytes);
    const paidBonus = formatQuota(data.paid.bonusBytes);
    const people = (n: number) => (n === 1 ? '1 friend' : `${n} friends`);
    return (
        <div className="flex flex-1 flex-col pb-10">
            <PageHeader
                title="Invite friends"
                description={`Give ${bonus}, get ${bonus}. When a friend joins with your link, you both get ${bonus} more space.`}
            />
            <div className="flex max-w-2xl flex-col gap-8 px-5 sm:px-8">
                <InviteLink url={data.url} code={data.code} bonus={bonus} />

                <section aria-labelledby="earned-title" className="flex flex-col">
                    <h2 id="earned-title" className="border-b border-rule pb-3 text-lg font-bold">
                        What you’ve earned
                    </h2>
                    <div className="divide-y divide-rule">
                        <Earned
                            kind="signup"
                            title="Friends who joined"
                            earned={data.signup.bytes}
                            cap={data.signup.capBytes}
                            line={`${people(data.joined)} joined through you · ${bonus} each`}
                        />
                        <Earned
                            kind="paid"
                            title="Friends who took a plan"
                            earned={data.paid.bytes}
                            cap={data.paid.capBytes}
                            line={`${people(data.paid.count)} went paid · ${paidBonus} more each`}
                        />
                    </div>
                    <p className="text-[13px] text-muted-foreground">
                        Space you earn stays as long as both accounts exist. You see how many
                        joined, never who they are or their files.
                    </p>
                </section>

                {data.affiliate && (
                    <section aria-labelledby="creator-title" className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 border-b border-rule pb-3">
                            <h2 id="creator-title" className="text-lg font-bold">
                                Your creator code
                            </h2>
                            <Badge variant="secondary">
                                {data.affiliate.active ? 'Active' : 'Paused'}
                            </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                            People who sign up through your page get{' '}
                            {describeDiscount(data.affiliate)}, and you earn{' '}
                            {describeCommission(data.affiliate.commissionBps)} of what they pay.
                            HushOS pays out what’s owed.
                        </p>
                        <dl className="divide-y divide-rule rounded-xl border border-rule px-4">
                            <Fact label="Your page">
                                <CopyValue value={data.affiliate.url} label="Affiliate link" wrap />
                            </Fact>
                            <Fact label="Code">
                                <CopyValue value={data.affiliate.code} label="Affiliate code" />
                            </Fact>
                            <Fact label="Sign-ups">{data.affiliate.stats.signups}</Fact>
                            <Fact label="Paid orders">{data.affiliate.stats.orders}</Fact>
                            <Fact label="Owed to you">
                                {money(data.affiliate.stats.earnings, 'unpaid')}
                            </Fact>
                            <Fact label="Paid out">
                                {money(data.affiliate.stats.earnings, 'paid')}
                            </Fact>
                        </dl>
                    </section>
                )}
            </div>
        </div>
    );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 font-medium tabular-nums wrap-anywhere">{children}</dd>
        </div>
    );
}

/* Totals per currency on one line: "$12.00 · ₹900.00", or a dash when nothing. */
export function money(
    earnings: Record<string, { unpaid: number; paid: number }>,
    side: 'unpaid' | 'paid',
) {
    const parts = Object.entries(earnings)
        .filter(([, totals]) => totals[side] > 0)
        .map(([currency, totals]) => formatMoney(totals[side], currency));
    return parts.length ? parts.join(' · ') : '–';
}
