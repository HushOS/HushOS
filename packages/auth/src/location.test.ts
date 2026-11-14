import { describe, expect, test } from 'vitest';
import { locationWords, requestLocation } from './location';

/*
 * The rough place a device asking another one to confirm it is shown with
 * (docs/two-step-design.md 12). The server reads only the headers its operator named, and what
 * it reads reaches another device's screen: so a header nobody configured must never be read,
 * a city must come out as the city's name whatever bytes carried it, and nothing but a place
 * name may come out at all.
 */

const CLOUDFLARE = {
    TRUSTED_COUNTRY_HEADER: 'cf-ipcountry',
    TRUSTED_REGION_HEADER: 'cf-region',
    TRUSTED_CITY_HEADER: 'cf-ipcity',
};
/* A header value as a server hands it over: the bytes on the wire, one code unit each. */
const wire = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));
const from = (headers: Record<string, string>, settings: object = CLOUDFLARE) =>
    requestLocation(new Headers(headers), settings);

describe('which headers are read', () => {
    const sent = { 'cf-ipcountry': 'FR', 'cf-region': 'Auvergne-Rhone-Alpes', 'cf-ipcity': 'Lyon' };

    test('with no header configured, nothing a request carries is a place', () => {
        expect(from(sent, {})).toBeNull();
        // The region alone places nobody, so it is not read without a country or a city header.
        expect(from(sent, { TRUSTED_REGION_HEADER: 'cf-region' })).toBeNull();
    });

    test('only the configured headers are read, each under the name the operator gave', () => {
        expect(from(sent)).toBe('near Lyon, Auvergne-Rhone-Alpes, France');
        // The country alone is configured: the city a client sent beside it is not looked at.
        expect(from(sent, { TRUSTED_COUNTRY_HEADER: 'cf-ipcountry' })).toBe('in France');
        expect(from(sent, { TRUSTED_CITY_HEADER: 'cf-ipcity' })).toBe('near Lyon');
        // Another proxy's names, and Cloudflare's own headers then mean nothing.
        const other = {
            TRUSTED_COUNTRY_HEADER: 'x-geo-country',
            TRUSTED_CITY_HEADER: 'x-geo-city',
        };
        expect(from(sent, other)).toBeNull();
        expect(from({ 'x-geo-country': 'DE', 'x-geo-city': 'Berlin' }, other)).toBe(
            'near Berlin, Germany',
        );
    });

    test('a configured header the request does not carry leaves what the others say', () => {
        expect(from({ 'cf-ipcountry': 'FR' })).toBe('in France');
        expect(from({ 'cf-ipcity': 'Lyon' })).toBe('near Lyon');
        expect(from({ 'cf-region': 'Bavaria' })).toBeNull();
        expect(from({})).toBeNull();
    });
});

describe('what a header says', () => {
    test('a city sent as UTF-8 bytes is read as its name, not as the bytes', () => {
        // Cloudflare sends non-ASCII as UTF-8, and a header's bytes arrive one character each.
        expect(wire('São Paulo')).toBe('SÃ£o Paulo');
        expect(from({ 'cf-ipcity': wire('São Paulo'), 'cf-ipcountry': 'BR' })).toBe(
            'near São Paulo, Brazil',
        );
        expect(
            from({
                'cf-ipcity': wire('Kraków'),
                'cf-region': wire('Małopolskie'),
                'cf-ipcountry': 'PL',
            }),
        ).toBe('near Kraków, Małopolskie, Poland');
        expect(locationWords({ city: wire('東京'), country: 'JP' })).toBe('near 東京, Japan');
        // Already text: a lone letter beyond ASCII is not UTF-8, and is kept as it is.
        expect(locationWords({ city: 'São Paulo' })).toBe('near São Paulo');
        // A proxy that percent-encodes is read too.
        expect(locationWords({ city: 'S%C3%A3o%20Paulo' })).toBe('near São Paulo');
    });

    test('the country is a name, from its code; codes that name no place give none', () => {
        expect(locationWords({ country: 'fr' })).toBe('in France');
        expect(locationWords({ country: 'GB' })).toBe('in United Kingdom');
        // Cloudflare's "unknown" and Tor, and a code no country has.
        for (const code of ['XX', 'T1', 'ZZ', 'QQ'])
            expect(locationWords({ country: code })).toBeNull();
        expect(locationWords({ city: 'Lyon', country: 'XX' })).toBe('near Lyon');
        // A proxy that sends the name is taken at its word.
        expect(locationWords({ country: 'France' })).toBe('in France');
    });

    test('a region that only repeats the city is said once', () => {
        expect(locationWords({ city: 'Hamburg', region: 'Hamburg', country: 'DE' })).toBe(
            'near Hamburg, Germany',
        );
    });

    test('anything that is not a place name never reaches the other device’s screen', () => {
        for (const city of [
            'Lyon‮ecnarF',
            'Lyon\nApprove now',
            'Lyon. Call 555 0100 now!',
            '<b>Lyon</b>',
            'https://evil.example',
            'L'.repeat(61),
            '   ',
        ])
            expect(locationWords({ city, country: 'FR' })).toBe('in France');
        expect(locationWords({ city: 'Lyon', region: 'x\u0000y', country: 'FR' })).toBe(
            'near Lyon, France',
        );
        expect(locationWords({ country: 'France; DROP' })).toBeNull();
        // Real names with their punctuation pass.
        for (const city of ['Saint-Étienne', 'St. John’s', "N'Djamena", 'Frankfurt (Oder)'])
            expect(locationWords({ city })).toBe(`near ${city}`);
    });
});
