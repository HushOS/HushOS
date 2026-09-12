/*
 * Which currency to show a visitor first. The provider charges in the customer's
 * local currency when the plan has a price in it, so the pricing page should show
 * the same one. Signals, strongest first: an explicit choice, the country a
 * geolocating proxy reports, the region in the browser's language, then the
 * provider's default. Pure so it can be tested against every input shape.
 */

const EURO_COUNTRIES = new Set([
    'AD',
    'AT',
    'BE',
    'CY',
    'DE',
    'EE',
    'ES',
    'FI',
    'FR',
    'GR',
    'HR',
    'IE',
    'IT',
    'LT',
    'LU',
    'LV',
    'MC',
    'ME',
    'MT',
    'NL',
    'PT',
    'SI',
    'SK',
    'SM',
    'VA',
    'XK',
]);

const CURRENCY_BY_COUNTRY: Record<string, string> = {
    US: 'usd',
    GB: 'gbp',
    IN: 'inr',
    CA: 'cad',
    AU: 'aud',
    NZ: 'nzd',
    JP: 'jpy',
    CH: 'chf',
    SE: 'sek',
    NO: 'nok',
    DK: 'dkk',
    PL: 'pln',
    CZ: 'czk',
    HU: 'huf',
    RO: 'ron',
    BG: 'bgn',
    BR: 'brl',
    MX: 'mxn',
    AR: 'ars',
    CL: 'clp',
    CO: 'cop',
    SG: 'sgd',
    HK: 'hkd',
    KR: 'krw',
    TW: 'twd',
    TH: 'thb',
    MY: 'myr',
    ID: 'idr',
    PH: 'php',
    VN: 'vnd',
    AE: 'aed',
    SA: 'sar',
    IL: 'ils',
    TR: 'try',
    ZA: 'zar',
    NG: 'ngn',
    KE: 'kes',
    EG: 'egp',
    PK: 'pkr',
    BD: 'bdt',
    LK: 'lkr',
    NP: 'npr',
};

/* ISO 3166 alpha-2 to the lowercase ISO 4217 code that country pays in, or null. */
export function currencyForCountry(country: string | null | undefined) {
    if (!country) return null;
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return null;
    if (EURO_COUNTRIES.has(code)) return 'eur';
    return CURRENCY_BY_COUNTRY[code] ?? null;
}

/*
 * The region of the most preferred language tag that has one, from an
 * `Accept-Language` header or `navigator.languages` joined by commas. Quality
 * values are honoured; ties keep the header's order.
 */
export function regionFromAcceptLanguage(header: string | null | undefined) {
    if (!header) return null;
    const tags = header
        .split(',')
        .map((part, index) => {
            const [tag = '', ...params] = part.trim().split(';');
            const q = params
                .map((param) => param.trim())
                .find((param) => param.startsWith('q='))
                ?.slice(2);
            const quality = q === undefined ? 1 : Number(q);
            return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
        })
        .filter((entry) => entry.quality > 0 && entry.tag && entry.tag !== '*')
        .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const { tag } of tags) {
        const region = tag
            .split('-')
            .find((part, index) => index > 0 && /^[A-Za-z]{2}$/.test(part));
        if (region) return region.toUpperCase();
    }
    return null;
}

/* `trusted`: the operator named a geolocating header, so the country is authoritative. */
export type LocaleHint = {
    country: string | null;
    acceptLanguage: string | null;
    trusted: boolean;
};

export function pickCurrency(input: {
    requested?: string | null;
    hint?: LocaleHint | null;
    available: readonly string[];
    fallback: string;
}) {
    const has = (currency: string | null | undefined) =>
        currency ? input.available.includes(currency.toLowerCase()) : false;
    // A trusted country leaves nothing to choose: the visitor's own pick is ignored.
    const requested = input.hint?.trusted ? undefined : input.requested?.toLowerCase();
    if (has(requested)) return requested!;
    const byCountry = currencyForCountry(input.hint?.country);
    if (has(byCountry)) return byCountry!;
    const byLanguage = currencyForCountry(regionFromAcceptLanguage(input.hint?.acceptLanguage));
    if (has(byLanguage)) return byLanguage!;
    return input.fallback;
}

/*
 * The currency a checkout may be told to use: the one the visitor chose, but only
 * when it is also the currency of the country the request came from. Anything
 * else is a display preference, and the provider decides from the address, so
 * choosing rupees from Boston shows rupees and charges dollars.
 */
export function chargeableCurrency(
    requested: string | null | undefined,
    country: string | null | undefined,
) {
    const wanted = requested?.toLowerCase();
    return wanted && wanted === currencyForCountry(country) ? wanted : null;
}

/* A currency's name in the reader's language, for the selector; the code if unknown. */
export function currencyLabel(currency: string, locale?: string) {
    const code = currency.toUpperCase();
    try {
        return new Intl.DisplayNames(locale, { type: 'currency' }).of(code) ?? code;
    } catch {
        return code;
    }
}
