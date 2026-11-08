// @vitest-environment node
import { ROTATION_REQUEST_BYTES } from '@hushos/drive/protocol';
import { Elysia, type AnySchema } from 'elysia';
import { expect, test } from 'vitest';
import { ROTATION_BODY_BYTES } from '@/lib/body-caps';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * Clients send a rotation page in parts of at most ROTATION_REQUEST_BYTES, but a node is never
 * cut, so one heavy node is a request of its own. If the server's cap were below the heaviest node
 * its own schema accepts, that node could never be re-keyed and the rotation would stall for good.
 * The heaviest node is built from the route's schema itself: every optional field present, every
 * array at its maxItems, every string at its maxLength, so a raised bound fails here first.
 */

type Schema = {
    anyOf?: Schema[];
    const?: unknown;
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    maxItems?: number;
    uniqueItems?: boolean;
    maxLength?: number;
    pattern?: string;
    maximum?: number;
};

const UUID = '00000000-0000-4000-8000-000000000000';

function heaviest(schema: Schema, at: string): unknown {
    if ('const' in schema) return schema.const;
    if (schema.anyOf)
        return schema.anyOf
            .map((variant) => heaviest(variant, at))
            .reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    switch (schema.type) {
        case 'object':
            return Object.fromEntries(
                Object.entries(schema.properties ?? {}).map(([key, field]) => [
                    key,
                    heaviest(field, `${at}.${key}`),
                ]),
            );
        case 'array': {
            if (schema.maxItems === undefined) throw new Error(`${at} has no maxItems`);
            if (schema.uniqueItems) throw new Error(`${at} needs distinct items`);
            const item = heaviest(schema.items!, `${at}[]`);
            return Array.from({ length: schema.maxItems }, () => item);
        }
        case 'string':
            if (schema.maxLength !== undefined) return 'A'.repeat(schema.maxLength);
            if (schema.pattern?.startsWith('^[0-9a-f]{8}-')) return UUID;
            throw new Error(`${at} has no maxLength`);
        case 'integer':
        case 'number':
            return schema.maximum ?? Number.MAX_SAFE_INTEGER;
        case 'boolean':
            return false;
        case 'null':
            return null;
        default:
            throw new Error(`${at} has a type this test does not size: ${schema.type}`);
    }
}

test('the heaviest node the rotation route accepts fits under its body cap', async () => {
    const app = await loadApi();
    const route = (app.routes as unknown as (ApiRoute & { hooks: { body?: Schema } })[]).find(
        (r) => r.method === 'POST' && r.path === '/api/drive/nodes/:id/rotation/nodes',
    );
    const body = route!.hooks.body!;
    const heavy = {
        workspaceId: heaviest(body.properties!.workspaceId!, 'workspaceId'),
        nodes: [heaviest(body.properties!.nodes!.items!, 'nodes[]')],
    };
    // The route's own schema takes it, so it is a node a client may really send.
    const check = new Elysia().post('/', { body: body as AnySchema }, () => 'ok');
    const json = JSON.stringify(heavy);
    const reply = await check.handle(
        new Request('http://localhost/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: json,
        }),
    );
    expect(reply.status).toBe(200);
    const size = new TextEncoder().encode(json).length;
    // About 6.8 MiB today, nearly all of it a thousand hybrid shares.
    expect(size).toBeGreaterThan(ROTATION_REQUEST_BYTES);
    // And any part a client makes of lighter nodes fits too.
    expect(ROTATION_REQUEST_BYTES).toBeLessThanOrEqual(ROTATION_BODY_BYTES);
    expect(size).toBeLessThanOrEqual(ROTATION_BODY_BYTES);
});
