import type {
    AffiliateEarningView,
    AffiliateLedgerStatus,
    AffiliateView,
    ClawbackSettlement,
} from '@hushos/billing/api';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { Spinner } from '@/components/motion';
import { OperatorTable, td, th } from '@/components/operator';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
    exampleAmount,
    formatMinor,
    ledgerCsv,
    ledgerMoney,
    toMinor,
} from '@/lib/affiliate-ledger';
import { formatDay, formatWhen } from '@/lib/drive';
import { affiliatesQueryOptions } from '@/lib/growth';
import { growthApi } from '@/lib/growth-api';
import { saveBlob } from '@/lib/save-file';

/*
 * The operators' side of commission safety (AFFILIATE_V2_ENABLED): one affiliate's ledger, an
 * earning a row, with what holds each back and what an operator can do about it: void one,
 * release a flag, say yes to a clawback the switch-on made, and settle a clawback by hand. None
 * of it is drawn while the server has the switch off.
 */

export const ledgerStatusQueryOptions = queryOptions({
    queryKey: ['growth', 'affiliate-ledger-status'],
    queryFn: () => growthApi.affiliateLedgerStatus(),
    staleTime: 60_000,
    retry: false,
});

const earningsQueryOptions = (id: string) =>
    queryOptions({
        queryKey: ['growth', 'affiliate-earnings', id],
        queryFn: () => growthApi.affiliateEarnings(id),
        staleTime: 5_000,
        retry: false,
    });

function message(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}

/* How long the daily run may have gone without reading before the page says so. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

/* Whether a daily read is overdue: last done, or never done since the switch, more than two days ago. */
function overdue(readAt: string | null, since: string) {
    return Date.now() - new Date(readAt ?? since).getTime() > STALE_MS;
}

const warning = 'rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive';

/*
 * Above the list: when the daily run last read Polar's disputes and the refunds, and a plain
 * warning when a read failed or has not happened for two days. Commission is only as safe as
 * those reads are recent, so a run that has stopped must not look like one that found nothing.
 */
export function ReadsNotice({ status }: { status: AffiliateLedgerStatus | undefined }) {
    if (!status?.enabled) return null;
    const { disputes, refunds, since } = status;
    const when = (readAt: string | null) =>
        readAt ? formatWhen(readAt, { lower: true }) : 'not yet';
    const warnings = [
        disputes.failure === 'scope'
            ? `Disputes can’t be read: the Polar token has no disputes:read scope. Until it has, a chargeback takes no commission back, and only the ${status.holdDays}-day hold stands in its way.`
            : disputes.failure === 'failed'
              ? 'Disputes couldn’t be read on the last daily run. The next run reads them again.'
              : overdue(disputes.readAt, since)
                ? 'Disputes haven’t been read for more than two days. Check that the worker is running and can reach Polar.'
                : null,
        overdue(refunds.readAt, since)
            ? 'Refunds haven’t all been read for more than two days. Check that the worker is running and that the Polar token has the refunds:read scope. Until they are, a refund lowers commission only when its own delivery arrives.'
            : null,
    ].filter((line): line is string => line !== null);
    return (
        <div className="flex flex-col gap-2">
            {warnings.map((line) => (
                <p key={line} role="alert" className={warning}>
                    {line}
                </p>
            ))}
            <p className="text-[13px] text-muted-foreground">
                Disputes last read {when(disputes.readAt)}. Refunds last read {when(refunds.readAt)}
                .
            </p>
        </div>
    );
}

/* What each currency's next payout comes to, for the question before "Mark paid". */
export function payoutLines(affiliate: AffiliateView) {
    return Object.entries(affiliate.ledger ?? {})
        .filter(([, totals]) => BigInt(totals.payable) > 0n)
        .map(([currency, totals]) =>
            BigInt(totals.netted) > 0n
                ? `${formatMinor(totals.payable, currency)} owed, less ${formatMinor(totals.netted, currency)} taken back: send ${formatMinor(totals.payout, currency)}.`
                : `Send ${formatMinor(totals.payout, currency)}.`,
        );
}

