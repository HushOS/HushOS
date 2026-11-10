import type { AffiliateEarningView, LedgerTotals } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    expectedPayouts,
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
    test('is read exactly, in minor units', () => {
        expect(toMinor('12.50')).toBe('1250');
        expect(toMinor('12.5')).toBe('1250');
        expect(toMinor('12')).toBe('1200');
        expect(toMinor(' 0.05 ')).toBe('5');
        expect(toMinor('0.5')).toBe('50');
        // No number in between: 90 trillion and one cent is that, to the cent.
        expect(toMinor('900719925474099.35')).toBe('90071992547409935');
    });

    test('is refused, never rounded or guessed, when it is not a plain amount above zero', () => {
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
            expect(toMinor(text), JSON.stringify(text)).toBeNull();
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

    test('writes minor units as exact decimals, at any size', () => {
        expect(minorAsDecimal('0')).toBe('0.00');
        expect(minorAsDecimal('5')).toBe('0.05');
        expect(minorAsDecimal('1250')).toBe('12.50');
        expect(minorAsDecimal('90071992547409935')).toBe('900719925474099.35');
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
