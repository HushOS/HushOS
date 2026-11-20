import { describe, expect, test } from 'vitest';
import { formatQuota, formatMoney } from './format';

const GIB = 1_073_741_824n;

describe('formatQuota', () => {
    test('switches to TB at exactly 1024 GB and not before', () => {
        expect(formatQuota((1024n * GIB).toString(), 'en-US')).toBe('1 TB');
        expect(formatQuota((1024n * GIB - 1n).toString(), 'en-US')).toBe('1,024 GB');
        expect(formatQuota((1536n * GIB).toString(), 'en-US')).toBe('1.5 TB');
    });

    test('keeps GB values readable at the sizes we sell and at zero', () => {
        expect(formatQuota((200n * GIB).toString(), 'en-US')).toBe('200 GB');
        expect(formatQuota('0', 'en-US')).toBe('0 GB');
        expect(formatQuota(String(GIB / 2n), 'en-US')).toBe('0.5 GB');
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