/* An earning's state in words, and what lowered it. */
function describe(row: AffiliateEarningView) {
    const lines: string[] = [];
    if (row.state === 'voided') lines.push(`Voided: ${row.voidReason ?? 'no reason given'}`);
    else if (row.state === 'paid')
        lines.push(
            `Paid ${formatMinor(row.paid ?? '0', row.currency)} on ${formatDay(row.paidAt)}`,
        );
    else if (row.flag === 'self') lines.push('Flagged: their own account bought this');
    else if (row.flag === 'member') lines.push('Flagged: their account is in this company');
    else if (row.flag === 'dispute') lines.push('Waiting for a dispute to close');
    else if (row.state === 'unread')
        lines.push('Held until its order’s refunds are read, by the next daily run');
    else if (row.state === 'held') lines.push(`Held until ${formatDay(row.payableAt)}`);
    else lines.push('Can be paid');
    if (row.dispute === 'lost') lines.push('Dispute lost: nothing is owed');
    else if (row.dispute === 'won') lines.push('Dispute won');
    else if (row.dispute === 'prevented') lines.push('Refunded before a dispute');
    if (BigInt(row.refunded) > 0n)
        lines.push(
            `${formatMinor(row.refunded, row.currency)} of ${formatMinor(row.net, row.currency)} refunded`,
        );
    if (row.clawback) {
        const open = BigInt(row.clawback.open);
        if (open > 0n)
            lines.push(
                row.clawback.confirmed
                    ? `${formatMinor(row.clawback.open, row.currency)} to take back`
                    : `${formatMinor(row.clawback.open, row.currency)} to take back, once you confirm it`,
            );
        else if (BigInt(row.clawback.amount) > 0n) lines.push('Taken back');
        if (open > 0n && BigInt(row.clawback.settled) > 0n)
            lines.push(`${formatMinor(row.clawback.settled, row.currency)} taken back so far`);
        if (BigInt(row.clawback.writtenOff) > 0n)
            lines.push(
                `${formatMinor(row.clawback.writtenOff, row.currency)} written off${row.clawback.note ? `: ${row.clawback.note}` : ''}`,
            );
    }
    return lines;
}

