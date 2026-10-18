import { readFileSync } from 'node:fs';
import { encryptKey } from './aead';
import { createAreaLedger } from './area-ledger';
import { createSettingsKey, openSettingsKey, SETTINGS_PAD_STEP } from './contacts';
import { ROOT } from './device-record-testkit';
import { CHECKED, mlDsaKeysOf, pattern } from './group-testkit';
import { pinAfter } from './group-trust';
import { sealAreaGrant, sealGroupKey } from './groups';
import { decode, encode } from './keys';
import {
    areaKey,
    canonical,
    chainOf,
    family,
    joinCodeWith,
    pin,
    runOn,
    session,
    wire,
} from './roster-calls-testkit';
import {
    createGroupSession,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
} from './session-groups';
import { settingsOpenFor } from './settings-marks';
import { grantAreaKey, openAreaSelfGrant, type WorkspaceKeyEnvelope } from './workspace';

/*
 * The settings document opened by the session itself and family folders
 * opened from route 25 (groups 1d, Core 6), for the shared fixtures: the twin
 * of crates/hushos-core/tests/common/settings_areas.rs. Both twins run the
 * cases of crates/hushos-core/fixtures/settings-area-cases.json over the
 * roster-call family through their own code (here the worker's
 * settingsKeyOpen and settingsOpen (settings-marks.ts) and groupOpenArea;
 * there the core's AreaLedger::use_settings_envelope and open_family_area),
 * check each case's `expected`, and write into their roster-call document
 * what they sealed:
 *
 * - `settingsReadings`: each step's settings key and document envelopes,
 *   read by the other twin to the same outcomes (each step's answer, the
 *   family's acceptance, person 4's admission and person 2's join code);
 * - `areaOpens`: each case's self-grant (sealed by this twin) and outcome,
 *   opened by the other twin alike; every self-grant this twin made to store
 *   is opened by the other to the folder's key, and opens the folder there.
 */

type Json = Record<string, any>;
type Call = <K extends keyof GroupResults>(
    operation: K,
    input: unknown,
) => Promise<GroupResults[K]>;

/* The shared cases, read when a fixture is built or checked (never at import: the fuzz bundle has no file URL). */
let loaded: { settings: Json[]; areas: Json[] } | undefined;
export function cases() {
    loaded ??= JSON.parse(
        readFileSync(
            new URL(
                '../../../crates/hushos-core/fixtures/settings-area-cases.json',
                import.meta.url,
            ),
            'utf8',
        ),
    ) as { settings: Json[]; areas: Json[] };
    return loaded;
}

const OTHER_GROUP = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const FOREIGN_AREA = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const otherRoot = () => pattern(32, 77);

/* A person's id as a case names it: p2..p5, or P4 for p4's in capitals. */
async function idOf(name: string) {
    const id = (await family()).p[Number(name.slice(1)) - 1]!.userId;
    return name.startsWith('P') ? id.toUpperCase() : id;
}

async function groupPinAtHead() {
    const f = await family();
    return pinAfter([], await chainOf(f.h.keys[0]!.publicKey, f.groupId, f.h.rosters, []), CHECKED);
}

/* A case's document as JSON text, its contacts in the case's member order. */
export async function documentOf(spec: Json = {}): Promise<string> {
    const f = await family();
    let contacts: unknown;
    if (spec.contacts === undefined) {
        const all: Json = {};
        for (const n of [2, 3, 4, 5]) all[f.p[n - 1]!.userId] = await pin(n);
        contacts = all;
    } else if (Array.isArray(spec.contacts)) {
        const members: Json = {};
        for (const [key, value] of spec.contacts as [string, Json][]) {
            if ('raw' in value) {
                members[await idOf(key)] = value.raw;
                continue;
            }
            const made: Json = { ...(await pin(value.pin)) };
            if (value.userId) made.userId = await idOf(value.userId);
            for (const field of value.without ?? []) delete made[field];
            Object.assign(made, value.with ?? {});
            members[await idOf(key)] = made;
        }
        contacts = members;
    } else contacts = spec.contacts.raw;
    let groups: unknown;
    if (spec.groups === undefined) groups = { [f.groupId]: await groupPinAtHead() };
    else if ('rawGroups' in spec.groups) groups = spec.groups.rawGroups;
    else groups = { [f.groupId]: spec.groups.raw };
    return JSON.stringify({ version: spec.version ?? 2, contacts, groups });
}

