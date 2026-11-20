/*
 * Search-param validators for routes whose whole schema is one optional word.
 * A route's `validateSearch` runs in the shared bundle, and Zod there costs
 * every visitor twenty kilobytes for what is a single `includes`.
 */
export function oneOf<const T extends readonly string[]>(options: T) {
    return (value: unknown): T[number] | undefined =>
        typeof value === 'string' && options.includes(value) ? (value as T[number]) : undefined;
}

/*
 * Drive search keeps its query in the URL's fragment (`#q=…`), so back, forward
 * and a reload keep it while no request ever carries it: a query string would
 * reach the server and any proxy in the request line, and in the Referer of
 * the calls the page makes.
 */
export function searchHash(query: string) {
    return new URLSearchParams({ q: query }).toString();
}

export function searchFromHash(hash: string) {
    return new URLSearchParams(hash).get('q')?.trim().slice(0, 200) ?? '';
}
