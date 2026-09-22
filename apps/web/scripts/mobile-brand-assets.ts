import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { logoSvg } from '../src/lib/brand';

/*
 * The phone apps' icons and splash marks from the same mark as the web app
 * (src/lib/brand.ts), written straight into the iOS asset catalog and the
 * Android resources. Run: bun run brand:mobile. Monochrome throughout: the
 * ink mark on the sheet.
 */
const ios = new URL('../../ios/App/Assets.xcassets/', import.meta.url);
const android = new URL('../../android/app/src/main/res/', import.meta.url);
const write = (dir: URL, name: string, svg: string, side: number) =>
    sharp(Buffer.from(svg), { density: 300 })
        .resize(side, side)
        .png()
        .toFile(new URL(name, dir).pathname);
await Promise.all(
    ['AppIcon.appiconset/', 'SplashMark.imageset/'].map((name) =>
        mkdir(new URL(name, ios), { recursive: true }),
    ),
);
await Promise.all(
    ['drawable/', 'mipmap-anydpi-v26/'].map((name) =>
        mkdir(new URL(name, android), { recursive: true }),
    ),
);

await Promise.all([
    // iOS icon: monochrome, the ink mark on the sheet; iOS rounds it. Dark and tinted variants beside it.
    write(ios, 'AppIcon.appiconset/icon.png', logoSvg('#1c2848', '#fcfbf7', 0, 0.8), 1024),
    write(ios, 'AppIcon.appiconset/icon-dark.png', logoSvg('#dfe3f2', '#1c1f28', 0, 0.8), 1024),
    write(ios, 'AppIcon.appiconset/icon-tinted.png', logoSvg('#000000', '#ffffff', 0, 0.8), 1024),
    // Android adaptive icon: foreground mark inside the safe circle, colour background, monochrome mark.
    write(android, 'drawable/icon_foreground.png', logoSvg('#1c2848', undefined, 0, 0.55), 1024),
    write(android, 'drawable/icon_background.png', logoSvg('#fcfbf7', '#fcfbf7'), 1024),
    write(android, 'drawable/icon_monochrome.png', logoSvg('#ffffff', undefined, 0, 0.55), 1024),
    // Android's splash shows the icon in a 240dp circle whose safe zone is the inner two thirds.
    write(android, 'drawable/splash_mark.png', logoSvg('#1c2848', undefined, 0, 0.5), 432),
    // Launch screen: a 160-point mark, centred by the system on the desk colour.
    ...[1, 2, 3].flatMap((scale) => [
        write(
            ios,
            `SplashMark.imageset/splash-icon@${scale}x.png`,
            logoSvg('#1c2848', undefined, 0, 0.8),
            160 * scale,
        ),
        write(
            ios,
            `SplashMark.imageset/splash-icon-dark@${scale}x.png`,
            logoSvg('#dfe3f2', undefined, 0, 0.8),
            160 * scale,
        ),
    ]),
]);
console.log('wrote the iOS asset catalog images and the Android drawables');
