import { mkdir, writeFile } from 'node:fs/promises';
import { $ } from 'bun';
import sharp from 'sharp';
import { logoSvg, wordmarkSvg } from '../src/lib/brand';

/* Writes public/brand from the mark in src/lib/brand.ts. Run: bun run brand:assets */
const dir = new URL('../public/brand/', import.meta.url);
await mkdir(dir, { recursive: true });
const files = {
    'hushos-logo.svg': logoSvg('#1c2848'),
    'hushos-logo-blue.svg': logoSvg('#2c428e'),
    'hushos-logo-on-dark.svg': logoSvg('#dfe3f2', '#13151b'),
    'hushos-logo-on-blue.svg': logoSvg('#fcfbf7', '#2c428e'),
    'hushos-wordmark.svg': wordmarkSvg('#1c2848'),
    'hushos-wordmark-on-dark.svg': wordmarkSvg('#dfe3f2', '#13151b'),
    'hushos-wordmark-on-blue.svg': wordmarkSvg('#fcfbf7', '#2c428e'),
    'README.txt': [
        'HushOS brand assets',
        '',
        'hushos-logo.svg            ink mark, transparent background',
        'hushos-logo-blue.svg       blue mark, transparent background',
        'hushos-logo-on-dark.svg    light mark on the dark desk',
        'hushos-logo-on-blue.svg    sheet-coloured mark on the brand blue field',
        'hushos-wordmark*.svg       mark + HushOS as outlines, same variants',
        'hushos-logo*.png           the same, rasterised at 1024 px square',
        'hushos-wordmark*.png       the same, rasterised at 2048 px wide',
        'android-chrome-512x512.png, apple-touch-icon.png   raster app icons',
        '',
        'Guidelines: /design.md on any HushOS instance.',
        '',
    ].join('\n'),
};
await $`rm -f brand/hushos-logo-white.svg brand/hushos-wordmark-white.svg`.cwd(
    new URL('../public/', import.meta.url).pathname,
);
for (const [name, svg] of Object.entries(files)) await writeFile(new URL(name, dir), svg);
// PNGs beside every SVG, for places that take no vector: logos square, wordmarks by width.
const pngs: string[] = [];
for (const [name, svg] of Object.entries(files)) {
    if (!name.endsWith('.svg')) continue;
    const png = name.replace(/\.svg$/, '.png');
    const image = sharp(Buffer.from(svg), { density: 300 });
    await image
        .resize(name.includes('wordmark') ? { width: 2048 } : { width: 1024, height: 1024 })
        .png()
        .toFile(new URL(png, dir).pathname);
    pngs.push(png);
}
const cwd = new URL('../public/', import.meta.url).pathname;

/*
 * App icons and favicons: the sheet-coloured mark on a full blue square, with no
 * rounded corners or clear margin. Tabs, Google's round result badge and iOS
 * each cut their own shape, and a shaped icon shows the host's colour through
 * the gaps. The maskable pair keeps the mark inside the launcher's safe circle.
 */
const icon = (side: number, scale = 1) =>
    sharp(Buffer.from(logoSvg('#fcfbf7', '#2c428e', 0, scale)), { density: 300 })
        .resize(side, side)
        .png()
        .toBuffer();
const icons: Record<string, Buffer> = {
    'favicon-16x16.png': await icon(16),
    'favicon-32x32.png': await icon(32),
    'apple-touch-icon.png': await icon(180),
    'android-chrome-192x192.png': await icon(192),
    'android-chrome-512x512.png': await icon(512),
    'maskable-icon-192x192.png': await icon(192, 0.8),
    'maskable-icon-512x512.png': await icon(512, 0.8),
    'favicon.ico': ico([await icon(16), await icon(32), await icon(48)]),
};
for (const [name, data] of Object.entries(icons))
    await writeFile(new URL(name, `file://${cwd}`), data);

// An ICO holding PNG entries: a 6-byte header, a 16-byte entry per image, then the images.
function ico(images: Buffer[]) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    const entries: Buffer[] = [];
    let offset = 6 + 16 * images.length;
    for (const image of images) {
        const side = image.readUInt32BE(16);
        const entry = Buffer.alloc(16);
        entry.writeUInt8(side >= 256 ? 0 : side, 0);
        entry.writeUInt8(side >= 256 ? 0 : side, 1);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(image.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += image.length;
    }
    return Buffer.concat([header, ...entries, ...images]);
}

const names = [...Object.keys(files), ...pngs].map((name) => `brand/${name}`);
await $`rm -f brand/hushos-brand-assets.zip`.cwd(cwd);
await $`zip -q brand/hushos-brand-assets.zip ${names} android-chrome-512x512.png apple-touch-icon.png`.cwd(
    cwd,
);
console.log(
    `wrote ${names.length} files and hushos-brand-assets.zip to public/brand, ${Object.keys(icons).length} icons to public`,
);
