import { isOwner, parseRoster, type Roster, type RosterMember } from '../src/groups';
import { decode, encode } from '../src/keys';
import { companyHistory, webCompany } from './fixtures';

/*
 * Documents for the `company_next` target, written from a company both twins
 * hold (a fixture history, accepted through some roster) and a few changes a
 * device could ask its builder for: who signs, who holds what, who left, whose
 * keys moved, a company key or kit (one the chain had before, or a new one),
 * the auto-join rule and an automatic admission's day, and folders made,
 * re-keyed or deleted. Edits of a seed's JSON mostly break its grammar; these
 * stay inside it, so what refuses them is a rule of the chain or of the device.
 */

type Json = any;

/* One change to a document: its kind and two numbers that pick whom or what. */
export type Change = [kind: (typeof CHANGES)[number], a: number, b: number];

export const CHANGES = [
    'signer',
    'roles',
    'leave',
    'return',
    'keys',
    'admit',
    'drop',
    'custody',
    'kit',
    'rules',
    'day',
    'auto-admit',
    'new-area',
    'rotate',
    'retire',
    // Whole steps, as a device takes them: each a change with the keys its rule asks for.
    'remove-admin',
    'take-kit',
    'owners-step-down',
    'plant',
] as const;

/*
 * The companies to start from, as `[chain, through]`: the web's company of
 * seals at each roster, the core's own, and rule cases chosen for what they
 * leave standing (ten folders, a deleted folder, a second company key and
 * kit, someone who left, a recovery done, auto-join on with its count at one,
 * at the limit, and on the next day).
 */
const CASES = [
    'company-start',
    'nine-new-areas',
    'eight-rotations',
    'heads-count-a-new-area-and-a-tombstone',
    'kit-replaced-with-key',
    'custody-replaced',
    'left-without-roles',
    'after-kit-holder-left',
    'recovery-roster',
    'succession-by-an-owner',
    'auto-admission',
    'auto-count-follows',
    'auto-on-the-next-day-starts-at-one',
    'auto-with-the-newcomers-employee-area',
    'auto-after-turning-the-rule-off-and-on',
];

type Base = {
    chain: string;
    through: number;
    members: RosterMember[];
    /* Every live or deleted folder the chain lists, in the order it met them. */
    areas: { workspaceId: string; areaKind: string | undefined; retired: boolean }[];
    headsDigest: string;
    /* An Owner on the latest roster: who signs unless a change says otherwise. */
    signerUserId: string;
    /* Whether the latest roster's rules have auto-join on. */
    autoJoin: boolean;
};

function baseOf(chain: string, through: number): Base {
    const rosters: Roster[] = companyHistory(chain)
        .rosters.slice(0, through)
        .map((served: Json) => parseRoster(decode(served.statement)));
    let members: RosterMember[] = [];
    const areas = new Map<string, Base['areas'][number]>();
    for (const roster of rosters) {
        // `same` stands for the list before it.
        if (roster.membersSame === undefined) members = roster.members;
        for (const row of roster.areas ?? []) {
            const known = areas.get(row.workspaceId);
            areas.set(row.workspaceId, {
                workspaceId: row.workspaceId,
                areaKind: row.areaKind ?? known?.areaKind,
                retired: row.retired === true,
            });
        }
    }
    const latest = rosters.at(-1)!;
    return {
        chain,
        through,
        members,
        areas: [...areas.values()],
        headsDigest: latest.heads!.headsDigest,
        signerUserId: (members.find(isOwner) ?? members[0]!).userId,
        autoJoin: latest.rules?.autoJoin === true,
    };
}

let made: { bases: Base[]; people: RosterMember[] } | undefined;
function world() {
    if (made) return made;
    const bases: Base[] = [];
    const add = (chain: string, from = 1) => {
        const count = companyHistory(chain).rosters.length;
        for (let through = from; through <= count; through++) bases.push(baseOf(chain, through));
    };
    add('web');
    add('core');
    // A case's last roster and the one before it: after its point, and just before.
    for (const name of CASES) {
        const chain = `case:${name}`;
        add(chain, Math.max(1, companyHistory(chain).rosters.length - 1));
    }
    // Everyone any of them ever named, under every set of keys: whom to let in, and whose keys
    // to write into another's entry.
    const people = new Map<string, RosterMember>();
    for (const chain of ['web', 'core', ...CASES.map((name) => `case:${name}`)])
        for (const served of companyHistory(chain).rosters)
            for (const entry of parseRoster(decode(served.statement)).members)
                people.set(`${entry.userId}:${entry.keyVersion}:${entry.signingPublicKey}`, entry);
    made = { bases, people: [...people.values()] };
    return made;
}

