import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import expected from '../../../../../e2e/fixtures/images/expected.json';

/*
 * Test help for the images-to-PDF suites: the shared fixtures, what must never be inside a PDF,
 * and a PDF read back with pdf.js the way a reader shows it. Each page's one image is sampled
 * where a person would look (the top, the left, the bottom right), through the matrix pdf.js
 * paints it with, so "upright" is what a reader shows, not what the writer meant.
 */

export const FIXTURES = join(__dirname, '../../../../../e2e/fixtures/images');
export const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
export { expected };

const find = (haystack: Uint8Array, needle: Uint8Array) => {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
};
export const contains = (haystack: Uint8Array, needle: Uint8Array) => find(haystack, needle) >= 0;
const text = (value: string) => new TextEncoder().encode(value);
const unhex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

/* EXIF's, XMP's and IPTC's signatures, the fixtures' canaries and the GPS latitude's bytes found in `bytes`. */
export function leaks(bytes: Uint8Array) {
    const needles: [string, Uint8Array][] = [
        ['Exif', text('Exif\0\0')],
        ['XMP', text('http://ns.adobe.com/xap/1.0/')],
        ['Photoshop', text('Photoshop 3.0')],
        ['8BIM', text('8BIM')],
        ['MPF', text('MPF\0')],
        ...expected.canaries.text.map((value): [string, Uint8Array] => [value, text(value)]),
        ...expected.canaries.gpsLatitudeHex.map((hex): [string, Uint8Array] => [hex, unhex(hex)]),
    ];
    return needles.filter(([, needle]) => contains(bytes, needle)).map(([name]) => name);
}

type Rgb = [number, number, number];
export type ReadPage = {
    width: number;
    height: number;
    /* The matrix the page's image is painted with. */
    matrix: number[];
    image: { width: number; height: number };
    /* The colour a reader shows at (x, y) of the page, in points from the bottom left; null off the image or transparent. */
    at: (x: number, y: number) => Rgb | null;
};

export async function readPdf(bytes: Uint8Array): Promise<ReadPage[]> {
    const pdf = await pdfjs.getDocument({
        data: bytes.slice(),
        isOffscreenCanvasSupported: false,
    }).promise;
    const pages: ReadPage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const ops = await page.getOperatorList();
        let matrix: number[] | null = null;
        let id: string | null = null;
        ops.fnArray.forEach((fn, i) => {
            if (fn === pdfjs.OPS.transform) matrix = ops.argsArray[i] as number[];
            if (fn === pdfjs.OPS.paintImageXObject) id = (ops.argsArray[i] as [string])[0];
        });
        if (!matrix || !id) throw new Error(`page ${number} paints no image`);
        const image = await new Promise<{
            width: number;
            height: number;
            kind: number;
            data: Uint8ClampedArray;
        }>((resolve) => page.objs.get(id!, resolve));
        const [a, b, c, d, e, f] = matrix as number[];
        const det = a! * d! - b! * c!;
        const channels = image.kind === 3 ? 4 : image.kind === 2 ? 3 : 1;
        const [, , width, height] = page.view as number[];
        pages.push({
            width: width!,
            height: height!,
            matrix,
            image: { width: image.width, height: image.height },
            at(x, y) {
                // The page point back to the image's unit square, then to its pixel (row 0 at the top).
                const s = (d! * (x - e!) - c! * (y - f!)) / det;
                const t = (-b! * (x - e!) + a! * (y - f!)) / det;
                if (s < 0 || s >= 1 || t <= 0 || t > 1) return null;
                const col = Math.floor(s * image.width);
                const row = Math.floor((1 - t) * image.height);
                const at = (row * image.width + col) * channels;
                if (channels === 4 && image.data[at + 3]! < 128) return null;
                const px = image.data;
                return channels === 1
                    ? [px[at]!, px[at]!, px[at]!]
                    : [px[at]!, px[at + 1]!, px[at + 2]!];
            },
        });
    }
    return pages;
}

/* The fixtures' upright picture: red along the top, green down the left, blue at the bottom right. */
export function looksUpright(page: ReadPage) {
    const [x, y, w, h] = imageBox(page);
    const red = (rgb: Rgb | null) => !!rgb && rgb[0] > 150 && rgb[1] < 90 && rgb[2] < 90;
    const green = (rgb: Rgb | null) => !!rgb && rgb[1] > 110 && rgb[0] < 90 && rgb[2] < 110;
    const blue = (rgb: Rgb | null) => !!rgb && rgb[2] > 150 && rgb[0] < 90;
    return (
        red(page.at(x + w / 2, y + h - h * 0.04)) &&
        green(page.at(x + w * 0.03, y + h / 2)) &&
        blue(page.at(x + w * 0.9, y + h * 0.1)) &&
        !red(page.at(x + w / 2, y + h * 0.04))
    );
}

/* Where the image shows on its page: x, y, width, height. */
export function imageBox(page: ReadPage): [number, number, number, number] {
    const [a, b, c, d, e, f] = page.matrix as [number, number, number, number, number, number];
    const xs = [e, e + a, e + c, e + a + c];
    const ys = [f, f + b, f + d, f + b + d];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}
