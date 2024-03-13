export const OPAQUE_SERVER_ID = 'server';

export function getOpaqueIds(email: string) {
    return {
        idS: OPAQUE_SERVER_ID,
        idU: email.toUpperCase(),
    } satisfies OpaqueIds;
}