export const baseCount = () => world().bases.length;
/* Where the companies with nine folders or more are, and those with auto-join on: few among the rest, and the only ones some rules can be reached from. */
export const basesWhere = (which: 'wide' | 'auto') =>
    world().bases.flatMap((base, at) =>
        (which === 'wide' ? base.areas.length >= 9 : base.autoJoin) ? [at] : [],
    );

/* The six role sets a company knows, some twice, and two it does not. */
const ROLE_SETS = [
    [],
    [],
    ['billing'],
    ['recovery'],
    ['billing', 'recovery'],
    ['data_admin', 'members'],
    ['data_admin', 'members'],
    ['billing', 'data_admin', 'members', 'recovery'],
    ['billing', 'data_admin', 'members', 'recovery'],
    ['recovery'],
    ['members'],
    ['data_admin', 'members', 'recovery'],
];
const LIMITS = [1, 2, 3, 10, 500, 0];
const DAYS = [
    '2026-11-09',
    '2026-11-10',
    '2026-11-10',
    '2026-11-11',
    '2026-11-11',
    '2026-11-12',
    '2027-01-01',
    '2026-11-10',
    '2026-11-11',
    '2026-11-31',
];
/* How many folders a re-keying touches: the limit is 8. */
const ROTATIONS = [1, 1, 2, 3, 8, 8, 9, 9, 10, 10];
/* Folders no fixture company has, to make. */
const NEW_AREAS = [0, 1, 2, 3].map((n) => `d000000${n}-8dfc-4914-8447-0417b55e2ec5`);
const key = (n: number) =>
    encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7) % 256));

/* A key nobody had: `source` with its first byte changed. */
function other(source: string, n: number) {
    const bytes = decode(source);
    bytes[0] = (bytes[0]! + 1 + (n % 3)) % 256;
    return encode(bytes);
}

/*
 * A company key or kit for the next version: one of the testkit's own (any of
 * which the chain may have had before, at this version or another), or one
 * like it that no chain had.
 */
const freshCustody = (n: number) => custodyKey(3 * n + 1 + (n % 2));
const freshKit = (n: number) => kitKeys(3 * n + 1);
function custodyKey(n: number): Json {
    const keys = webCompany().keys.custody.map((k: Json) => k.publicKey);
    const from = keys[n % keys.length];
    if (n % 3 === 0) return from;
    return n % 3 === 1
        ? { ...from, encryptionPublicKey: other(from.encryptionPublicKey, n) }
        : {
              encryptionPublicKey: other(from.encryptionPublicKey, n),
              kemPublicKey: other(from.kemPublicKey, n),
          };
}
function kitKeys(n: number): Json {
    const kits = webCompany().keys.kits.map((k: Json) => k.publicKeys);
    const from = kits[n % kits.length];
    if (n % 3 === 0) return from;
    const fresh = {
        encryptionPublicKey: other(from.encryptionPublicKey, n),
        kemPublicKey: other(from.kemPublicKey, n),
        signingPublicKey: other(from.signingPublicKey, n),
        mlDsaPublicKey: other(from.mlDsaPublicKey, n),
    };
    // All four new, or one of the four kept from a kit the chain may have had.
    const kept = ['encryptionPublicKey', 'kemPublicKey', 'signingPublicKey', 'mlDsaPublicKey'][
        (n >> 2) % 4
    ]!;
    return n % 3 === 1 ? fresh : { ...fresh, [kept]: from[kept] };
}

/*
 * The document for the base at `at` (any number) after `changes`, in order.
 * `by` says who signs unless a change does: an Owner (0), an Admin when the
 * company has one (1), or whoever is at that place in the list.
 */
