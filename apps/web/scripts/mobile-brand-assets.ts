import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { LOGO_BLACK, LOGO_WHITE, logoSvg } from '../src/lib/brand';

/*
 * The phone apps' icons and splash marks from the same mark as the web app
 * (src/lib/brand.ts), written straight into the iOS asset catalog and the
 * Android resources. Run: bun run brand:mobile. Black and white, as on the web: the white mark
 * on a black square for the icons, and the black mark alone (white in the dark) for the splash.
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
    ['drawable/', 'drawable-night/', 'mipmap-anydpi-v26/'].map((name) =>
        mkdir(new URL(name, android), { recursive: true }),
    ),
);

await Promise.all([
    // iOS icon: the white mark on black, as the web's apple-touch icon; iOS rounds it.
    write(ios, 'AppIcon.appiconset/icon.png', logoSvg('#ffffff', LOGO_BLACK, 0, 0.8), 1024),
    // Dark: the white mark on a transparent ground, so iOS's own dark backing shows
    // through; tinted takes a white mark on black and colours it itself.
    write(ios, 'AppIcon.appiconset/icon-dark.png', logoSvg(LOGO_WHITE, undefined, 0, 0.8), 1024),
    write(ios, 'AppIcon.appiconset/icon-tinted.png', logoSvg('#ffffff', '#000000', 0, 0.8), 1024),
    // The mark in the Files sign-in sheet and the Live Activity, which cannot read the app's catalog.
    write(
        ios,
        '../../FilesUI/Assets.xcassets/BrandMark.imageset/BrandMark.png',
        logoSvg('#ffffff', LOGO_BLACK, 0, 0.8),
        192,
    ),
    write(
        ios,
        '../../Widgets/Assets.xcassets/BrandMark.imageset/BrandMark.png',
        logoSvg('#ffffff', LOGO_BLACK, 0, 0.8),
        192,
    ),
    // Android adaptive icon: foreground mark inside the safe circle, black background, monochrome mark.
    write(android, 'drawable/icon_foreground.png', logoSvg('#ffffff', undefined, 0, 0.55), 1024),
    write(android, 'drawable/icon_background.png', logoSvg(LOGO_BLACK, LOGO_BLACK), 1024),
    write(android, 'drawable/icon_monochrome.png', logoSvg('#ffffff', undefined, 0, 0.55), 1024),
    // The splash on both phones is the mark alone in black (white in the dark) on the app's own ground, so it fades
    // straight into the first screen. Android shows it in a 240dp circle whose safe zone is the
    // inner two thirds; the ground colour is `splash` in res/values*/colors.xml.
    write(android, 'drawable/splash_mark.png', logoSvg(LOGO_BLACK, undefined, 0, 0.5), 432),
    write(android, 'drawable-night/splash_mark.png', logoSvg(LOGO_WHITE, undefined, 0, 0.5), 432),
    // iOS: a 160-point mark, centred by the system on the same ground (LaunchBackground, below).
    ...[1, 2, 3].flatMap((scale) => [
        write(
            ios,
            `SplashMark.imageset/splash-icon@${scale}x.png`,
            logoSvg(LOGO_BLACK, undefined, 0, 0.8),
            160 * scale,
        ),
        write(
            ios,
            `SplashMark.imageset/splash-icon-dark@${scale}x.png`,
            logoSvg(LOGO_WHITE, undefined, 0, 0.8),
            160 * scale,
        ),
    ]),
]);
// The launch screen's ground: Alpine's ground colour, light and dark (packages/tokens), written in
// the shape oxfmt keeps.
const components = (hex: string) => {
    const byte = (at: number) => `0x${hex.slice(at, at + 2).toUpperCase()}`;
    return `{ "alpha": "1.000", "blue": "${byte(5)}", "green": "${byte(3)}", "red": "${byte(1)}" }`;
};
await Bun.write(
    new URL('LaunchBackground.colorset/Contents.json', ios),
    `{
    "colors": [
        {
            "color": {
                "color-space": "srgb",
                "components": ${components('#f3f4f8')}
            },
            "idiom": "universal"
        },
        {
            "appearances": [{ "appearance": "luminosity", "value": "dark" }],
            "color": {
                "color-space": "srgb",
                "components": ${components('#0e111a')}
            },
            "idiom": "universal"
        }
    ],
    "info": { "author": "xcode", "version": 1 }
}
`,
);
console.log('wrote the iOS asset catalog images and the Android drawables');