/* Where their money stands, in a sentence that names only what there is. */
function standing(affiliate: AffiliateView) {
    const parts = (
        [
            ['payable', 'Owed'],
            ['held', 'held'],
            ['flagged', 'flagged'],
            ['clawbackOpen', 'to take back'],
            ['clawbackUnconfirmed', 'to take back once you confirm it'],
        ] as const
    )
        .map(([key, label]) => [label, ledgerMoney(affiliate.ledger, key)] as const)
        .filter(([, amount]) => amount !== '–')
        .map(([label, amount]) => `${label} ${amount}`);
    if (!parts.length) return 'Nothing is owed, held or to be taken back.';
    const sentence = parts.join(', ');
    return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

/* A phone's width fits the ledger's four columns only with tighter cells. */
const narrow = 'max-sm:px-1';

type Acting =
    | { kind: 'void'; row: AffiliateEarningView }
    | { kind: 'settle'; row: AffiliateEarningView }
    | null;

export function LedgerDialog({
    affiliate,
    open,
    onOpenChange,
}: {
    affiliate: AffiliateView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const earnings = useQuery({ ...earningsQueryOptions(affiliate.id), enabled: open });
    const [busy, setBusy] = useState<string | null>(null);
    const [acting, setActing] = useState<Acting>(null);
    async function act(row: AffiliateEarningView, run: () => Promise<unknown>, done: string) {
        setBusy(row.id);
        try {
            await run();
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: earningsQueryOptions(affiliate.id).queryKey,
                }),
                queryClient.invalidateQueries({ queryKey: affiliatesQueryOptions.queryKey }),
            ]);
            toast.add({ type: 'success', title: done });
            return true;
        } catch (error) {
            toast.add({ type: 'error', title: 'That didn’t work', description: message(error) });
            return false;
        } finally {
            setBusy(null);
        }
    }
    const rows = earnings.data ?? [];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[920px]">
                <DialogHeader>
                    <DialogTitle>{affiliate.name}: ledger</DialogTitle>
                    <DialogDescription>
                        Every commission recorded for them, newest first. {standing(affiliate)}
                    </DialogDescription>
                </DialogHeader>
                {earnings.isPending ? (
                    <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <Spinner />
                    </div>
                ) : earnings.isError ? (
                    <p
                        role="alert"
                        className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                    >
                        {message(earnings.error)}
                    </p>
                ) : rows.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        No commission has been recorded for them.
                    </p>
                ) : (
                    <OperatorTable>
                        <thead>
                            <tr>
                                <th className={cn(th, narrow)}>Recorded</th>
                                <th className={cn(th, 'max-sm:hidden')}>Order</th>
                                <th className={cn(th, narrow, 'text-right')}>Commission</th>
                                <th className={cn(th, narrow)}>Where it stands</th>
                                <th className={cn(th, narrow)}>
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.id} data-earning={row.orderId} className="align-top">
                                    <td className={cn(td, narrow, 'py-2 whitespace-nowrap')}>
                                        {formatDay(row.recordedAt)}
                                    </td>
                                    <td
                                        className={cn(
                                            td,
                                            narrow,
                                            // On a phone the order is written under the
                                            // state instead, so the row fits without scrolling.
                                            'max-w-[180px] truncate py-2 font-mono text-xs max-sm:hidden',
                                        )}
                                        title={row.orderId}
                                    >
                                        {row.orderId}
                                    </td>
                                    <td
                                        className={cn(
                                            td,
                                            narrow,
                                            'py-2 text-right font-mono whitespace-nowrap tabular-nums',
                                        )}
                                    >
                                        {formatMinor(row.left, row.currency)}
                                        {row.left !== row.pot && (
                                            <span className="block text-xs text-muted-foreground">
                                                of {formatMinor(row.pot, row.currency)}
                                            </span>
                                        )}
                                    </td>
                                    <td className={cn(td, narrow, 'h-auto py-2')}>
                                        {describe(row).map((line) => (
                                            <span key={line} className="block wrap-anywhere">
                                                {line}
                                            </span>
                                        ))}
                                        <span className="block font-mono text-xs wrap-anywhere text-muted-foreground sm:hidden">
                                            {row.orderId}
                                        </span>
                                    </td>
                                    <td
                                        className={cn(
                                            td,
                                            narrow,
                                            'py-1 text-right whitespace-nowrap',
                                        )}
                                    >
                                        <span className="inline-flex gap-1 max-sm:flex-col max-sm:items-end">
                                            {(row.flag === 'self' || row.flag === 'member') && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    disabled={busy === row.id}
                                                    aria-label={`Release the flag on order ${row.orderId}`}
                                                    onClick={() =>
                                                        void act(
                                                            row,
                                                            () =>
                                                                growthApi.releaseAffiliateEarning(
                                                                    affiliate.id,
                                                                    row.id,
                                                                ),
                                                            'Flag released',
                                                        )
                                                    }
                                                >
                                                    Release
                                                </Button>
                                            )}
                                            {row.clawback &&
                                                !row.clawback.confirmed &&
                                                BigInt(row.clawback.open) > 0n && (
                                                    <Button
                                                        variant="ghost"
                                                        size="xs"
                                                        disabled={busy === row.id}
                                                        aria-label={`Confirm taking back ${formatMinor(row.clawback.open, row.currency)} for order ${row.orderId}`}
                                                        onClick={() =>
                                                            void act(
                                                                row,
                                                                () =>
                                                                    growthApi.confirmAffiliateClawback(
                                                                        affiliate.id,
                                                                        row.id,
                                                                    ),
                                                                'Clawback confirmed',
                                                            )
                                                        }
                                                    >
                                                        Confirm
                                                    </Button>
                                                )}
                                            {row.clawback && BigInt(row.clawback.open) > 0n && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    disabled={busy === row.id}
                                                    aria-label={`Settle the clawback for order ${row.orderId}`}
                                                    onClick={() =>
                                                        setActing({ kind: 'settle', row })
                                                    }
                                                >
                                                    Settle
                                                </Button>
                                            )}
                                            {row.state !== 'paid' && row.state !== 'voided' && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                                                    disabled={busy === row.id}
                                                    aria-label={`Void the commission on order ${row.orderId}`}
                                                    onClick={() => setActing({ kind: 'void', row })}
                                                >
                                                    Void
                                                </Button>
                                            )}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </OperatorTable>
                )}
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={rows.length === 0}
                        onClick={() => downloadLedger(affiliate, rows)}
                    >
                        Download ledger
                    </Button>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
                <VoidDialog
                    acting={acting?.kind === 'void' ? acting.row : null}
                    onClose={() => setActing(null)}
                    onVoid={(row, reason) =>
                        act(
                            row,
                            () => growthApi.voidAffiliateEarning(affiliate.id, row.id, reason),
                            'Commission voided',
                        )
                    }
                />
                <SettleDialog
                    acting={acting?.kind === 'settle' ? acting.row : null}
                    onClose={() => setActing(null)}
                    onSettle={(row, input) =>
                        act(
                            row,
                            () => growthApi.settleAffiliateClawback(affiliate.id, row.id, input),
                            input.kind === 'repaid' ? 'Repayment recorded' : 'Clawback written off',
                        )
                    }
                />
            </DialogContent>
        </Dialog>
    );
}

