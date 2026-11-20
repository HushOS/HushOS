// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The two files that let the apps open this instance's links. A wrong one is worse than none:
 * a phone that verifies the wrong team or certificate opens nothing in the app, and one that
 * lists too much takes the website or billing out of the browser. Unconfigured, neither is served.
 */

const env = vi.hoisted(() => ({
    APPLE_APP_IDS: undefined as string | undefined,
    ANDROID_APP_PACKAGE: 'com.hushos.app',
    ANDROID_APP_CERT_SHA256: undefined as string | undefined,
}));
vi.mock('@hushos/env/app', () => ({ appEnv: env }));

const { appleAppSiteAssociation, assetLinks } = await import('./app-links.server');

const UPLOAD =
    '1b:fd:e7:01:a4:de:68:3e:bd:7a:3f:18:2e:c6:6c:04:5d:d9:9d:5d:76:be:67:ad:8f:44:5e:0b:84:bc:fd:f3';
const SIGNING =
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/* Apple's rule: the first component whose pattern matches the path decides. */
function opensInApp(components: { '/': string; exclude?: boolean }[], path: string) {
    const hit = components.find(({ '/': pattern }) =>
        new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
            path,
        ),
    );
    return hit !== undefined && !hit.exclude;
}

beforeEach(() => {
    env.APPLE_APP_IDS = undefined;
    env.ANDROID_APP_PACKAGE = 'com.hushos.app';
    env.ANDROID_APP_CERT_SHA256 = undefined;
});

describe('apple-app-site-association', () => {
    test('is not served without an app to name', async () => {
        const response = appleAppSiteAssociation();
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).not.toBe('application/json');
    });

    test('names every configured app and opens invitations, shares and app pages in it', async () => {
        env.APPLE_APP_IDS = 'ABCDE12345.com.hushos.app, ZYXWV98765.com.example.drive';
        const response = appleAppSiteAssociation();
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        const body = await response.json();
        const ids = ['ABCDE12345.com.hushos.app', 'ZYXWV98765.com.example.drive'];
        expect(body.applinks.details).toHaveLength(1);
        expect(body.applinks.details[0].appIDs).toEqual(ids);
        expect(body.webcredentials.apps).toEqual(ids);
        const components = body.applinks.details[0].components;
        for (const path of ['/join', '/s/abc', '/recover/complete', '/app', '/app/drive/f/1'])
            expect(opensInApp(components, path), path).toBe(true);
        // What the app can't do stays on the web: a cut or longer invitation, billing, the console, the site.
        for (const path of [
            '/join/other',
            '/app/billing',
            '/app/admin/users',
            '/',
            '/pricing',
            '/login',
        ])
            expect(opensInApp(components, path), path).toBe(false);
    });
});

describe('assetlinks.json', () => {
    test('is not served without a certificate to vouch for', () => {
        expect(assetLinks().status).toBe(404);
    });

    test('vouches for the package under every configured certificate, for links and passwords', async () => {
        env.ANDROID_APP_CERT_SHA256 = `${UPLOAD}, ${SIGNING}`;
        env.ANDROID_APP_PACKAGE = 'com.example.drive';
        const response = assetLinks();
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('application/json');
        const body = await response.json();
        expect(body.map((entry: { relation: string[] }) => entry.relation[0])).toEqual([
            'delegate_permission/common.handle_all_urls',
            'delegate_permission/common.get_login_creds',
        ]);
        for (const entry of body)
            expect(entry.target).toEqual({
                namespace: 'android_app',
                package_name: 'com.example.drive',
                // Android compares fingerprints as uppercase hex.
                sha256_cert_fingerprints: [UPLOAD.toUpperCase(), SIGNING],
            });
    });
});
