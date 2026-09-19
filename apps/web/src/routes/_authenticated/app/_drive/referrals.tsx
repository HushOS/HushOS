import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CopyValue } from '@/components/copy-value';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatGiB, formatMoney } from '@/lib/format';
import { describeCommission, describeDiscount, referralsQueryOptions } from '@/lib/growth';

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

const box = 'divide-y divide-rule rounded-md border border-rule';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
            <span className="eyebrow text-muted-foreground">{label}</span>
            <div className="min-w-0 text-sm">{children}</div>
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
            <div className="px-5 py-6 sm:px-8">
                <Alert variant="destructive">
                    <AlertTitle>Your invite could not be loaded</AlertTitle>
                    <AlertDescription>
                        {summary.error instanceof Error
                            ? summary.error.message
                            : 'Please try again.'}
                    </AlertDescription>
                </Alert>
            </div>
        );
    const data = summary.data;
    const bonus = formatGiB(data.signup.bonusBytes);
    const paidBonus = formatGiB(data.paid.bonusBytes);
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Invite friends"
                title={`Give ${bonus}, get ${bonus}.`}
                description={`Anyone who joins HushOS through your link gets an extra ${bonus} of space, and so do you, up to ${formatGiB(data.signup.capBytes)} in total. When someone you invited takes a paid plan, you get ${paidBonus} more, up to ${formatGiB(data.paid.capBytes)}. Their files stay theirs; you only see how many joined.`}
            />
            <div className="flex max-w-4xl flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
                <section className={`${box} bg-muted`}>
                    <Row label="Your link">
                        <CopyValue value={data.url} label="Copy invite link" wrap />
                    </Row>
                    <Row label="Your code">
                        <CopyValue value={data.code} label="Copy invite code" />
                    </Row>
                </section>
                <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Stat label="Joined through you" value={String(data.joined)} />
                    <Stat
                        label="From sign-ups"
                        value={`${formatGiB(data.signup.bytes)} of ${formatGiB(data.signup.capBytes)}`}
                    />
                    <Stat label="Went paid" value={String(data.paid.count)} />
                    <Stat
                        label="From paid invites"
                        value={`${formatGiB(data.paid.bytes)} of ${formatGiB(data.paid.capBytes)}`}
                    />
                </section>
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    Send the link, or tell someone the code to type when they create an account. The
                    extra space appears on both accounts the moment theirs is set up, and yours
                    grows again the first time they pay for a plan. Space earned this way stays as
                    long as both accounts exist.
                </p>

                {data.affiliate && (
                    <section className="flex flex-col gap-4">
                        <div>
                            <h2 className="text-lg font-bold">Your affiliate code</h2>
                            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                                You are enrolled as a creator. People who sign up through your page
                                get {describeDiscount(data.affiliate)}, and you earn{' '}
                                {describeCommission(data.affiliate.commissionBps)} of what they pay.
                                Earnings are paid out by the operators; what is owed and what has
                                been paid is shown here.
                            </p>
                        </div>
                        <div className={box}>
                            <Row label="Your page">
                                <CopyValue
                                    value={data.affiliate.url}
                                    label="Copy affiliate link"
                                    wrap
                                />
                            </Row>
                            <Row label="Code">
                                <CopyValue
                                    value={data.affiliate.code}
                                    label="Copy affiliate code"
                                />
                            </Row>
                            <Row label="Status">
                                {data.affiliate.active ? 'Active' : 'Paused by the operators'}
                            </Row>
                        </div>
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <Stat label="Sign-ups" value={String(data.affiliate.stats.signups)} />
                            <Stat label="Paid orders" value={String(data.affiliate.stats.orders)} />
                            <Stat
                                label="Owed to you"
                                value={money(data.affiliate.stats.earnings, 'unpaid')}
                            />
                            <Stat
                                label="Paid out"
                                value={money(data.affiliate.stats.earnings, 'paid')}
                            />
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col-reverse justify-end gap-1.5 rounded-md border border-rule px-4 py-3.5">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span
                className={`font-bold tracking-tight tabular-nums ${value.length > 8 ? 'text-xl' : 'text-3xl'}`}
            >
                {value}
            </span>
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
