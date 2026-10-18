const GIB = 1_073_741_824;

/*
 * The locale sizes and prices are written in unless a caller names another: the same on the
 * server and in every browser, so a page the server renders hydrates without a mismatch
 * ("$5", "€5", "£5", "₹3,900" and "1.5 TB" everywhere, never en-GB's "US$5" in one browser
 * and "$5" from the server, or "1,5 TB" in another).
 */
const LOCALE = 'en-US';

// Counted in 1024s and labelled as people know them, as in formatQuota.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(value: number | string | bigint | null | undefined) {
    if (value === null || value === undefined) return '';
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    let unit = 0;
    while (n >= 1024 && unit < UNITS.length - 1) {
        n /= 1024;
        unit++;
    }
    // A whole number shows none of the decimal it doesn't have: "20 MB", "1.6 KB".
    return `${unit === 0 ? n : Number(n.toFixed(n >= 100 ? 0 : 1))} ${UNITS[unit]}`;
}

/*
 * Byte counts arrive as decimal strings; show GB, or TB from 1024 GB. Sizes count
 * in 1024s, as Google Drive and Dropbox do, and are labelled the way people know
 * them: a 200 GiB plan reads "200 GB", not "214.7 GB".
 */
export function formatQuota(bytes: string | number, locale = LOCALE) {
    const gib = Number(bytes) / GIB;
    const [value, unit] = gib >= 1024 ? [gib / 1024, 'TB'] : [gib, 'GB'];
    return `${value.toLocaleString(locale, { maximumFractionDigits: 2 })} ${unit}`;
}

/* Space in the unit that fits, written like a quota beside it: "2 GB", "1.6 KB", never "2.0 GB" next to "2 GB". */
export function formatSpace(bytes: string | number, locale = LOCALE) {
    return Number(bytes) >= GIB ? formatQuota(bytes, locale) : formatBytes(bytes);
}

/* Minor units and an ISO currency code, as Polar reports them; whole amounts drop the cents. */
export function formatMoney(amount: number, currency: string, locale = LOCALE) {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
}
