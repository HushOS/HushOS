import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { Logo } from '../src/components/logo';
import { BADGE_SIDE, badgeSvg, LOGO_BLACK, LOGO_WHITE } from '../src/lib/brand';

const publicDirectory = resolve(import.meta.dirname, '../public');
const emailDirectory = resolve(
    import.meta.dirname,
    '../../../packages/emails/src/templates/static',
);
await mkdir(emailDirectory, { recursive: true });
await mkdir(resolve(publicDirectory, 'email'), { recursive: true });
/*
 * The emails' logo: the brand square (lib/brand.ts) as one image, at three
 * physical pixels per CSS pixel of its 26px. Mail apps that recolour dark mode
 * themselves (Gmail on iOS) flip CSS backgrounds but never images, so a square
 * painted in CSS behind a transparent mark turns white under a white mark; an
 * image keeps both. The mid-grey ring, 1px at 26px, keeps the black square's
 * edge on a dark card. PNG, since mail clients support it everywhere.
 */
const emailLogo = await sharp(
    Buffer.from(badgeSvg(LOGO_BLACK, LOGO_WHITE, { color: '#666666', width: BADGE_SIDE / 26 })),
)
    .resize(78, 78)
    .png({ compressionLevel: 9, palette: true, effort: 10 })
    .toBuffer();
await Promise.all([
    writeFile(resolve(publicDirectory, 'email/hushos-logo-square.png'), emailLogo),
    writeFile(resolve(emailDirectory, 'hushos-logo-square.png'), emailLogo),
]);
console.info(`hushos-logo-square.png: ${emailLogo.length} bytes (78 × 78)`);
/*
 * The bare marks the emails drew on a CSS square before. Mail already in
 * inboxes still loads them from public/email, so they stay there.
 */
for (const [name, color] of [
    ['hushos-logo', '#18191c'],
    ['hushos-logo-dark', '#eceef3'],
] as const) {
    const svg = renderToStaticMarkup(<Logo width={300} height={419} color={color} />);
    const image = await sharp(Buffer.from(svg))
        .resize(60, 84)
        .png({ compressionLevel: 9, palette: true, effort: 10 })
        .toBuffer();
    await writeFile(resolve(publicDirectory, `email/${name}.png`), image);
    console.info(`${name}.png: ${image.length} bytes (60 × 84)`);
}
/*
 * Screenshots are taken at one, one and a half and two device pixels per CSS
 * pixel (see e2e/screenshots.spec.ts) and quantised to a palette: a screenshot
 * of flat UI loses nothing that way and comes out a fraction of the size. They
 * live under src so the build hashes their names and they cache for a year.
 */
const screenshots = resolve(import.meta.dirname, '../src/screenshots');
for (const name of await readdir(screenshots)) {
    if (!name.endsWith('.png')) continue;
    const path = resolve(screenshots, name);
    const original = await readFile(path);
    const png = await sharp(original)
        .png({ compressionLevel: 9, effort: 10, palette: true, quality: 90, dither: 0.6 })
        .toBuffer();
    if (png.length < original.length) await writeFile(path, png);
    console.info(`screenshots/${name}: ${Math.min(original.length, png.length)} bytes`);
}
for (const name of await readdir(publicDirectory)) {
    if (!name.endsWith('.png')) continue;
    const path = resolve(publicDirectory, name);
    const original = await readFile(path);
    const optimized = await sharp(original).png({ compressionLevel: 9, effort: 10 }).toBuffer();
    if (optimized.length < original.length) await writeFile(path, optimized);
    console.info(`${name}: ${Math.min(original.length, optimized.length)} bytes`);
}
