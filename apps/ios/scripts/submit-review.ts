#!/usr/bin/env bun
/*
 * Sends a release's iPhone build to App Review, through the App Store Connect API: the step done
 * by hand in App Store Connect until now (Distribution, + version, What's New, Add Build, Add for
 * Review, Submit). ios-release.yml runs it for `action=submit`; it also runs on a Mac:
 *
 *   ASC_KEY_PATH=key.p8 ASC_KEY_ID=… ASC_ISSUER_ID=… VERSION=1.2.3 BUILD=701 \
 *       WHATS_NEW="…" bun apps/ios/scripts/submit-review.ts
 *
 * VERSION is the release's version and BUILD its build number (scripts/build-number.sh --store at
 * the tag, the number archive.sh uploaded). It waits for that build to finish processing, makes
 * the App Store version if there isn't one (released automatically once approved, as every
 * release so far), puts What's New on each of its languages, attaches the build and submits.
 * WHATS_NEW may be left out only when the version already carries it. DRY_RUN=1 reads everything
 * and says what it would do, changing nothing.
 *
 * It stops, changing nothing, when the version is already in review or released, or when another
 * version is in review: App Store Connect takes one submission at a time, and which to withdraw is
 * a person's choice.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BUNDLE_ID = 'com.hushos.app';
const API = 'https://api.appstoreconnect.apple.com';

function need(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Set ${name}.`);
    return value;
}

const keyId = need('ASC_KEY_ID');
const issuerId = need('ASC_ISSUER_ID');
const key = createPrivateKey(readFileSync(need('ASC_KEY_PATH'), 'utf8'));
const version = need('VERSION');
const build = need('BUILD');
const whatsNew = process.env.WHATS_NEW?.trim() ?? '';
const dryRun = process.env.DRY_RUN === '1';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION ${version} is not X.Y.Z.`);
if (!/^\d+$/.test(build)) throw new Error(`BUILD ${build} is not a number.`);
if (whatsNew.length > 4000)
    throw new Error('WHATS_NEW is longer than App Store Connect takes (4,000 characters).');

/* A token for the next twenty minutes (Apple's limit), signed with the team key: ES256, the signature as r‖s. */
function token(): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
    return `${unsigned}.${signature.toString('base64url')}`;
}

type Resource = {
    id: string;
    type: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data?: { id: string; type: string } | null }>;
};
/* An attribute as text, or '' when it is missing or not text. */
const text = (resource: Resource | undefined, name: string): string => {
    const value = resource?.attributes?.[name];
    return typeof value === 'string' ? value : '';
};

async function call(
    method: string,
    path: string,
    body?: object,
): Promise<{ data: Resource | Resource[] }> {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : { data: [] };
}

const list = async (path: string) => (await call('GET', path)).data as Resource[];
/* A write, or what it would be under DRY_RUN. */
async function write(
    what: string,
    method: string,
    path: string,
    body: object,
): Promise<Resource | undefined> {
    if (dryRun) {
        console.log(`would ${what}`);
        return undefined;
    }
    const result = (await call(method, path, body)).data as Resource;
    console.log(what);
    return result;
}

const [app] = await list(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`);
if (!app) throw new Error(`No app ${BUNDLE_ID} in this team.`);

// The build, once Apple has processed it (usually 5-30 minutes after the upload).
let uploaded: Resource | undefined;
for (let attempt = 0; attempt < 40; attempt++) {
    [uploaded] = await list(
        `/v1/builds?filter[app]=${app.id}&filter[version]=${build}&filter[preReleaseVersion.version]=${version}&limit=1`,
    );
    const state = text(uploaded, 'processingState');
    if (state === 'VALID') break;
    if (state === 'FAILED' || state === 'INVALID')
        throw new Error(`Build ${version} (${build}) is ${state} in App Store Connect.`);
    console.log(
        uploaded
            ? `Build ${build} is ${state}; waiting.`
            : `Build ${version} (${build}) isn't in App Store Connect yet; waiting.`,
    );
    await Bun.sleep(30_000);
}
if (!uploaded || text(uploaded, 'processingState') !== 'VALID')
    throw new Error(
        `Build ${version} (${build}) didn't finish processing in 20 minutes; run this again later.`,
    );
const buildId = uploaded.id;
console.log(`Build ${version} (${build}) is ready.`);

// One submission at a time: a version already in review is for a person to withdraw or wait for.
const versions = await list(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`);
const IN_REVIEW = [
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'PENDING_DEVELOPER_RELEASE',
    'PROCESSING_FOR_DISTRIBUTION',
];
const busy = versions.find((v) => IN_REVIEW.includes(text(v, 'appStoreState')));
if (busy)
    throw new Error(
        `Version ${text(busy, 'versionString')} is ${text(busy, 'appStoreState')}; withdraw it or wait before submitting ${version}.`,
    );

let target = versions.find((v) => text(v, 'versionString') === version);
if (target && ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(text(target, 'appStoreState')))
    throw new Error(`Version ${version} is already released.`);

// A draft submission of this app's (one left from App Store Connect, say) is reused. It may already
// hold other things (a product page, an event, another version), and submitting it would send those
// too, so it may hold this version and nothing else. Checked before anything is changed.
const [draft] = await list(
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=1`,
);
const draftItems = draft
    ? await list(`/v1/reviewSubmissions/${draft.id}/items?include=appStoreVersion`)
    : [];
const others = draftItems.filter(
    (item) => !target || item.relationships?.appStoreVersion?.data?.id !== target.id,
);
if (others.length)
    throw new Error(
        `The draft review submission holds ${others.length} other item(s); remove them in App Store Connect or submit it there.`,
    );
target ??= await write(`make version ${version}`, 'POST', '/v1/appStoreVersions', {
    data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
    },
});

// What's New, on every language the version has (en-US today).
const localizations = target
    ? await list(`/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations`)
    : [];
if (!whatsNew && localizations.some((l) => !text(l, 'whatsNew').trim()))
    throw new Error(`Version ${version} has no What's New yet: set WHATS_NEW.`);
if (whatsNew) {
    for (const localization of localizations.length
        ? localizations
        : [{ id: '(new)', type: 'appStoreVersionLocalizations', attributes: { locale: 'en-US' } }])
        await write(
            `write What's New (${text(localization, 'locale') || 'en-US'})`,
            'PATCH',
            `/v1/appStoreVersionLocalizations/${localization.id}`,
            {
                data: {
                    type: 'appStoreVersionLocalizations',
                    id: localization.id,
                    attributes: { whatsNew },
                },
            },
        );
}

if (target)
    await write(
        `attach build ${build}`,
        'PATCH',
        `/v1/appStoreVersions/${target.id}/relationships/build`,
        { data: { type: 'builds', id: buildId } },
    );
else console.log(`would attach build ${build}`);

// The draft, or a new submission; the version in it; then sent.
const submission =
    draft ??
    (await write('open a review submission', 'POST', '/v1/reviewSubmissions', {
        data: {
            type: 'reviewSubmissions',
            attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
    }));
if (submission && target) {
    if (!draftItems.length)
        await write(`add version ${version} to it`, 'POST', '/v1/reviewSubmissionItems', {
            data: {
                type: 'reviewSubmissionItems',
                relationships: {
                    reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
                    appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } },
                },
            },
        });
    await write(
        `submit ${version} (${build}) for App Review`,
        'PATCH',
        `/v1/reviewSubmissions/${submission.id}`,
        {
            data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
        },
    );
} else console.log(`would submit ${version} (${build}) for App Review`);
