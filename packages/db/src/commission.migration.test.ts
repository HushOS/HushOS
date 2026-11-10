import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '../test/helpers';

/*
 * The commission safety migration as a deployment runs it: against a database migrated to the
 * release before it, holding affiliates and earnings that release wrote. A scratch database of
 * its own. What must hold (docs/company-billing-design.md 8.4): every earning from before keeps
 * its amounts to the unit and is given its pot, its payable date and, where it was paid, what was
 * paid, so nothing is held or lowered by the migration itself; amounts past an integer now fit;
 * and a container of the release before keeps recording earnings beside the new ones.
 */

const MIGRATION = '20261110045932_affiliate_commission_safety';

const testUrl = new URL(process.env.DATABASE_URL!);
const scratchName = `${testUrl.pathname.slice(1)}_commission_migration`;
if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unexpected test database name.');
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;

let admin: Client;
let pg: Client;

function statementsOf(name: string) {
    return readFileSync(new URL(`../drizzle/${name}/migration.sql`, import.meta.url), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.replace(/^--.*$/gm, '').trim())
        .filter(Boolean);
}

/* One migration in one transaction, as drizzle applies it. */
async function migrate(name: string) {
    await pg.query('begin');
    for (const statement of statementsOf(name)) await pg.query(statement);
    await pg.query('commit');
}

async function sqlState(work: () => Promise<unknown>) {
    try {
        await work();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
    }
}

/* The insert of the release before this one, in its own words: no `part`, no pot, integers. */
const OLD_INSERT = `insert into affiliate_earnings (affiliate_id, order_id, user_id, currency, net_amount, commission_amount)
    values ($1, $2, null, $3, $4, $5) on conflict (order_id) do nothing returning id`;

const affiliateId = randomUUID();
const pausedId = randomUUID();
const RECORDED = '2026-08-01T10:00:00.000Z';
const PAID = '2026-09-01T10:00:00.000Z';

const earnings = async () =>
    (
        await pg.query(
            `select order_id, part, currency, net_amount, commission_amount, pot_amount, paid_amount, payable_at, paid_at, order_refunded_at, created_at,
                    refunded_amount, clawback_amount, clawback_settled_amount, clawback_written_off_amount, flag, dispute_status, voided_at
             from affiliate_earnings order by order_id`,
        )
    ).rows;

beforeAll(async () => {
    admin = new Client({ connectionString: testUrl.toString() });
    await admin.connect();
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
    await admin.query(`create database "${scratchName}"`);
    pg = new Client({ connectionString: scratchUrl.toString() });
    await pg.connect();
    const earlier = readdirSync(new URL('../drizzle', import.meta.url))
        .filter((name) => /^\d{14}_/.test(name) && name < MIGRATION)
        .sort();
    for (const name of earlier) await migrate(name);

    const affiliate = `insert into affiliates (id, name, slug, code, percent_off, duration, commission_bps, active) values ($1, $2, $3, $4, 20, 'forever', 2000, $5)`;
    await pg.query(affiliate, [affiliateId, 'Creator', 'creator', 'CREATOR20', true]);
    await pg.query(affiliate, [pausedId, 'Paused', 'paused', 'PAUSED20', false]);
    // What the release before left: one unpaid, one paid, one paid whose order HushOS refunded
    // whole, and one at the most an integer column holds.
    await pg.query(OLD_INSERT, [affiliateId, 'order_a_unpaid', 'usd', 10_000, 2_000]);
    await pg.query(OLD_INSERT, [affiliateId, 'order_b_paid', 'inr', 79_900, 15_980]);
    await pg.query(OLD_INSERT, [affiliateId, 'order_c_refunded', 'usd', 799, 159]);
    await pg.query(OLD_INSERT, [pausedId, 'order_d_largest', 'inr', 2_147_483_647, 429_496_729]);
    await pg.query(`update affiliate_earnings set created_at = $1`, [RECORDED]);
    await pg.query(
        `update affiliate_earnings set paid_at = $1 where order_id in ('order_b_paid', 'order_c_refunded')`,
        [PAID],
    );
    await pg.query(
        `update affiliate_earnings set order_refunded_at = $1 where order_id = 'order_c_refunded'`,
        [PAID],
    );
    await migrate(MIGRATION);
}, 120_000);

// Dropping a database checkpoints first, which takes seconds on a busy machine.
afterAll(async () => {
    await pg?.end();
    await admin?.query(`drop database if exists "${scratchName}" with (force)`);
    await admin?.end();
    await closeDatabase();
}, 120_000);

