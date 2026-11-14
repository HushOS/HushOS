/*
 * Where a device that asks another one to confirm it is, roughly, for the prompt on the
 * approving device (docs/devices-design.md 2, docs/two-step-design.md 12): "near Lyon, France".
 *
 * This server looks nothing up. It reads what the operator's proxy already put on the request:
 * the headers named by TRUSTED_COUNTRY_HEADER, TRUSTED_REGION_HEADER and TRUSTED_CITY_HEADER,
 * each read only when it is set. The trust is the one TRUSTED_PROXY_HEADER already asks for:
 * the operator says their proxy fills these, and that the proxy is the only way in. Where a
 * client can reach the app past the proxy, it can write these headers itself, as it can the
 * address header (docs/self-hosting.md). With none of them set, there is no location.
 */

type Names = { country?: string; region?: string; city?: string };

/*
 * A header value as text. Cloudflare sends non-ASCII characters as UTF-8 bytes, and a header
 * read as Latin-1 (which is how `Headers` hands bytes over) turns "São Paulo" into "SÃ£o
 * Paulo": bytes that are valid UTF-8 are read as that. A proxy that percent-encodes instead
 * is read too. Anything that decodes to neither is left as it came.
 */
function decoded(value: string) {
    let text = value.trim();
    if (/%[0-9a-f]{2}/i.test(text)) {
        try {
            text = decodeURIComponent(text);
        } catch {
            // Not percent-encoding after all.
        }
    }
    const bytes = Array.from(text, (character) => character.charCodeAt(0));
    if (bytes.some((byte) => byte > 0x7f) && bytes.every((byte) => byte <= 0xff)) {
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
        } catch {
            // Already text, with a letter or two beyond ASCII.
        }
    }
    return text.normalize('NFC');
}

/*
 * A value with the shape of a place name, or nothing. These words reach another device's
 * screen beside a request to approve, so a value is shown only when it is:
 * - letters, each with at most two combining marks (no stack of marks drawn over the lines
 *   around it), and no digits or symbols;
 * - joined by single spaces, hyphens and apostrophes, each between two letters;
 * - with a period only to close an abbreviation of one to three letters ("St. John’s",
 *   "D.C."), never to end a word and start a sentence, and at most two of them;
 * - at most 40 characters ("Dadra and Nagar Haveli and Daman and Diu" is the longest region
 *   Cloudflare names).
 * Anything else is dropped whole, never trimmed to fit.
 *
 * What this does not do is tell a place from other words of the same shape: whoever can write
 * the header can write "Head Office" there. That is the proxy's word, and the operator's that
 * the proxy is the only way in (docs/self-hosting.md).
 */
const PLACE_MAX = 40;
const LETTER = String.raw`\p{L}\p{M}{0,2}`;
const PLACE = new RegExp(
    String.raw`^${LETTER}(?:${LETTER}|[ '’-](?=\p{L})|\.(?=$|[ -]?\p{L}))*$`,
    'u',
);
/* A period after a fourth letter in a row closes a word, not an abbreviation. */
const SENTENCE = new RegExp(String.raw`(?:${LETTER}){4}\.`, 'u');
function place(value: string | null) {
    if (!value) return null;
    // Only runs of plain spaces are folded: a line break or a tab is not a space in a name.
    const name = decoded(value).replace(/ {2,}/g, ' ');
    // Marks are counted as they are written out, one by one: composed, "ó" would hide its first.
    const spelled = name.normalize('NFD');
    if (name.length > PLACE_MAX || !PLACE.test(spelled) || SENTENCE.test(spelled)) return null;
    return (name.match(/\./g)?.length ?? 0) > 2 ? null : name;
}

const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
/*
 * The country as a name. A geolocating proxy sends an ISO 3166 code (`FR`); `XX` and `T1` are
 * Cloudflare's for "unknown" and Tor, which name no place. A proxy that sends a name is taken
 * at its word, by the same rule as any place name.
 */
function country(value: string | null) {
    const sent = value?.trim() ?? '';
    if (!sent) return null;
    // Two characters are a code, never a name: `T1` is one too.
    if (/^[a-z0-9]{2}$/i.test(sent)) {
        const code = sent.toUpperCase();
        // `ZZ` is CLDR's own "Unknown Region": a code, and no place either.
        if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'ZZ') return null;
        try {
            return regions.of(code) ?? null;
        } catch {
            return null;
        }
    }
    return place(sent);
}

/* The words for a place: "near Lyon, Auvergne-Rhône-Alpes, France", or "in France" with no city. */
export function locationWords(names: Names) {
    const land = country(names.country ?? null);
    const city = place(names.city ?? null);
    if (!city) return land ? `in ${land}` : null;
    const region = place(names.region ?? null);
    const parts = [city, ...(region && region !== city ? [region] : []), ...(land ? [land] : [])];
    return `near ${parts.join(', ')}`;
}

/*
 * Where this request comes from, as the proxy says it, or null: when no header is configured,
 * when the configured ones are absent, or when what they carry names no place. `settings` is
 * the environment's (`authEnv`): the caller hands it over, so this file reads no setting itself.
 */
export function requestLocation(
    headers: Headers,
    settings: {
        TRUSTED_COUNTRY_HEADER?: string;
        TRUSTED_REGION_HEADER?: string;
        TRUSTED_CITY_HEADER?: string;
    },
) {
    const read = (name: string | undefined) => (name ? headers.get(name) : null);
    // The region alone places nobody: it is read only beside a city.
    if (!settings.TRUSTED_COUNTRY_HEADER && !settings.TRUSTED_CITY_HEADER) return null;
    return locationWords({
        country: read(settings.TRUSTED_COUNTRY_HEADER) ?? undefined,
        region: read(settings.TRUSTED_REGION_HEADER) ?? undefined,
        city: read(settings.TRUSTED_CITY_HEADER) ?? undefined,
    });
}
