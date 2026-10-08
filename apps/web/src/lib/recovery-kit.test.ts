import { describe, expect, test } from 'vitest';
import { kitText, phraseFromKit } from './recovery-kit';

/*
 * The kit is how people get back into their account: the file the app writes
 * has to be the file the reset page reads, word for word and in order, and
 * nothing else may pass for one.
 */

const phrase = [
    'orbit maple harbor velvet quartz tidal onion cedar',
    'lantern pebble meadow canyon wheat object raven drift',
    'basket hollow ember fossil jungle kettle marble zebra',
].join(' ');
const account = { email: 'maya@example.com', id: '7f0c2a9e-0000-4000-8000-000000000000' };
const recovery = { recoveryVersion: 3, publicKey: 'abc', encryptedKey: 'def' };

describe('recovery kit', () => {
    test('a kit the app writes reads back as the same 24 words, in order', () => {
        expect(phraseFromKit(kitText(account, phrase, recovery))).toEqual(phrase.split(' '));
    });

    test('a kit saved again with Windows line endings still reads', () => {
        const kit = kitText(account, phrase, recovery).replaceAll('\n', '\r\n');
        expect(phraseFromKit(kit)).toEqual(phrase.split(' '));
    });

    test('a file that is not a kit is refused, even with a phrase line in it', () => {
        const pasted = `My notes\nThe same phrase on one line, for pasting:\n${phrase}\n`;
        expect(phraseFromKit(pasted)).toBeNull();
        expect(phraseFromKit('')).toBeNull();
    });

    test('a kit with a word missing or one too many is refused, not padded or cut', () => {
        const words = phrase.split(' ');
        const short = kitText(account, words.slice(0, 23).join(' '), recovery);
        const long = kitText(account, [...words, 'extra'].join(' '), recovery);
        expect(phraseFromKit(short)).toBeNull();
        expect(phraseFromKit(long)).toBeNull();
    });

    test('a kit whose phrase line was edited into something other than words is refused', () => {
        const kit = kitText(account, phrase, recovery).replace('orbit maple', 'orbit m4ple');
        expect(phraseFromKit(kit)).toBeNull();
    });
});