/* Any text sealed as a version 2 settings envelope, padded as sealSettings pads (it would rewrite `version`). */
async function sealRaw(
    key: Uint8Array<ArrayBuffer>,
    userId: string,
    settingsVersion: number,
    text: string,
) {
    const json = new TextEncoder().encode(text);
    const plaintext = new Uint8Array(
        Math.max(1, Math.ceil(json.length / SETTINGS_PAD_STEP)) * SETTINGS_PAD_STEP,
    ).fill(0x20);
    plaintext.set(json);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const context = new TextEncoder().encode(
        JSON.stringify(['hushos/settings', 2, userId.toLowerCase(), settingsVersion]),
    );
    return {
        version: 2,
        settingsVersion,
        nonce: encode(nonce),
        ciphertext: encode(await encryptKey(plaintext, key, nonce, context)),
    };
}

/* A step's envelopes as this twin seals them for person 1's device (null: not served). */
async function sealStep(step: Json) {
    const f = await family();
    const userId = f.p[0]!.userId;
    const made = await createSettingsKey(step.key === 'other-root' ? otherRoot() : ROOT, userId);
    const envelope: Json = await sealRaw(made.key, userId, 5, await documentOf(step.document));
    if (step.tamper) {
        const bytes = decode(envelope.ciphertext);
        bytes[3]! ^= 1;
        envelope.ciphertext = encode(bytes);
    }
    if (step.envelope === 'legacy') envelope.version = 1;
    if (step.envelope === 'version-3') envelope.version = 3;
    return {
        key: step.key === 'missing' ? null : made.envelope,
        envelope: step.envelope === 'none' ? null : envelope,
    };
}

/* Person 1's worker under the shared root, with nothing read yet. */
async function worker1() {
    const f = await family();
    const p1 = f.p[0]!;
    const ledger = createAreaLedger();
    const host = {
        unlocked: () => ({ userId: p1.userId, root: ROOT.slice(), keyVersion: 1 }),
        identity: () => ({ userId: p1.userId, served: p1.served, history: [] }),
        hybridKeys: () => ({
            signingKey: p1.signer.signingKey.slice(),
            mlDsaSecretKey: p1.signer.mlDsaSecretKey.slice(),
        }),
        granteeSecrets: () => p1.secrets,
        ledger,
        workspaceKey: ledger.workspaceKey,
    } as unknown as GroupHost;
    const worker = createGroupSession(host);
    let id = 0;
    const call: Call = (operation, input) =>
        worker.handle({ id: ++id, operation, input } as GroupMessage) as never;
    return { worker, call };
}

/* What a case's area row carries: the grant from person 1 to `n`, and `selfGrant` as sealed. */
async function areaInput(n: number, spec: Json, selfGrant: WorkspaceKeyEnvelope | null) {
    const f = await family();
    const [p1, me] = [f.p[0]!, f.p[n - 1]!];
    const area =
        spec.area === 'foreign'
            ? { workspaceId: FOREIGN_AREA, idSeed: f.areas[0]!.idSeed }
            : f.areas[{ A1: 0, A2: 1, A3: 2 }[spec.area as 'A1' | 'A2' | 'A3']]!;
    const chain = await chainOf(f.h.keys[0]!.publicKey, f.groupId, f.h.rosters, []);
    let grant: Json | null = null;
    if (spec.grant) {
        const [index, version] = spec.grant.key as [number, number];
        const ctx = {
            groupId: f.groupId,
            workspaceId: area.workspaceId,
            workspaceKeyVersion: version,
            granteeUserId: me.userId,
            granteeKeyVersion: 1,
            granterUserId: p1.userId,
            rosterVersion: chain.roster.rosterVersion,
            rosterDigest: chain.rosterDigest,
        };
        // A folder nobody may grant (deleted, or not the family's): a grant of zeros, which opens nothing.
        const envelope = await sealAreaGrant(areaKey(index, version), ctx, {
            chain,
            areaIdSeed: area.idSeed,
            granteeKemPublicKey: me.kemPublicKey,
            granter: p1.signer,
        }).catch(() => new Uint8Array(4565));
        grant = { ...ctx, envelope: encode(envelope) };
    }
    return {
        groupId: f.groupId,
        workspaceId: area.workspaceId,
        idSeed: area.idSeed,
        servedVersion: spec.served,
        grant,
        granterMlDsaPublicKey:
            spec.grant && spec.grant.granterKey !== false ? p1.served.mlDsaPublicKey : null,
        selfGrant,
    };
}

