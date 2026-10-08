/*
 * A timezone where it is mid-morning. Screenshots show times ("Today, 10:24 AM"), and a
 * picture taken at night reads oddly beside a 9:41 status bar. Used by e2e/screenshots.spec.ts and,
 * printed by running this file, by scripts/store-screenshots.sh for the phones.
 */
const ZONES = [
    'Pacific/Honolulu',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'America/Sao_Paulo',
    'Atlantic/Azores',
    'Europe/Lisbon',
    'Europe/Berlin',
    'Europe/Athens',
    'Asia/Dubai',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Dhaka',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Noumea',
    'Pacific/Auckland',
];

const hourIn = (timeZone: string, at: Date) =>
    Number(
        new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
            at,
        ),
    );

/* The zone where `at` (now, unless given) falls closest to 10 in the morning. */
export function morningZone(at = new Date()) {
    return ZONES.reduce((best, zone) =>
        Math.abs(hourIn(zone, at) - 10) < Math.abs(hourIn(best, at) - 10) ? zone : best,
    );
}

export const ZONE = morningZone();

/*
 * Run directly, with an optional ISO time: the phone scripts pass when the demo account was made,
 * so its files read "Today, 10:35" however long after the spec the phones are photographed.
 */
if (import.meta.main)
    console.log(morningZone(process.argv[2] ? new Date(process.argv[2]) : undefined));
