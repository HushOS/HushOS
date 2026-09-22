import { formatBytes } from '@/lib/drive';
const GIB = 1_073_741_824;

/* Byte counts arrive as decimal strings; show GiB, or TiB from 1024 GiB. */
export function formatGiB(bytes: string | number, locale?: string) {
    const gib = Number(bytes) / GIB;
    const [value, unit] = gib >= 1024 ? [gib / 1024, 'TiB'] : [gib, 'GiB'];
    return `${value.toLocaleString(locale, { maximumFractionDigits: 2 })} ${unit}`;
}

/* Space in the unit that fits, written like a quota beside it: "2 GiB", "1.6 KiB", never "2.0 GiB" next to "2 GiB". */
export function formatSpace(bytes: string | number, locale?: string) {
    return Number(bytes) >= GIB ? formatGiB(bytes, locale) : formatBytes(bytes);
}

/* Minor units and an ISO currency code, as Polar reports them; whole amounts drop the cents. */
export function formatMoney(amount: number, currency: string, locale?: string) {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
}
