import { describe, expect, test } from 'vitest';
import { checkClient, compareVersions, parseClientHeader, parseMinimums } from './protocol';

describe('client header', () => {
    test('parses name/version and refuses anything else', () => {
        expect(parseClientHeader('web/1')).toEqual({ name: 'web', version: '1' });
        expect(parseClientHeader(' CLI/0.4.2 ')).toEqual({ name: 'cli', version: '0.4.2' });
        for (const bad of ['', 'web', '/1', 'web/', 'web/1.x', 'we b/1', 'web/1.2.3.4.5', null])
            expect(parseClientHeader(bad)).toBeNull();
    });

    test('orders versions numerically per segment, not as strings', () => {
        expect(compareVersions('1.10', '1.9')).toBe(1);
        expect(compareVersions('1.9', '1.10')).toBe(-1);
        expect(compareVersions('2', '2.0.0')).toBe(0);
        expect(compareVersions('0.4', '1')).toBe(-1);
    });

    test('a client below its minimum is told to update; others pass; no header is a client bug', () => {
        const minimums = parseMinimums('web/2,cli/0.4');
        expect(checkClient('web/1.9', minimums)).toMatchObject({ status: 426 });
        expect(checkClient('web/1.9', minimums)).toMatchObject({ message: /Reload/ });
        expect(checkClient('cli/0.3.9', minimums)).toMatchObject({
            status: 426,
            message: /Update cli to version 0.4 or later/,
        });
        expect(checkClient('cli/0.4', minimums)).toMatchObject({ ok: true });
        expect(checkClient('web/2', minimums)).toMatchObject({ ok: true });
        // A client the operator set no floor for is served whatever it says.
        expect(checkClient('sync/0.0.1', minimums)).toMatchObject({ ok: true });
        expect(checkClient(undefined, minimums)).toMatchObject({ status: 400 });
        expect(checkClient('garbage', new Map())).toMatchObject({ status: 400 });
    });
});
