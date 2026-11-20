/* Loads a page from the server, leaving this document and everything it holds in memory. */
export function loadPage(path: string) {
    window.location.assign(path);
}
