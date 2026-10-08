import { formatBytes } from '@/lib/drive';
const GIB = 1_073_741_824;

/*
 * Byte counts arrive as decimal strings; show GB, or TB from 1024 GB. Sizes count
 * in 1024s, as Google Drive and Dropbox do, and are labelled the way people know
 * them: a 200 GiB plan reads "200 GB", not "214.7 GB".
 */
export function formatQuota(bytes: string | number, locale?: string) {
    const gib = Number(bytes) / GIB;
    const [value, unit] = gib >= 1024 ? [gib / 1024, 'TB'] : [gib, 'GB'];
    return `${value.toLocaleString(locale, { maximumFractionDigits: 2 })} ${unit}`;
}

/* Space in the unit that fits, written like a quota beside it: "2 GB", "1.6 KB", never "2.0 GB" next to "2 GB". */
export function formatSpace(bytes: string | number, locale?: string) {
    return Number(bytes) >= GIB ? formatQuota(bytes, locale) : formatBytes(bytes);
}

/* Minor units and an ISO currency code, as Polar reports them; whole amounts drop the cents. */
export function formatMoney(amount: number, currency: string, locale?: string) {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
}