export function companyNextDocument(at: number, changes: Change[], vouch = true, by = 0): Json {
    const { bases, people } = world();
    const base = bases[at % bases.length]!;
    let members = base.members.map((entry) => ({ ...entry, roles: [...entry.roles] }));
    const admin = base.members.find(
        (entry) => entry.status === 'active' && entry.roles.join() === 'data_admin,members',
    );
    const doc: Json = {
        chain: base.chain,
        through: base.through,
        signerUserId:
            by === 0
                ? base.signerUserId
                : by === 1
                  ? (admin?.userId ?? base.signerUserId)
                  : base.members[by % base.members.length]!.userId,
        vouch,
        areaKeys: [],
        retireAreas: [],
        org: { headsDigest: base.headsDigest },
    };
    const pick = (n: number) => (members.length ? members[n % members.length] : undefined);
    const among = (n: number, role: string) => {
        const holders = members.filter(
            (entry) => entry.status === 'active' && entry.roles.includes(role as never),
        );
        return holders.length ? holders[n % holders.length] : undefined;
    };
    const strangers = () =>
        people.filter((person) => !members.some((entry) => entry.userId === person.userId));
    const area = (workspaceId: string, n: number, areaKind: string | null) => ({
        workspaceId,
        workspaceKey: key(n),
        rootKey: key(n + 101),
        areaKind,
        listDigest: base.headsDigest,
    });
    const admit = (n: number, roles: string[]) => {
        const from = strangers();
        if (!from.length) return;
        members.push({
            ...from[n % from.length]!,
            status: 'active',
            roles: roles as RosterMember['roles'],
        });
    };
    for (const [kind, a, b] of changes) {
        const entry = pick(a);
        switch (kind) {
            case 'signer':
                if (entry) doc.signerUserId = entry.userId;
                break;
            case 'roles':
                if (entry) entry.roles = ROLE_SETS[b % ROLE_SETS.length] as RosterMember['roles'];
                break;
            case 'leave':
                // Mostly as a device writes it, roles emptied; sometimes with the roles left on.
                if (entry) {
                    entry.status = 'left';
                    if (b % 4 !== 0) entry.roles = [];
                }
                break;
            case 'return':
                if (entry) entry.status = 'active';
                break;
            case 'keys': {
                // Another identity's keys in an entry (half the time one that signs member lists):
                // the person's own later ones, or anyone's.
                const from = people[b % people.length]!;
                const entry = (b % 2 === 0 && among(a, 'members')) || pick(a);
                if (!entry) break;
                entry.encryptionPublicKey = from.encryptionPublicKey;
                entry.signingPublicKey = from.signingPublicKey;
                entry.mlDsaPublicKeyDigest = from.mlDsaPublicKeyDigest;
                entry.kemPublicKeyDigest = from.kemPublicKeyDigest;
                if (b % 3 !== 0) entry.keyVersion = from.keyVersion + (b % 5 === 1 ? 1 : 0);
                break;
            }
            case 'admit':
                admit(a, ROLE_SETS[b % ROLE_SETS.length]!);
                break;
            case 'drop':
                members = members.filter((at) => at !== entry);
                break;
            case 'custody':
                doc.org.custodyKey = custodyKey(a);
                break;
            case 'kit':
                doc.org.kit = kitKeys(a);
                // A new kit comes with a new company key, unless this is the roster that forgets.
                if (b % 4 !== 0) doc.org.custodyKey ??= custodyKey(b);
                break;
            case 'rules':
                doc.org.rules = {
                    autoJoin: a % 3 !== 0,
                    autoJoinDailyLimit: LIMITS[b % LIMITS.length],
                };
                break;
            case 'day':
                doc.org.autoUtcDay = DAYS[a % DAYS.length];
                break;
            case 'auto-admit':
                // As the worker does: one Member, the day, and sometimes their own folder.
                admit(a, []);
                doc.org.autoUtcDay = DAYS[b % DAYS.length];
                if (a % 3 === 0) doc.areaKeys.push(area(NEW_AREAS[b % 4]!, a, 'employee'));
                break;
            case 'new-area': {
                const workspaceId = NEW_AREAS[a % NEW_AREAS.length]!;
                if (!doc.areaKeys.some((at: Json) => at.workspaceId === workspaceId))
                    doc.areaKeys.push(
                        area(workspaceId, a, ['employee', 'shared', 'shared', null][b % 4]!),
                    );
                break;
            }
            case 'rotate': {
                // New keys for the first few folders the chain lists (a deleted one among them when
                // it has one), each of its own kind or, now and then, the other.
                const count = ROTATIONS[a % ROTATIONS.length]!;
                for (const [index, known] of base.areas.slice(0, count).entries()) {
                    if (doc.areaKeys.some((at: Json) => at.workspaceId === known.workspaceId))
                        continue;
                    const flip = b % 6 === 0 && index === 0;
                    const kind = flip
                        ? known.areaKind === 'shared'
                            ? 'employee'
                            : 'shared'
                        : b % 6 === 1
                          ? null
                          : (known.areaKind ?? null);
                    // One key for two folders, now and then: a key the roster had a line before.
                    const n = b % 7 === 0 ? a : a + index;
                    doc.areaKeys.push(area(known.workspaceId, n, kind));
                }
                break;
            }
            case 'retire': {
                // A folder the chain lists (live or deleted already), or, rarely, one it never had.
                const all = base.areas.map((at) => at.workspaceId);
                const workspaceId = b % 9 === 0 ? NEW_AREAS[0]! : all[a % all.length]!;
                if (!doc.retireAreas.includes(workspaceId)) doc.retireAreas.push(workspaceId);
                break;
            }
            case 'remove-admin': {
                // An Admin made a Member, or marked left, with the new company key rule 2 asks for.
                const admin = among(a, 'data_admin');
                if (!admin) break;
                if (b % 2 === 0) admin.status = 'left';
                admin.roles = admin.roles.filter(
                    (role) => b % 2 !== 0 && role === 'billing',
                ) as RosterMember['roles'];
                doc.org.custodyKey ??= freshCustody(a + b);
                if (b % 5 !== 0) doc.org.kit ??= freshKit(a + b);
                break;
            }
            case 'take-kit': {
                // The kit taken from a holder, with the new kit and key rule 7 asks for.
                const holder = among(a, 'recovery');
                if (!holder) break;
                holder.roles = holder.roles.filter(
                    (role) => role !== 'recovery',
                ) as RosterMember['roles'];
                doc.org.kit ??= freshKit(a + b);
                doc.org.custodyKey ??= freshCustody(a + b);
                break;
            }
            case 'plant': {
                // Someone else's keys in an Admin's entry, as the entry's own key version: an
                // Owner may write that, a fellow Admin may not (rule 8).
                const admins = members.filter(
                    (at) => at.status === 'active' && at.roles.join() === 'data_admin,members',
                );
                const admin = admins[a % (admins.length || 1)];
                const from = people[b % people.length]!;
                if (!admin) break;
                admin.encryptionPublicKey = from.encryptionPublicKey;
                admin.signingPublicKey = from.signingPublicKey;
                admin.mlDsaPublicKeyDigest = from.mlDsaPublicKeyDigest;
                admin.kemPublicKeyDigest = from.kemPublicKeyDigest;
                if (b % 2 === 0) admin.keyVersion += 1;
                break;
            }
            case 'owners-step-down':
                // Every Owner made an Admin, with a new kit and key: nobody is left to hold all four.
                for (const owner of members.filter(isOwner))
                    if (b % 4 !== 0 || owner.userId !== doc.signerUserId)
                        owner.roles = ['data_admin', 'members'];
                doc.org.kit ??= freshKit(a + b);
                doc.org.custodyKey ??= freshCustody(a + b);
                break;
        }
    }
    doc.members = members;
    return doc;
}

/*
 * Seed documents: every base unchanged, then a fixed walk of one to three
 * changes over them (a linear congruential sequence, so the files are the same
 * on every machine). The fuzzers of both twins start from these.
 */
export function companyNextSeeds(count = 96): Json[] {
    const out: Json[] = [];
    for (let at = 0; at < baseCount(); at++) out.push(companyNextDocument(at, []));
    let state = 20261110;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 8;
    for (let n = 0; n < count; n++) {
        const changes: Change[] = [];
        for (let k = 1 + (n % 3); k > 0; k--)
            changes.push([CHANGES[next() % CHANGES.length]!, next() % 1000, next() % 1000]);
        out.push(
            companyNextDocument(next(), changes, n % 6 !== 0, [0, 0, 1, 1, next() % 9][n % 5]),
        );
    }
    return out;
}
