import type { AffiliateEarningView, LedgerTotals } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    currencyDecimals,
    exampleAmount,
    expectedPayouts,
    formatMinor,
    ledgerCsv,
    ledgerMoney,
    minorAsDecimal,
    toMinor,
} from './affiliate-ledger';

/*
 * What an operator types and downloads on the affiliate ledger. An amount repaid is typed in
 * major units and sent in minor ones: a figure read wrongly here settles the wrong amount of a
 * clawback. The download is what "Delete record" leaves behind of a ledger.
 */

const totals = (patch: Partial<LedgerTotals>): LedgerTotals => ({
    earned: '0',
    payable: '0',
    held: '0',
    flagged: '0',
    paidOut: '0',
    voided: '0',
    lowered: '0',
    clawbackOpen: '0',
    clawbackUnconfirmed: '0',
    netted: '0',
    payout: '0',
    ...patch,
});

describe('an amount an operator types', () => {
    test('is read exactly, in the currency’s own minor units', () => {
        expect(toMinor('12.50', 'usd')).toBe('1250');
        expect(toMinor('12.5', 'usd')).toBe('1250');
        expect(toMinor('12', 'USD')).toBe('1200');
        expect(toMinor(' 0.05 ', 'eur')).toBe('5');
        expect(toMinor('0.5', 'inr')).toBe('50');
        // No number in between: 90 trillion and one cent is that, to the cent.
        expect(toMinor('900719925474099.35', 'usd')).toBe('90071992547409935');
    });

    test('a currency with no smaller unit takes whole amounts as they are, never a hundred times them', () => {
        // 1,250 yen is 1250, not 125000; and half a yen does not exist.
        expect(toMinor('1250', 'jpy')).toBe('1250');
        expect(toMinor('1', 'jpy')).toBe('1');
        expect(toMinor('1250.5', 'jpy')).toBeNull();
        expect(toMinor('12.50', 'jpy')).toBeNull();
        expect(toMinor('1250.0', 'krw')).toBeNull();
        // Three decimals where the currency has them: 1.250 dinars is 1250 fils.
        expect(toMinor('1.250', 'kwd')).toBe('1250');
        expect(toMinor('1.25', 'kwd')).toBe('1250');
        expect(toMinor('0.001', 'kwd')).toBe('1');
        expect(toMinor('1.2505', 'kwd')).toBeNull();
        expect(currencyDecimals('jpy')).toBe(0);
        expect(currencyDecimals('usd')).toBe(2);
        expect(currencyDecimals('kwd')).toBe(3);
    });

    test('is refused, never rounded or guessed, when it is not a plain amount above zero or its currency is not one Intl knows', () => {
        for (const text of [
            '',
            ' ',
            '0',
            '0.00',
            '-5',
            '+5',
            '12.505',
            '12.',
            '.50',
            '1,250',
            '1 250',
            '12,50',
            '1e3',
            '0x10',
            '12.5 usd',
            'twelve',
            '1234567890123456',
        ])
            expect(toMinor(text, 'usd'), JSON.stringify(text)).toBeNull();
        expect(toMinor('0', 'jpy')).toBeNull();
        expect(toMinor('12.50', 'not a currency')).toBeNull();
        expect(currencyDecimals('??')).toBeNull();
    });

    test('is shown the shape to type for its currency', () => {
        expect(exampleAmount('usd')).toBe('12.50');
        expect(exampleAmount('jpy')).toBe('1250');
        expect(exampleAmount('kwd')).toBe('1.250');
    });
});

describe('an amount on the page', () => {
    test('is drawn in its currency’s own decimals, exactly, with a whole amount’s decimals dropped as prices drop them', () => {
        expect(formatMinor('1250', 'usd')).toBe('$12.50');
        expect(formatMinor('2000', 'usd')).toBe('$20');
        expect(formatMinor('5', 'usd')).toBe('$0.05');
        expect(formatMinor('1598000', 'inr')).toBe('₹15,980');
        // 1,250 yen, not 12.50 of them.
        expect(formatMinor('1250', 'jpy')).toBe('¥1,250');
        // Intl puts a no-break space after a code it has no sign for.
        expect(formatMinor('1250', 'kwd')).toBe('KWD\u00a01.250');
        // Past 2^53 a number would show ...99.36 or ...99.34.
        expect(formatMinor('90071992547409935', 'usd')).toBe('$900,719,925,474,099.35');
        expect(formatMinor('1250', 'not a currency')).toBe('1250 NOT A CURRENCY');
    });
});

describe('the payout an operator is shown', () => {
    test('is sent back for the currencies with something owed, and only those', () => {
        expect(
            expectedPayouts({
                usd: totals({ payable: '5000', clawbackOpen: '76800', netted: '5000' }),
                eur: totals({ held: '900', clawbackOpen: '300' }),
                inr: totals({ payable: '90071992547409935', payout: '90071992547409935' }),
            }),
        ).toEqual({
            usd: { owed: '5000', netted: '5000' },
            inr: { owed: '90071992547409935', netted: '0' },
        });
        expect(expectedPayouts(undefined)).toEqual({});
    });

    test('a total is listed per currency, and a ledger with none of it shows a dash', () => {
        const ledger = { usd: totals({ held: '2000' }), eur: totals({ held: '0', payable: '1' }) };
        expect(ledgerMoney(ledger, 'held')).toBe('$20');
        expect(ledgerMoney(ledger, 'flagged')).toBe('–');
        expect(ledgerMoney(undefined, 'held')).toBe('–');
    });
});

