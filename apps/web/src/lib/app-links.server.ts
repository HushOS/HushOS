import '@/lib/server-only';
import { appEnv } from '@hushos/env/app';

/*
 * The files that let the iOS and Android apps open this instance's links: a
 * share link (/s/<token>#<secret>), the emailed recovery and sign-up links, the emailed
 * family invitation (/join#invite=<token>), and the app's own pages. Everything else (the
 * website, the sign-up form with its plans and codes, billing, the operator console) stays in
 * the browser.
 * Each is served only when its app is configured, so an instance without apps
 * says nothing about any.
 */

const list = (value: string | undefined) =>
    (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

/* The paths an app opens; the order matters, the first match decides. */
const appPaths = [
    { '/': '/app/admin*', exclude: true, comment: 'The operator console stays on the web' },
    { '/': '/app/billing*', exclude: true, comment: 'Plans are bought on the web' },
    { '/': '/s/*', comment: 'Share links; the key is in the fragment' },
    { '/': '/recover/complete', comment: 'The emailed link that starts recovery in the app' },
    { '/': '/join', comment: 'The emailed family invitation; the token is in the fragment' },
    {
        '/': '/register/complete',
        '?': { app: '1' },
        comment:
            'The sign-up link the app asked for; a web sign-up, unmarked, stays in the browser, so an older app that can’t finish it never catches it',
    },
    { '/': '/app', comment: 'Home' },
    { '/': '/app/drive*', comment: 'Files, a folder, or a file in the viewer' },
    { '/': '/app/shared*', comment: 'Shared with me and by me' },
    { '/': '/app/trash*', comment: 'Trash' },
];

const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
        },
    });

export function appleAppSiteAssociation() {
    const appIDs = list(appEnv.APPLE_APP_IDS);
    if (!appIDs.length) return new Response('Not found', { status: 404 });
    return json({
        applinks: { details: [{ appIDs, components: appPaths }] },
        // Passwords saved for this site are offered at sign-in in the app, and the app may ask
        // for this site's passkeys and security keys (docs/two-step-design.md 6): Apple's
        // providers refuse an RP ID the app is not associated with.
        webcredentials: { apps: appIDs },
    });
}

export function assetLinks() {
    const fingerprints = list(appEnv.ANDROID_APP_CERT_SHA256).map((value) => value.toUpperCase());
    if (!fingerprints.length) return new Response('Not found', { status: 404 });
    return json(
        [
            'delegate_permission/common.handle_all_urls',
            // Saved passwords, and this site's passkeys through Credential Manager. The server
            // takes the app's answers only from the origins in WEBAUTHN_ANDROID_ORIGINS.
            'delegate_permission/common.get_login_creds',
        ].map((relation) => ({
            relation: [relation],
            target: {
                namespace: 'android_app',
                package_name: appEnv.ANDROID_APP_PACKAGE,
                sha256_cert_fingerprints: fingerprints,
            },
        })),
    );
}
