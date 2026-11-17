import { describe, expect, test } from 'vitest';
import { buildCsp, buildToolWorkerCsp, isToolWorkerScript, parseOrigins, storeOrigin } from './csp';

/*
 * The policy is the second line behind the sanitiser: it must name the store
 * the browser fetches from, carry the nonce and nothing looser for scripts in
 * production, and never admit an origin that was not spelled out.
 */

describe('csp', () => {
    test('production scripts run only from self under the nonce, with WebAssembly and no eval', () => {
        const policy = buildCsp({
            nonce: 'abc123',
            dev: false,
            storeOrigins: ['https://hushos.s3.eu-central-003.backblazeb2.com'],
            extraConnect: ['https://hushos-evidence.s3.eu-central-003.backblazeb2.com'],
        });
        const directive = (name: string) =>
            policy
                .split('; ')
                .find((entry) => entry.startsWith(`${name} `))!
                .slice(name.length + 1);
        expect(directive('script-src')).toBe("'self' 'nonce-abc123' 'wasm-unsafe-eval'");
        expect(policy).not.toContain("'unsafe-eval'");
        expect(directive('connect-src')).toBe(
            "'self' https://hushos.s3.eu-central-003.backblazeb2.com https://hushos-evidence.s3.eu-central-003.backblazeb2.com",
        );
        expect(directive('object-src')).toBe("'none'");
        expect(directive('frame-ancestors')).toBe("'none'");
        expect(directive('worker-src')).toBe("'self' blob:");
        // Analytics, when configured, may load its script and receive its beacons, nothing else.
        const withAnalytics = buildCsp({
            nonce: 'abc123',
            dev: false,
            storeOrigins: [],
            extraConnect: [],
            analyticsOrigins: ['https://analytics.example.com'],
        });
        expect(withAnalytics).toContain(
            "script-src 'self' 'nonce-abc123' 'wasm-unsafe-eval' https://analytics.example.com;",
        );
        expect(withAnalytics).toContain("connect-src 'self' https://analytics.example.com;");
        expect(withAnalytics).toContain("img-src 'self' blob: data:;");
        expect(directive('img-src')).toBe("'self' blob: data:");
        expect(policy).not.toContain('ws:');
    });

    test('development admits the Vite preamble and its socket, and nothing else changes', () => {
        const policy = buildCsp({
            nonce: null,
            dev: true,
            storeOrigins: ['http://127.0.0.1:9000'],
            extraConnect: [],
        });
        expect(policy).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
        expect(policy).toContain("connect-src 'self' http://127.0.0.1:9000 ws: wss:");
        expect(policy).not.toContain('nonce');
    });

    test('the store origin follows the addressing style, and extra origins are parsed or dropped', () => {
        expect(storeOrigin('https://storage.hushos.example.com', 'hushos', true)).toBe(
            'https://storage.hushos.example.com',
        );
        expect(storeOrigin('https://s3.eu-central-003.backblazeb2.com', 'hushos', false)).toBe(
            'https://hushos.s3.eu-central-003.backblazeb2.com',
        );
        expect(storeOrigin('http://127.0.0.1:9000/', 'hushos', true)).toBe('http://127.0.0.1:9000');
        expect(
            parseOrigins(
                'https://a.example/path, https://b.example:8443 javascript:alert(1) not-a-url',
            ),
        ).toEqual(['https://a.example', 'https://b.example:8443']);
        expect(parseOrigins(undefined)).toEqual([]);
    });

    test('a tools worker’s policy names no source: no fetch, no import, no workers', () => {
        const policy = buildToolWorkerCsp();
        expect(policy).toContain("default-src 'none'");
        // WebAssembly the page compiled may be instantiated; no script may be loaded at all.
        expect(policy).toContain("script-src 'wasm-unsafe-eval'");
        expect(policy).not.toMatch(/'self'|https?:|\*/);
        expect(policy).not.toContain("'unsafe-eval'");
        expect(policy).not.toContain('connect-src');
        expect(policy).toContain("worker-src 'none'");
    });

    test('only a tools worker’s script gets the narrower policy', () => {
        expect(isToolWorkerScript('/assets/archive.tool-worker-Dq3_x-9a.js')).toBe(true);
        expect(isToolWorkerScript('/assets/json.worker-DSHp7M8s.js')).toBe(false);
        expect(isToolWorkerScript('/assets/archive.tool-worker-Dq3.js/../x')).toBe(false);
        expect(isToolWorkerScript('/app/assets/archive.tool-worker-Dq3.js')).toBe(false);
    });
});