describe('the downloaded ledger', () => {
    const row = (patch: Partial<AffiliateEarningView>): AffiliateEarningView => ({
        id: '4f9c4b50-ae8c-4085-9e87-6f5d8bcd3c54',
        orderId: 'order_1',
        userId: null,
        currency: 'usd',
        recordedAt: '2026-11-08T09:00:00.000Z',
        net: '10000',
        pot: '2000',
        left: '2000',
        state: 'held',
        payableAt: '2026-12-08T09:00:00.000Z',
        paidAt: null,
        paid: null,
        refunded: '0',
        dispute: null,
        flag: null,
        clawback: null,
        voidedAt: null,
        voidReason: null,
        ...patch,
    });

    test('writes minor units as exact decimals in the currency’s own decimals, at any size', () => {
        expect(minorAsDecimal('0', 'usd')).toBe('0.00');
        expect(minorAsDecimal('5', 'usd')).toBe('0.05');
        expect(minorAsDecimal('1250', 'usd')).toBe('12.50');
        expect(minorAsDecimal('90071992547409935', 'usd')).toBe('900719925474099.35');
        expect(minorAsDecimal('1250', 'jpy')).toBe('1250');
        expect(minorAsDecimal('5', 'kwd')).toBe('0.005');
        // Unknown to Intl: the units the server holds, rather than a guess at where the point goes.
        expect(minorAsDecimal('1250', 'not a currency')).toBe('1250');
    });

    test('a yen earning is written in yen, beside a dollar one in dollars', () => {
        const lines = ledgerCsv([
            row({ currency: 'jpy', net: '125000', pot: '25000', left: '25000' }),
            row({}),
        ]).split('\r\n');
        expect(lines[1]).toContain('"JPY","125000","25000","25000"');
        expect(lines[2]).toContain('"USD","100.00","20.00","20.00"');
    });

    test('has a line an earning under one heading, with every amount and what was done about a clawback', () => {
        const lines = ledgerCsv([
            row({}),
            row({
                orderId: 'order_2',
                state: 'paid',
                paidAt: '2026-08-01T09:00:00.000Z',
                paid: '2000',
                left: '0',
                refunded: '10000',
                dispute: 'lost',
                clawback: {
                    amount: '2000',
                    open: '1400',
                    settled: '600',
                    writtenOff: '0',
                    cutover: true,
                    confirmed: false,
                    settledAt: null,
                    note: 'Repaid 6.00',
                },
            }),
        ]).split('\r\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]!.split(',')).toHaveLength(22);
        expect(lines[1]).toBe(
            '"2026-11-08T09:00:00.000Z","order_1","","USD","100.00","20.00","20.00","held","2026-12-08T09:00:00.000Z","","","0.00","","","","","","","","","",""',
        );
        expect(lines[2]).toBe(
            '"2026-11-08T09:00:00.000Z","order_2","","USD","100.00","20.00","0.00","paid","2026-12-08T09:00:00.000Z","2026-08-01T09:00:00.000Z","20.00","100.00","lost","","20.00","14.00","6.00","0.00","yes","Repaid 6.00","",""',
        );
    });

    test('dates the API client has already turned into Date objects are written as the same ISO strings', () => {
        const asClientHandsIt = {
            ...row({ state: 'paid', paid: '2000', voidedAt: null }),
            recordedAt: new Date('2026-11-08T09:00:00.000Z'),
            payableAt: new Date('2026-12-08T09:00:00.000Z'),
            paidAt: new Date('2026-12-09T10:30:00.000Z'),
        } as unknown as AffiliateEarningView;
        expect(ledgerCsv([asClientHandsIt]).split('\r\n')[1]).toBe(
            ledgerCsv([
                row({ state: 'paid', paid: '2000', paidAt: '2026-12-09T10:30:00.000Z' }),
            ]).split('\r\n')[1],
        );
    });

    test('a reason someone typed cannot break out of its cell or run as a formula when the file is opened', () => {
        const [, line] = ledgerCsv([
            row({
                state: 'voided',
                voidedAt: '2026-11-09T09:00:00.000Z',
                voidReason: '=HYPERLINK("http://evil.example","click"), then\r\nmore',
            }),
        ]).split('\r\n"2026');
        expect(line).toContain('"\'=HYPERLINK(""http://evil.example"",""click""), then\r\nmore"');
        for (const start of ['+1', '-1', '@sum', '\tx'])
            expect(ledgerCsv([row({ voidReason: start })])).toContain(`"'${start}"`);
        // An ordinary reason is written as it is.
        expect(ledgerCsv([row({ voidReason: 'Card testing' })])).toContain(',"Card testing"');
    });
});