/*
 * Person 1's device over `sealed` steps: each settings read's answer, then
 * the family's history accepted, and when it is, the group key and folders
 * opened, person 4 admitted and person 2's join code read.
 */
export async function runSettings(sealed: Json[]): Promise<Json> {
    const f = await family();
    const p1 = f.p[0]!;
    const { worker, call } = await worker1();
    const steps: unknown[] = [];
    for (const step of sealed) {
        try {
            // The worker's settingsKeyOpen, then its settingsOpen, as the web's data layer calls them.
            const settingsKey = step.key ? await openSettingsKey(ROOT, p1.userId, step.key) : null;
            await settingsOpenFor(worker, {
                userId: p1.userId,
                envelope: step.envelope,
                settingsKey,
                unlocked: true,
            });
            steps.push(
                step.envelope === null ? 'none' : step.envelope.version === 1 ? 'legacy' : 'opened',
            );
        } catch (error) {
            steps.push({ refused: (error as Error).message });
        }
    }
    const out: Json = { steps };
    try {
        const accepted = await call('groupAccept', {
            userId: p1.userId,
            groupId: f.groupId,
            served: {
                rosters: f.h.rosters.map(wire),
                successions: [],
                firstKeys: f.h.keys[0]!.publicKey,
                signerKeys: mlDsaKeysOf(...f.p),
            },
            record: null,
            checkedAt: CHECKED,
        });
        out.accept = accepted.status === 'accepted' ? 'accepted' : { refused: accepted.status };
    } catch (error) {
        out.accept = { refused: (error as Error).message };
    }
    if (out.accept !== 'accepted') return out;
    await openKeyAndFolders(call);
    const admitted = await runOn(call, { kind: 'admit', who: 4, roles: [] });
    out.admit = 'refused' in admitted ? { refused: admitted.refused } : 'staged';
    out.join = await joinCodeWith(
        call,
        { family: { groupId: f.groupId } },
        2,
        f.h.rosters.map(wire),
    );
    return out;
}

/* Person 1's own seal of the group key opened; A1 and A3 opened from person 1's grants to themself. */
async function openKeyAndFolders(call: Call) {
    const f = await family();
    const p1 = f.p[0]!;
    const chain = await chainOf(f.h.keys[0]!.publicKey, f.groupId, f.h.rosters, []);
    const ctx = {
        groupId: f.groupId,
        groupKeyVersion: 1,
        holderUserId: p1.userId,
        holderKeyVersion: 1,
        sealerUserId: p1.userId,
        rosterVersion: chain.roster.rosterVersion,
        rosterDigest: chain.rosterDigest,
    };
    const envelope = await sealGroupKey(pattern(64, 91), ctx, {
        chain,
        holderKemPublicKey: p1.kemPublicKey,
        sealer: p1.signer,
    });
    await call('groupOpenSeal', {
        groupId: f.groupId,
        seal: { ...ctx, envelope: encode(envelope) },
        sealerMlDsaPublicKey: p1.served.mlDsaPublicKey,
    });
    for (const [area, index, version] of [
        ['A1', 0, 1],
        ['A3', 2, 2],
    ] as const)
        await call(
            'groupOpenArea',
            await areaInput(1, { area, served: version, grant: { key: [index, version] } }, null),
        );
}

/* This twin's self-grant for a case: person `n`'s own wrap of the case's key, as the case says. */
export async function sealSelfGrant(n: number, spec: Json): Promise<WorkspaceKeyEnvelope | null> {
    const own = spec.selfGrant as Json | null;
    if (!own) return null;
    const f = await family();
    const areaName = own.area ?? spec.area;
    const workspaceId =
        areaName === 'foreign'
            ? FOREIGN_AREA
            : f.areas[{ A1: 0, A2: 1, A3: 2 }[areaName as 'A1' | 'A2' | 'A3']]!.workspaceId;
    const made = await grantAreaKey(
        areaKey(own.key[0], own.key[1]),
        own.root === 'other' ? otherRoot() : ROOT,
        f.p[n - 1]!.userId,
        own.group === 'other' ? OTHER_GROUP : f.groupId,
        workspaceId,
        1,
        own.version,
    );
    return own.envelopeVersion ? ({ ...made, version: own.envelopeVersion } as never) : made;
}

