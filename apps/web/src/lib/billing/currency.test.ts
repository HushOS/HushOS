import { describe, expect, test } from 'vitest';
import {
    chargeableCurrency,
    currencyForCountry,
    pickCurrency,
    regionFromAcceptLanguage,
} from './currency';

describe('currencyForCountry', () => {
    test('maps priced countries, the euro area, and nothing else', () => {
        expect(currencyForCountry('IN')).toBe('inr');
        expect(currencyForCountry('gb')).toBe('gbp');
        expect(currencyForCountry('DE')).toBe('eur');
        expect(currencyForCountry('XK')).toBe('eur');
        expect(currencyForCountry('XX')).toBeNull();
        expect(currencyForCountry('T1')).toBeNull();
        expect(currencyForCountry('')).toBeNull();
        expect(currencyForCountry(null)).toBeNull();
    });
});

describe('regionFromAcceptLanguage', () => {
    test('takes the region of the most preferred tag that has one', () => {
        expect(regionFromAcceptLanguage('en-IN,en;q=0.9,hi;q=0.8')).toBe('IN');
        expect(regionFromAcceptLanguage('en,hi-IN;q=0.8')).toBe('IN');
        expect(regionFromAcceptLanguage('en;q=0.5,fr-FR;q=0.9')).toBe('FR');
        expect(regionFromAcceptLanguage('de-DE,en-GB;q=0.9')).toBe('DE');
    });

    test('ignores tags without a region, wildcards, zero quality, and junk', () => {
        expect(regionFromAcceptLanguage('en')).toBeNull();
        expect(regionFromAcceptLanguage('*')).toBeNull();
        expect(regionFromAcceptLanguage('en-IN;q=0,en')).toBeNull();
        expect(regionFromAcceptLanguage('zh-Hans-CN')).toBe('CN');
        expect(regionFromAcceptLanguage(';;,,')).toBeNull();
        expect(regionFromAcceptLanguage(null)).toBeNull();
    });
});

describe('chargeableCurrency', () => {
    test('a chosen currency is charged only from a country that pays in it', () => {
        expect(chargeableCurrency('inr', 'IN')).toBe('inr');
        expect(chargeableCurrency('INR', 'in')).toBe('inr');
        expect(chargeableCurrency('inr', 'US')).toBeNull();
        expect(chargeableCurrency('eur', 'DE')).toBe('eur');
        expect(chargeableCurrency('eur', 'GB')).toBeNull();
    });

    test('with no known country the provider decides', () => {
        expect(chargeableCurrency('inr', null)).toBeNull();
        expect(chargeableCurrency('inr', 'XX')).toBeNull();
        expect(chargeableCurrency(undefined, 'IN')).toBeNull();
    });
});

describe('pickCurrency', () => {
    const available = ['usd', 'eur', 'inr'];
    test('an explicit choice wins when the catalogue has it', () => {
        expect(
            pickCurrency({
                requested: 'EUR',
                hint: { country: 'IN', acceptLanguage: 'en-IN', trusted: false },
                available,
                fallback: 'usd',
            }),
        ).toBe('eur');
    });

    test('a trusted country ignores the choice altogether', () => {
        expect(
            pickCurrency({
                requested: 'usd',
                hint: { country: 'IN', acceptLanguage: 'en-US', trusted: true },
                available,
                fallback: 'usd',
            }),
        ).toBe('inr');
    });

    test('an unavailable choice is ignored in favour of the country', () => {
        expect(
            pickCurrency({
                requested: 'gbp',
                hint: { country: 'IN', acceptLanguage: null, trusted: false },
                available,
                fallback: 'usd',
            }),
        ).toBe('inr');
    });

    test('the country beats the language, and the language beats the fallback', () => {
        expect(
            pickCurrency({
                hint: { country: 'DE', acceptLanguage: 'en-IN', trusted: false },
                available,
                fallback: 'usd',
            }),
        ).toBe('eur');
        expect(
            pickCurrency({
                hint: { country: null, acceptLanguage: 'en-IN', trusted: false },
                available,
                fallback: 'usd',
            }),
        ).toBe('inr');
    });

    test('a country the catalogue has no price for falls through', () => {
        expect(
            pickCurrency({
                hint: { country: 'GB', acceptLanguage: 'en-GB', trusted: false },
                available,
                fallback: 'usd',
            }),
        ).toBe('usd');
        expect(pickCurrency({ hint: null, available, fallback: 'usd' })).toBe('usd');
    });
});
