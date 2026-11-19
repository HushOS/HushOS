// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { cutJpeg, exifOrientation, JpegRefused } from './jpeg';
import { contains, expected, fixture, leaks } from './pdf-reader.testkit';

/*
 * The cutter against e2e/fixtures/images/expected.json, whose outputs make.py works out on its
 * own from the parts it labels kept or dropped. The core's cutter is held to the same file
 * (crates/hushos-core/src/images_pdf/tests.rs), so the two cut every fixture to the same bytes.
 */

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('every fixture cuts as expected.json says', () => {
    test.each(expected.cut.map((c) => [c.file, c] as const))('%s', (name, c) => {
        const input = fixture(name);
        if (c.outcome !== 'ok') {
            expect(() => cutJpeg(input)).toThrow(JpegRefused);
            try {
                cutJpeg(input);
            } catch (error) {
                expect((error as JpegRefused).code).toBe(c.outcome);
            }
            return;
        }
        const cut = cutJpeg(input);
        expect(sha256(cut.bytes)).toBe(c.sha256);
        expect(cut.bytes.length).toBe(c.length);
        expect({
            width: cut.width,
            height: cut.height,
            components: cut.components,
            orientation: cut.orientation,
            adobe: cut.adobe,
        }).toEqual({
            width: c.width,
            height: c.height,
            components: c.components,
            orientation: c.orientation,
            adobe: c.adobe,
        });
        expect(leaks(cut.bytes)).toEqual([]);
    });
});

test('the fixtures carry what the cutter must cut', () => {
    // A fixture that stopped holding its metadata would let a cutter that keeps it pass.
    const has = (name: string, needle: string) =>
        expect(contains(fixture(name), new TextEncoder().encode(needle)), name).toBe(true);
    has('gps.jpg', 'Exif\0\0');
    has('xmp.jpg', 'HUSHOS-CANARY-XMP');
    has('iptc.jpg', 'HUSHOS-CANARY-IPTC');
    has('between-scans.jpg', 'HushCanaryCam');
    has('mpf-trailer.jpg', 'HUSHOS-CANARY-MPF');
    has('progressive.jpg', 'HUSHOS-CANARY-COM');
    has('jfif-thumbnail.jpg', 'HUSHOS-CANARY-JFIF');
    const icc = new TextEncoder().encode('ICC_PROFILE\0');
    expect(contains(cutJpeg(fixture('icc.jpg')).bytes, icc)).toBe(true);
    expect(
        contains(cutJpeg(fixture('adobe-cmyk.jpg')).bytes, new TextEncoder().encode('Adobe')),
    ).toBe(true);
});

test('a JPEG cut short anywhere is refused or ended, and never lets metadata through', () => {
    const whole = fixture('between-scans.jpg');
    for (let end = 0; end < whole.length; end++) {
        let cut;
        try {
            cut = cutJpeg(whole.subarray(0, end));
        } catch (error) {
            expect(error).toBeInstanceOf(JpegRefused);
            continue;
        }
        expect(cut.bytes.subarray(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
        expect(leaks(cut.bytes)).toEqual([]);
    }
});

test('orientation is read from both byte orders, and only a sensible one', () => {
    expect(cutJpeg(fixture('orientation-3.jpg')).orientation).toBe(3); // big-endian
    expect(cutJpeg(fixture('orientation-6.jpg')).orientation).toBe(6); // little-endian
    const tiff = (entry: number[]) =>
        new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, ...entry]);
    expect(exifOrientation(tiff([0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0]))).toBe(8);
    expect(exifOrientation(tiff([0x12, 0x01, 3, 0, 1, 0, 0, 0, 9, 0, 0, 0]))).toBeNull();
    expect(exifOrientation(tiff([0x12, 0x01, 4, 0, 1, 0, 0, 0, 6, 0, 0, 0]))).toBeNull();
    expect(exifOrientation(tiff([0x12, 0x01, 3, 0, 2, 0, 0, 0, 6, 0, 0, 0]))).toBeNull();
    expect(
        exifOrientation(new Uint8Array([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0x7f])),
    ).toBeNull();
});
