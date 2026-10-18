import { describe, expect, test } from 'vitest';
import {
    checkClient,
    compareVersions,
    meetsMinimum,
    parseClientHeader,
    parseMinimums,
    UPCOMING_PROTOCOL_MINIMUM,
} from './protocol';

describe('client header', () => {
    test('parses name/version and refuses anything else', () => {
        expect(parseClientHeader('web/1.0.0')).toEqual({ name: 'web', version: '1.0.0' });
        expect(parseClientHeader(' CLI/0.4.2 ')).toEqual({ name: 'cli', version: '0.4.2' });
        // Clients from before product versioning sent the protocol number, and are still served.
        expect(parseClientHeader('ios/3')).toEqual({ name: 'ios', version: '3' });
        for (const bad of ['', 'web', '/1', 'web/', 'web/1.x', 'we b/1', 'web/1.2.3.4.5', null])
            expect(parseClientHeader(bad)).toBeNull();
    });

    test('orders versions numerically per segment, not as strings', () => {
        expect(compareVersions('1.10', '1.9')).toBe(1);
        expect(compareVersions('1.9', '1.10')).toBe(-1);
        expect(compareVersions('2', '2.0.0')).toBe(0);
        expect(compareVersions('0.4', '1')).toBe(-1);
    });
});

describe('product version minimum', () => {
    const client = (header: string) => parseClientHeader(header)!;

    test('a client meets a minimum at or above it, compared per segment', () => {
        expect(meetsMinimum(client('ios/1.0.0'), '1.0.0')).toBe(true);
        expect(meetsMinimum(client('ios/1.0.1'), '1.0.0')).toBe(true);
        expect(meetsMinimum(client('ios/1.10.0'), '1.9.0')).toBe(true);
        expect(meetsMinimum(client('ios/0.99.99'), '1.0.0')).toBe(false);
        expect(meetsMinimum(client('ios/1.9.9'), '1.10.0')).toBe(false);
    });

    test('a pre-1.0 build sending its protocol number never passes for a newer release', () => {
        // "3" compares above "1.0.0" segment by segment; it is an app from before 1.0.0.
        expect(meetsMinimum(client('ios/3'), UPCOMING_PROTOCOL_MINIMUM)).toBe(false);
        expect(meetsMinimum(client('android/3'), '0.0.1')).toBe(false);
        expect(meetsMinimum(client('web/10.0'), '1.0.0')).toBe(false);
        expect(meetsMinimum(client('web/2.0.0.1'), '1.0.0')).toBe(false);
        expect(meetsMinimum(client('web/01.0.0'), '1.0.0')).toBe(false);
        // The builds in people's hands before the release carry 0.1.0: below the coming floor.
        expect(meetsMinimum(client('ios/0.1.0'), UPCOMING_PROTOCOL_MINIMUM)).toBe(false);
    });

    test('a minimum that is not a product version is a configuration bug, not a pass', () => {
        expect(() => meetsMinimum(client('ios/1.0.0'), '3')).toThrow(/not a product version/);
        expect(() => meetsMinimum(client('ios/1.0.0'), '1.0')).toThrow(/not a product version/);
    });
});

describe('client check', () => {
    test('a client below its minimum is told to update; others pass; no header is a client bug', () => {
        const minimums = parseMinimums('web/1.2.0,cli/0.4.0');
        expect(checkClient('web/1.1.9', minimums)).toMatchObject({ status: 426 });
        expect(checkClient('web/1.1.9', minimums)).toMatchObject({ message: /Reload/ });
        expect(checkClient('cli/0.3.9', minimums)).toMatchObject({
            status: 426,
            message: /Update cli to version 0.4.0 or later/,
        });
        expect(checkClient('cli/0.4.0', minimums)).toMatchObject({ ok: true });
        expect(checkClient('web/1.2.0', minimums)).toMatchObject({ ok: true });
        // A tab open from before product versioning is below any floor and told to reload.
        expect(checkClient('web/3', minimums)).toMatchObject({ status: 426 });
        // A client the operator set no floor for is served whatever it says.
        expect(checkClient('sync/0.0.1', minimums)).toMatchObject({ ok: true });
        expect(checkClient('ios/3', minimums)).toMatchObject({ ok: true });
        expect(checkClient(undefined, minimums)).toMatchObject({ status: 400 });
        expect(checkClient('garbage', new Map())).toMatchObject({ status: 400 });
    });
});
