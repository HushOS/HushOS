/*
 * Search-param validators for routes whose whole schema is one optional word.
 * A route's `validateSearch` runs in the shared bundle, and Zod there costs
 * every visitor twenty kilobytes for what is a single `includes`.
 */
export function oneOf<const T extends readonly string[]>(options: T) {
    return (value: unknown): T[number] | undefined =>
        typeof value === 'string' && options.includes(value) ? (value as T[number]) : undefined;
}