/* Person 2's device opening a case's folder: the outcome both twins must give, and the self-grant to store. */
export async function runArea(spec: Json, selfGrant: WorkspaceKeyEnvelope | null) {
    const call = (await session(2, {})) as Call;
    try {
        const opened = await call('groupOpenArea', await areaInput(2, spec, selfGrant));
        return {
            outcome: {
                from: opened.from,
                version: opened.version,
                writable: opened.writable,
                reason: opened.reason,
                stored: opened.selfGrantToStore?.workspaceKeyVersion ?? null,
            } as Json,
            stored: opened.selfGrantToStore,
        };
    } catch (error) {
        return { outcome: { refused: (error as Error).message } as Json, stored: null };
    }
}

/* Whether an outcome says what its case declared (the declaration leaves out what it does not care about). */
function says(outcome: Json, expected: Json) {
    return Object.entries(expected).every(([key, want]) =>
        key === 'join'
            ? Object.entries(want as Json).every(
                  ([k, v]) => canonical(outcome.join?.[k]) === canonical(v),
              )
            : canonical(outcome[key]) === canonical(want),
    );
}

/* A self-grant stored by a case: opened by person 2 to the folder's key, then opening the folder by itself. */
async function checkStored(spec: Json, stored: WorkspaceKeyEnvelope) {
    const f = await family();
    const key = await openAreaSelfGrant(ROOT, f.p[1]!.userId, f.groupId, stored);
    const expected = areaKey(spec.grant.key[0], stored.workspaceKeyVersion);
    if (encode(key) !== encode(expected))
        throw new Error(`${spec.name}: the stored self-grant's key`);
    const { outcome } = await runArea(
        { area: spec.area, served: spec.served, grant: null },
        stored,
    );
    if (outcome.from !== 'self-grant')
        throw new Error(
            `${spec.name}: the stored self-grant opens nothing: ${JSON.stringify(outcome)}`,
        );
}

/* This twin's sections of the roster-call document. */
export async function fixture() {
    const settingsReadings: Json[] = [];
    for (const spec of cases().settings) {
        const sealed = await Promise.all((spec.steps as Json[]).map(sealStep));
        const outcome = await runSettings(sealed);
        if (!says(outcome, spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
        settingsReadings.push({ name: spec.name, sealed, outcome });
    }
    const areaOpens: Json[] = [];
    for (const spec of cases().areas) {
        const selfGrant = await sealSelfGrant(2, spec);
        const { outcome, stored } = await runArea(spec, selfGrant);
        if (!says(outcome, spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
        if (stored) await checkStored(spec, stored);
        areaOpens.push({ name: spec.name, selfGrant, outcome, stored: stored ?? null });
    }
    return { settingsReadings, areaOpens };
}

/* The core's sections through this twin: every outcome the same (thrown otherwise). */
export async function check(doc: Json) {
    const readings = doc.settingsReadings as Json[];
    if (readings.length !== cases().settings.length) throw new Error('the same settings cases');
    for (const [index, reading] of readings.entries()) {
        const spec = cases().settings[index]!;
        if (reading.name !== spec.name) throw new Error(`${spec.name}: out of order`);
        const outcome = await runSettings(reading.sealed);
        if (canonical(outcome) !== canonical(reading.outcome))
            throw new Error(
                `${spec.name}: ${JSON.stringify(outcome)} here, ${JSON.stringify(reading.outcome)} there`,
            );
        if (!says(outcome, spec.expected))
            throw new Error(`${spec.name}: ${JSON.stringify(outcome)}`);
    }
    const opens = doc.areaOpens as Json[];
    if (opens.length !== cases().areas.length) throw new Error('the same area cases');
    for (const [index, open] of opens.entries()) {
        const spec = cases().areas[index]!;
        if (open.name !== spec.name) throw new Error(`${spec.name}: out of order`);
        const { outcome } = await runArea(spec, open.selfGrant);
        if (canonical(outcome) !== canonical(open.outcome))
            throw new Error(
                `${spec.name}: ${JSON.stringify(outcome)} here, ${JSON.stringify(open.outcome)} there`,
            );
        if (open.stored) await checkStored(spec, open.stored);
    }
}
