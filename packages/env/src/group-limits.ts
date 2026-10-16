/*
 * The most areas an operator may allow a group (GROUP_AREA_LIMIT). A roster
 * that marks someone left re-seals every area's workspace documents in the
 * same request, so its body cap makes room for each area at Drive's document
 * limits (about 2.7 MiB): 50 areas bound a roster request at about 141 MiB
 * (docs/groups-server.md 4). Apart from the settings so the body cap can read
 * it without reading the environment.
 */
export const GROUP_AREA_LIMIT_MAX = 50;
