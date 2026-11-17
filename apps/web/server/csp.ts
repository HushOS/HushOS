/*
 * The Content Security Policy every page ships. Scripts run only from this
 * origin and, for the inline script TanStack writes to hydrate the router,
 * under a nonce minted per request; WebAssembly (OPAQUE, libsodium, argon2,
 * pdf.js) needs `wasm-unsafe-eval`, and nothing needs `unsafe-eval`. Previews
 * draw from blob and data URLs the page makes itself and never from another
 * origin; the only origins the page talks to besides its own are the object
 * store it uploads to and downloads from, and whatever the operator adds.
 * In development the Vite client's inline preamble and its WebSocket are
 * allowed; everything else is the production policy.
 */

export type CspInput = {
    nonce: string | null;
    dev: boolean;
    /* Origins presigned URLs point at, as the browser sees them. */
    storeOrigins: string[];
    /* Operator additions, for example the evidence bucket's origin. */
    extraConnect: string[];
    /* The analytics script's origin, which also receives its beacons; empty when there is none. */
    analyticsOrigins?: string[];
};

/* The origin presigned URLs use: the endpoint itself in path style, else the bucket's virtual host. */
export function storeOrigin(endpoint: string, bucket: string, pathStyle: boolean) {
    const url = new URL(endpoint);
    if (pathStyle) return url.origin;
    return `${url.protocol}//${bucket}.${url.host}`;
}

export function buildCsp(input: CspInput) {
    const analytics = input.analyticsOrigins ?? [];
    const script = input.dev
        ? ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...analytics]
        : [
              "'self'",
              ...(input.nonce ? [`'nonce-${input.nonce}'`] : []),
              "'wasm-unsafe-eval'",
              ...analytics,
          ];
    const connect = [
        "'self'",
        ...input.storeOrigins,
        ...input.extraConnect,
        ...analytics,
        ...(input.dev ? ['ws:', 'wss:'] : []),
    ];
    const directives: [string, string[]][] = [
        ['default-src', ["'self'"]],
        ['script-src', script],
        ['style-src', ["'self'", "'unsafe-inline'"]],
        ['img-src', ["'self'", 'blob:', 'data:']],
        ['media-src', ["'self'", 'blob:']],
        ['font-src', ["'self'"]],
        ['connect-src', [...new Set(connect)]],
        ['worker-src', ["'self'", 'blob:']],
        ['frame-src', ["'self'"]],
        ['manifest-src', ["'self'"]],
        ['object-src', ["'none'"]],
        ['base-uri', ["'self'"]],
        ['form-action', ["'self'"]],
        ['frame-ancestors', ["'none'"]],
    ];
    return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/*
 * A tools worker (`*.tool-worker.ts`, emitted as `/assets/<name>.tool-worker-<hash>.js`) parses
 * files anyone could have uploaded, and a parser bug could hand it to them. Holding no keys is
 * not enough: a same-origin worker could reach this server with the person's session cookie,
 * and carry decrypted bytes there in a URL. Its script is served with a policy of its own,
 * which a dedicated worker runs under, and which names no source at all: no fetch, no import()
 * or importScripts (a `'self'` script source would let `import('/api/…?q=…')` through), no
 * workers of its own. Only WebAssembly may be compiled, and the page hands it the compiled
 * Modules and data files it needs: the page is the worker's only way out. A tools worker is
 * therefore one self-contained file (check-worker-code.ts fails the build otherwise).
 * IndexedDB and the other storage APIs are not governed by any policy; docs/file-tools-design.md
 * (section 3) records what that leaves.
 */
export function isToolWorkerScript(pathname: string) {
    return /^\/assets\/[\w.-]+\.tool-worker-[\w-]+\.js$/.test(pathname);
}

export function buildToolWorkerCsp() {
    const directives: [string, string[]][] = [
        ['default-src', ["'none'"]],
        ['script-src', ["'wasm-unsafe-eval'"]],
        ['worker-src', ["'none'"]],
        ['base-uri', ["'none'"]],
        ['form-action', ["'none'"]],
    ];
    return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/* Origins as "https://host" entries; anything that does not parse as one is dropped, never guessed. */
export function parseOrigins(value: string | undefined) {
    if (!value) return [];
    return value
        .split(/[\s,]+/)
        .filter(Boolean)
        .flatMap((entry) => {
            try {
                const url = new URL(entry);
                return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
            } catch {
                return [];
            }
        });
}
