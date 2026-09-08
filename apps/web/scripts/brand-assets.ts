import { mkdir, writeFile } from 'node:fs/promises';
import { $ } from 'bun';
import { logoSvg, wordmarkSvg } from '../src/lib/brand';

/* Writes public/brand from the mark in src/lib/brand.ts. Run: bun run brand:assets */
const dir = new URL('../public/brand/', import.meta.url);
await mkdir(dir, { recursive: true });
const files = {
    'hushos-logo.svg': logoSvg('#1f1f1d'),
    'hushos-logo-blue.svg': logoSvg('#3b6acc'),
    'hushos-logo-on-dark.svg': logoSvg('#e6e8ee', '#000000'),
    'hushos-logo-on-blue.svg': logoSvg('#ffffff', '#3b6acc'),
    'hushos-wordmark.svg': wordmarkSvg('#1f1f1d'),
    'hushos-wordmark-on-dark.svg': wordmarkSvg('#e6e8ee', '#000000'),
    'hushos-wordmark-on-blue.svg': wordmarkSvg('#ffffff', '#3b6acc'),
    'README.txt': [
        'HushOS brand assets',
        '',
        'hushos-logo.svg            ink mark, transparent background',
        'hushos-logo-blue.svg       blue mark, transparent background',
        'hushos-logo-on-dark.svg    light mark on a black field',
        'hushos-logo-on-blue.svg    white mark on the brand blue field',
        'hushos-wordmark*.svg       mark + HUSHOS in Geist Mono, same variants',
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
const cwd = new URL('../public/', import.meta.url).pathname;
const names = Object.keys(files).map((name) => `brand/${name}`);
await $`rm -f brand/hushos-brand-assets.zip`.cwd(cwd);
await $`zip -q brand/hushos-brand-assets.zip ${names} android-chrome-512x512.png apple-touch-icon.png`.cwd(
    cwd,
);
console.log(`wrote ${names.length} SVGs and hushos-brand-assets.zip to public/brand`);
