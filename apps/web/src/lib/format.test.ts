import { describe, expect, test } from 'vitest';
import { formatGiB, formatMoney } from './format';

const GIB = 1_073_741_824n;

describe('formatGiB', () => {
    test('switches to TiB at exactly 1024 GiB and not before', () => {
        expect(formatGiB((1024n * GIB).toString(), 'en-US')).toBe('1 TiB');
        expect(formatGiB((1024n * GIB - 1n).toString(), 'en-US')).toBe('1,024 GiB');
        expect(formatGiB((1536n * GIB).toString(), 'en-US')).toBe('1.5 TiB');
    });

    test('keeps GiB values readable at the sizes we sell and at zero', () => {
        expect(formatGiB((200n * GIB).toString(), 'en-US')).toBe('200 GiB');
        expect(formatGiB('0', 'en-US')).toBe('0 GiB');
        expect(formatGiB(String(GIB / 2n), 'en-US')).toBe('0.5 GiB');
    });
});

describe('formatMoney', () => {
    test('drops the cents for whole amounts and keeps them otherwise', () => {
        expect(formatMoney(500, 'usd', 'en-US')).toBe('$5');
        expect(formatMoney(15000, 'usd', 'en-US')).toBe('$150');
        expect(formatMoney(550, 'usd', 'en-US')).toBe('$5.50');
        expect(formatMoney(0, 'usd', 'en-US')).toBe('$0');
    });

    test('accepts the lowercase currency code Polar reports', () => {
        expect(formatMoney(500, 'eur', 'en-US')).toBe('€5');
    });

    test('formats rupees with Indian grouping for an Indian reader', () => {
        expect(formatMoney(1199000, 'inr', 'en-IN')).toBe('₹11,990');
        expect(formatMoney(1199000, 'inr', 'en-US')).toBe('₹11,990');
        expect(formatMoney(39900, 'inr', 'en-IN')).toBe('₹399');
    });
});