/* The ledger as a file: what "Delete record" saves before it deletes. */
export function downloadLedger(affiliate: AffiliateView, rows: AffiliateEarningView[]) {
    saveBlob(
        new Blob([ledgerCsv(rows)], { type: 'text/csv;charset=utf-8' }),
        `${affiliate.slug}-ledger.csv`,
    );
}

function VoidDialog({
    acting,
    onClose,
    onVoid,
}: {
    acting: AffiliateEarningView | null;
    onClose: () => void;
    onVoid: (row: AffiliateEarningView, reason: string) => Promise<boolean>;
}) {
    const id = useId();
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(false);
    return (
        <AlertDialog
            open={acting !== null}
            onOpenChange={(next) => {
                if (!next && !pending) {
                    setReason('');
                    onClose();
                }
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Void this commission?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {acting
                            ? `${formatMinor(acting.left, acting.currency)} on order ${acting.orderId} will be owed to nobody. This can’t be undone.`
                            : ''}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-reason`} className="text-[13px] font-semibold">
                        Reason
                    </label>
                    <Textarea
                        id={`${id}-reason`}
                        className="min-h-0 resize-y"
                        rows={3}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                    />
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={pending || !reason.trim() || !acting}
                        onClick={() => {
                            if (!acting) return;
                            setPending(true);
                            void onVoid(acting, reason.trim()).then((done) => {
                                setPending(false);
                                if (!done) return;
                                setReason('');
                                onClose();
                            });
                        }}
                    >
                        Void
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

function SettleDialog({
    acting,
    onClose,
    onSettle,
}: {
    acting: AffiliateEarningView | null;
    onClose: () => void;
    onSettle: (row: AffiliateEarningView, input: ClawbackSettlement) => Promise<boolean>;
}) {
    const id = useId();
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const reset = () => {
        setAmount('');
        setNote('');
        setError('');
    };
    async function settle(input: ClawbackSettlement) {
        if (!acting) return;
        setPending(true);
        const done = await onSettle(acting, input);
        setPending(false);
        if (!done) return;
        reset();
        onClose();
    }
    const open = acting?.clawback?.open ?? '0';
    return (
        <AlertDialog
            open={acting !== null}
            onOpenChange={(next) => {
                if (!next && !pending) {
                    reset();
                    onClose();
                }
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Settle this clawback</AlertDialogTitle>
                    <AlertDialogDescription>
                        {acting
                            ? `${formatMinor(open, acting.currency)} is still to be taken back for order ${acting.orderId}. Record what they sent back, or write off what is open. If you do neither, the next payout you mark paid takes it from what they are owed.`
                            : ''}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-amount`} className="text-[13px] font-semibold">
                            Amount repaid{acting ? ` (${acting.currency.toUpperCase()})` : ''}
                        </label>
                        <Input
                            id={`${id}-amount`}
                            className="tabular-nums"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder={acting ? exampleAmount(acting.currency) : undefined}
                            value={amount}
                            onChange={(event) => {
                                setAmount(event.target.value);
                                setError('');
                            }}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? `${id}-error` : undefined}
                        />
                        {error && (
                            <p
                                id={`${id}-error`}
                                role="alert"
                                className="text-[13px] text-destructive"
                            >
                                {error}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-note`} className="text-[13px] font-semibold">
                            Note
                        </label>
                        <Textarea
                            id={`${id}-note`}
                            className="min-h-0 resize-y"
                            rows={2}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            maxLength={500}
                            placeholder="Needed to write it off"
                        />
                    </div>
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending || !note.trim()}
                        onClick={() => void settle({ kind: 'written-off', note: note.trim() })}
                    >
                        Write off
                    </Button>
                    <AlertDialogAction
                        disabled={pending}
                        onClick={() => {
                            const minor = acting ? toMinor(amount, acting.currency) : null;
                            if (!acting || !minor || BigInt(minor) > BigInt(open)) {
                                setError(
                                    `Give an amount above zero, up to what is open, like ${exampleAmount(acting?.currency ?? 'usd')}.`,
                                );
                                return;
                            }
                            void settle({
                                kind: 'repaid',
                                amount: minor,
                                note: note.trim() || null,
                            });
                        }}
                    >
                        Record repayment
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
