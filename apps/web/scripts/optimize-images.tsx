import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { Logo } from '../src/components/logo';

const publicDirectory = resolve(import.meta.dirname, '../public');
const emailDirectory = resolve(
    import.meta.dirname,
    '../../../packages/emails/src/templates/static',
);
await mkdir(emailDirectory, { recursive: true });
await mkdir(resolve(publicDirectory, 'email'), { recursive: true });
for (const [name, color] of [
    ['hushos-logo', '#18191c'],
    ['hushos-logo-dark', '#eceef3'],
] as const) {
    const svg = renderToStaticMarkup(<Logo width={300} height={419} color={color} />);
    // Three physical pixels per CSS pixel; email clients consistently support PNG.
    const image = await sharp(Buffer.from(svg))
        .resize(60, 84)
        .png({ compressionLevel: 9, palette: true, effort: 10 })
        .toBuffer();
    await Promise.all([
        writeFile(resolve(publicDirectory, `email/${name}.png`), image),
        writeFile(resolve(emailDirectory, `${name}.png`), image),
    ]);
    console.info(`${name}.png: ${image.length} bytes (60 × 84)`);
}
for (const name of await readdir(publicDirectory)) {
    if (!name.endsWith('.png')) continue;
    const path = resolve(publicDirectory, name);
    const original = await readFile(path);
    const optimized = await sharp(original).png({ compressionLevel: 9, effort: 10 }).toBuffer();
    if (optimized.length < original.length) await writeFile(path, optimized);
    console.info(`${name}: ${Math.min(original.length, optimized.length)} bytes`);
}
