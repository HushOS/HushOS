import type { AffiliateEarningView, ExpectedPayouts, LedgerTotals } from '@hushos/billing/api';

/*
 * The operators' affiliate ledger in the browser: showing its amounts, reading an amount an
 * operator types, and writing the ledger out as a file. The server holds every amount as a whole
 * number of a currency's smallest unit and sends it as a decimal string, so a large total is
 * never rounded on the way, and nothing here passes one through a number either.
 *
 * How many of those units make one of the currency is the currency's own: 100 cents to a dollar,
 * no smaller unit of a yen, 1,000 fils to a Kuwaiti dinar. It is read from Intl, never assumed
 * to be two decimals: 1250 is 12.50 dollars and 1,250 yen.
 */

// As lib/format.ts: one locale on the server and in every browser.
const LOCALE = 'en-US';

/* The decimals a currency's amounts have (2, 0 for the yen, 3 for the dinar); null for a code Intl does not know. */
export function currencyDecimals(currency: string) {
    try {
        return (
            new Intl.NumberFormat(LOCALE, {
                style: 'currency',
                currency: currency.toUpperCase(),
            }).resolvedOptions().maximumFractionDigits ?? null
        );
    } catch {
        return null;
    }
}

/*
 * Minor units as a plain decimal in the currency's own decimals: "1250" is "12.50" in dollars,
 * "1250" in yen, "1.250" in dinars. Exact at any size. A currency Intl does not know is written
 * as the minor units themselves, which is at least what the server holds.
 */
export function minorAsDecimal(amount: string, currency: string) {
    const decimals = currencyDecimals(currency);
    if (!decimals) return amount;
    const digits = amount.padStart(decimals + 1, '0');
    return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/* Minor units, as the server sends them, shown as money; a whole amount drops its decimals, as prices do. */
export function formatMinor(amount: string, currency: string) {
    const decimals = currencyDecimals(currency);
    if (decimals === null) return `${amount} ${currency.toUpperCase()}`;
    const decimal = minorAsDecimal(amount, currency);
    const whole = !decimal.includes('.') || /\.0+$/.test(decimal);
    return new Intl.NumberFormat(LOCALE, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: whole ? 0 : decimals,
        // A decimal string is formatted digit for digit; a number would round a large total.
    }).format(decimal as unknown as number);
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
 * An amount as an operator types it, in the currency's own decimals ("12.50", "12" or "0.5"
 * dollars; "1250" yen), in minor units as the server takes it ("1250", "1200", "50"; "1250").
 * Null for anything else: a sign, more decimals than the currency has (any at all for the yen),
 * letters, a thousands separator, nothing, zero, or a currency Intl does not know. Never rounded:
 * a figure that is not exact is refused.
 */
export function toMinor(text: string, currency: string) {
    const decimals = currencyDecimals(currency);
    if (decimals === null) return null;
    const match = /^([0-9]{1,15})(?:\.([0-9]+))?$/.exec(text.trim());
    if (!match) return null;
    const fraction = match[2] ?? '';
    if (fraction.length > decimals) return null;
    const minor = BigInt(match[1]! + fraction.padEnd(decimals, '0'));
    return minor > 0n ? minor.toString() : null;
}

/* An amount to show as the shape to type: "12.50" where the currency has cents, "1250" where it has none. */
export function exampleAmount(currency: string) {
    return minorAsDecimal('1250', currency);
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
            minorAsDecimal(row.net, row.currency),
            minorAsDecimal(row.pot, row.currency),
            minorAsDecimal(row.left, row.currency),
            row.state,
            row.payableAt,
            row.paidAt,
            row.paid === null ? null : minorAsDecimal(row.paid, row.currency),
            minorAsDecimal(row.refunded, row.currency),
            row.dispute,
            row.flag,
            row.clawback ? minorAsDecimal(row.clawback.amount, row.currency) : null,
            row.clawback ? minorAsDecimal(row.clawback.open, row.currency) : null,
            row.clawback ? minorAsDecimal(row.clawback.settled, row.currency) : null,
            row.clawback ? minorAsDecimal(row.clawback.writtenOff, row.currency) : null,
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
