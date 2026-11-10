import type { AffiliateEarningView, ExpectedPayouts, LedgerTotals } from '@hushos/billing/api';
import { formatMoney } from '@/lib/format';

/*
 * The operators' affiliate ledger in the browser: showing its amounts, reading an amount an
 * operator types, and writing the ledger out as a file. The server holds every amount as a whole
 * number of minor units and sends it as a decimal string, so a large total is never rounded on
 * the way; only what is drawn on screen passes through a number here.
 */

/* Minor units, as the server sends them, shown as money. */
export function formatMinor(amount: string, currency: string) {
    return formatMoney(Number(amount), currency);
}

/* One of a ledger's totals in every currency that has any: "$12.00 · ₹900.00", or a dash for none. */
export function ledgerMoney(
    ledger: Record<string, LedgerTotals> | undefined,
    key: keyof LedgerTotals,
) {
    const parts = Object.entries(ledger ?? {})
        .filter(([, totals]) => BigInt(totals[key]) > 0n)
        .map(([currency, totals]) => formatMinor(totals[key], currency));
    return parts.length ? parts.join(' · ') : '–';
}

/* What the page shows as the next payout, sent back with "Mark paid" so a ledger that moved since is not marked. */
export function expectedPayouts(ledger: Record<string, LedgerTotals> | undefined) {
    const expected: ExpectedPayouts = {};
    for (const [currency, totals] of Object.entries(ledger ?? {}))
        if (BigInt(totals.payable) > 0n)
            expected[currency] = { owed: totals.payable, netted: totals.netted };
    return expected;
}

/*
 * An amount as an operator types it ("12.50", "12", "0.5"), in minor units as the server takes
 * it ("1250", "1200", "50"). Null for anything else: a sign, a third decimal, letters, a
 * thousands separator, nothing, or zero. Never rounded: a figure that is not exact is refused.
 */
export function toMinor(text: string) {
    const match = /^([0-9]{1,15})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
    if (!match) return null;
    const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
    return minor > 0n ? minor.toString() : null;
}

/* Minor units as a plain decimal for a spreadsheet: "1250" is "12.50". Exact at any size. */
export function minorAsDecimal(amount: string) {
    const digits = amount.padStart(3, '0');
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/*
 * A cell, quoted. One that a spreadsheet would run as a formula (it starts with =, +, - or @, or
 * a tab or return) is written as text: a void reason or a note is whatever someone typed. A date
 * is written as its ISO string: the API client hands a date back as a Date, whatever its type says.
 */
function cell(value: string | Date | null) {
    const text = value instanceof Date ? value.toISOString() : (value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
}

const COLUMNS = [
    'Recorded',
    'Order',
    'Customer account',
    'Currency',
    'Order net',
    'Commission recorded',
    'Commission left',
    'State',
    'Payable from',
    'Paid on',
    'Paid',
    'Refunded',
    'Dispute',
    'Flag',
    'To take back',
    'Still open',
    'Taken back',
    'Written off',
    'Awaiting confirmation',
    'Clawback note',
    'Voided on',
    'Void reason',
] as const;

/* The whole ledger as CSV, a row an earning, newest first as the page lists them. */
export function ledgerCsv(rows: AffiliateEarningView[]) {
    const lines = rows.map((row) =>
        [
            row.recordedAt,
            row.orderId,
            row.userId,
            row.currency.toUpperCase(),
            minorAsDecimal(row.net),
            minorAsDecimal(row.pot),
            minorAsDecimal(row.left),
            row.state,
            row.payableAt,
            row.paidAt,
            row.paid === null ? null : minorAsDecimal(row.paid),
            minorAsDecimal(row.refunded),
            row.dispute,
            row.flag,
            row.clawback ? minorAsDecimal(row.clawback.amount) : null,
            row.clawback ? minorAsDecimal(row.clawback.open) : null,
            row.clawback ? minorAsDecimal(row.clawback.settled) : null,
            row.clawback ? minorAsDecimal(row.clawback.writtenOff) : null,
            row.clawback ? (row.clawback.confirmed ? 'no' : 'yes') : null,
            row.clawback?.note ?? null,
            row.voidedAt,
            row.voidReason,
        ]
            .map(cell)
            .join(','),
    );
    return [COLUMNS.map(cell).join(','), ...lines].join('\r\n');
}
