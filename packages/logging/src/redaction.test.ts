import { initLogger, log, type WideEvent } from 'evlog';
import { beforeAll, describe, expect, test } from 'vitest';
import { loggingOptions } from './privacy';

/*
 * The redaction paths as evlog applies them, through the real logger: a
 * handler that attaches a request's fields to the wide event must not put a
 * sealed envelope, a signature or the settings key in the logs, whatever the
 * field is called and however deep it sits.
 */

const drained: WideEvent[] = [];

beforeAll(() => {
    initLogger({
        ...loggingOptions,
        silent: true,
        drain: ({ event }) => {
            drained.push(event);
        },
    });
});

function emitted(fields: Record<string, unknown>) {
    drained.length = 0;
    log.info(fields);
    expect(drained).toHaveLength(1);
    return JSON.stringify(drained[0]);
}

const SECRET = 'c2VhbGVkLWJ5dGVzLXRoYXQtbXVzdC1ub3QtbGVhaw';

describe('redaction', () => {
    test('every envelope, signature and the settings key is redacted, at any depth', () => {
        const fields = {
            shareEnvelope: SECRET,
            prevShareEnvelope: SECRET,
            metadataEnvelope: SECRET,
            metadataSignature: SECRET,
            settingsKey: { nonce: SECRET, ciphertext: SECRET },
            drive: {
                rotated: {
                    shares: [{ id: 'share-1', shareEnvelope: SECRET }],
                    versions: [{ contentKeyEnvelope: SECRET, signature: SECRET }],
                },
                identity: { kemSignature: SECRET },
                node: { keyEnvelope: SECRET, metadataSignature: SECRET },
            },
        };
        const line = emitted(fields);
        expect(line).not.toContain(SECRET);
        // What is not secret still says what happened.
        expect(line).toContain('share-1');
    });

    test('an unrelated field with the same value is kept, so the check above is not vacuous', () => {
        expect(emitted({ note: SECRET })).toContain(SECRET);
    });
});