describe('what the migration leaves', () => {
    test('every earning from before with its amounts to the unit, its pot, a payable date that holds nothing, and what was paid only where it was paid', async () => {
        const recorded = new Date(RECORDED);
        const paid = new Date(PAID);
        const untouched = {
            part: 'main',
            refunded_amount: '0',
            clawback_amount: '0',
            clawback_settled_amount: '0',
            clawback_written_off_amount: '0',
            flag: null,
            dispute_status: null,
            voided_at: null,
            created_at: recorded,
            // When it was recorded: an earning from before the switch is not held.
            payable_at: recorded,
        };
        expect(await earnings()).toEqual([
            {
                ...untouched,
                order_id: 'order_a_unpaid',
                currency: 'usd',
                net_amount: '10000',
                commission_amount: '2000',
                pot_amount: '2000',
                paid_amount: null,
                paid_at: null,
                order_refunded_at: null,
            },
            {
                ...untouched,
                order_id: 'order_b_paid',
                currency: 'inr',
                net_amount: '79900',
                commission_amount: '15980',
                pot_amount: '15980',
                paid_amount: '15980',
                paid_at: paid,
                order_refunded_at: null,
            },
            {
                ...untouched,
                order_id: 'order_c_refunded',
                currency: 'usd',
                net_amount: '799',
                commission_amount: '159',
                pot_amount: '159',
                paid_amount: '159',
                paid_at: paid,
                // The migration makes no clawback of it: that is the cut-over's, once, when the
                // switch is turned on.
                order_refunded_at: paid,
            },
            {
                ...untouched,
                order_id: 'order_d_largest',
                currency: 'inr',
                net_amount: '2147483647',
                commission_amount: '429496729',
                pot_amount: '429496729',
                paid_amount: null,
                paid_at: null,
                order_refunded_at: null,
            },
        ]);
    });

    test('affiliates as they were, with no pause or removal time: the migration decides nothing about them', async () => {
        const rows = await pg.query(
            `select slug, active, paused_at, removed_at from affiliates order by slug`,
        );
        expect(rows.rows).toEqual([
            { slug: 'creator', active: true, paused_at: null, removed_at: null },
            { slug: 'paused', active: false, paused_at: null, removed_at: null },
        ]);
        expect((await pg.query(`select 1 from affiliate_ledger_state`)).rowCount).toBe(0);
        expect((await pg.query(`select 1 from affiliate_disputes`)).rowCount).toBe(0);
    });

    test('amounts that an integer could not hold now fit, and every constraint it added is validated', async () => {
        const types = await pg.query(
            `select column_name, data_type from information_schema.columns
             where table_name = 'affiliate_earnings' and column_name in ('net_amount', 'commission_amount', 'pot_amount', 'paid_amount', 'refunded_amount', 'clawback_amount')
             order by column_name`,
        );
        expect(types.rows.map((row) => row.data_type)).toEqual(Array(6).fill('bigint'));
        await pg.query(
            `insert into affiliate_earnings (affiliate_id, order_id, currency, net_amount, commission_amount, pot_amount) values ($1, 'order_e_huge', 'inr', $2, $3, $3)`,
            [affiliateId, '90071992547409935', '18014398509481987'],
        );
        const [huge] = (
            await pg.query(
                `select net_amount, commission_amount from affiliate_earnings where order_id = 'order_e_huge'`,
            )
        ).rows;
        expect(huge).toEqual({
            net_amount: '90071992547409935',
            commission_amount: '18014398509481987',
        });
        const unvalidated = await pg.query(
            `select conname from pg_constraint where conrelid in ('affiliate_earnings'::regclass, 'affiliates'::regclass, 'affiliate_disputes'::regclass, 'affiliate_ledger_state'::regclass) and not convalidated`,
        );
        expect(unvalidated.rows).toEqual([]);
    });
});

describe('beside a container of the release before', () => {
    test('its insert still records an earning once per order, with a pot the new code reads from its commission', async () => {
        const first = await pg.query(OLD_INSERT, [
            affiliateId,
            'order_f_rolling',
            'usd',
            5_000,
            1_000,
        ]);
        expect(first.rowCount).toBe(1);
        expect(
            (await pg.query(OLD_INSERT, [affiliateId, 'order_f_rolling', 'usd', 5_000, 1_000]))
                .rowCount,
        ).toBe(0);
        // An order the migrated rows already hold is refused the same way.
        expect(
            (await pg.query(OLD_INSERT, [affiliateId, 'order_a_unpaid', 'usd', 1, 1])).rowCount,
        ).toBe(0);
        const [row] = (
            await pg.query(
                `select part, pot_amount, payable_at, paid_amount, refunded_amount from affiliate_earnings where order_id = 'order_f_rolling'`,
            )
        ).rows;
        expect(row).toEqual({
            part: 'main',
            pot_amount: null,
            payable_at: null,
            paid_amount: null,
            refunded_amount: '0',
        });
    });

    test('the new insert names (order_id, part), and neither a second row of a part nor an unknown part gets in', async () => {
        const fresh = `insert into affiliate_earnings (affiliate_id, order_id, part, currency, net_amount, commission_amount) values ($1, $2, $3, 'usd', 1000, 200)`;
        const guarded = `${fresh} on conflict (order_id, part) do nothing`;
        expect((await pg.query(guarded, [affiliateId, 'order_g_new', 'main'])).rowCount).toBe(1);
        expect((await pg.query(guarded, [affiliateId, 'order_g_new', 'main'])).rowCount).toBe(0);
        expect(await sqlState(() => pg.query(fresh, [affiliateId, 'order_g_new', 'main']))).toBe(
            '23505',
        );
        expect(await sqlState(() => pg.query(fresh, [affiliateId, 'order_h', 'third']))).toBe(
            '23514',
        );
        // Until the release that splits an order in two drops it, the unique order id still
        // refuses a second part: both hold while an order has one row.
        expect(await sqlState(() => pg.query(fresh, [affiliateId, 'order_g_new', 'sub']))).toBe(
            '23505',
        );
    });
});
