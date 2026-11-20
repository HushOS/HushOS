/*
 * What this browser calls itself in the device list: the browser's family and
 * the system's, "Firefox on Linux", "Safari on macOS", never a version. Read
 * from the low-entropy client hints where the browser offers them (brands and
 * platform, never `getHighEntropyValues`), else from a coarse look at the user
 * agent. The server never parses it, and the person can rename it. An iPad that
 * reports itself as a Mac is called a Mac.
 */

type Hints = { brands?: { brand: string }[]; platform?: string };

const BROWSERS: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
    [/\bOPR\/|\bOpera\b/, 'Opera'],
    [/\bSamsungBrowser\//, 'Samsung Internet'],
    [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
    [/\bChrome\/|\bCriOS\/|\bChromium\//, 'Chrome'],
    [/\bSafari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
    [/\biPhone\b/, 'iPhone'],
    [/\biPad\b/, 'iPad'],
    [/\bAndroid\b/, 'Android'],
    [/\bCrOS\b/, 'ChromeOS'],
    [/\bWindows\b/, 'Windows'],
    [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
    [/\bLinux\b/, 'Linux'],
];
const HINT_BRANDS = ['Microsoft Edge', 'Opera', 'Samsung Internet', 'Google Chrome', 'Chromium'];
const HINT_PLATFORMS: Record<string, string> = {
    Windows: 'Windows',
    macOS: 'macOS',
    Linux: 'Linux',
    Android: 'Android',
    'Chrome OS': 'ChromeOS',
    ChromeOS: 'ChromeOS',
    iOS: 'iPhone',
};

function match(table: [RegExp, string][], agent: string) {
    return table.find(([pattern]) => pattern.test(agent))?.[1];
}

export function deviceName(
    agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
    hints: Hints | undefined = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { userAgentData?: Hints }).userAgentData,
) {
    const hinted = hints?.brands
        ?.map(({ brand }) => brand)
        .find((brand) => HINT_BRANDS.includes(brand));
    const browser =
        (hinted === 'Microsoft Edge'
            ? 'Edge'
            : hinted === 'Google Chrome' || hinted === 'Chromium'
              ? 'Chrome'
              : hinted) ?? match(BROWSERS, agent);
    const system = (hints?.platform && HINT_PLATFORMS[hints.platform]) || match(SYSTEMS, agent);
    if (browser && system) return `${browser} on ${system}`;
    return browser ?? (system ? `A browser on ${system}` : 'A web browser');
}

export function describeBrowser() {
    return { kind: 'web' as const, name: deviceName() };
}
