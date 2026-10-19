import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fromJsx } from 'takumi-js/helpers/jsx';
import { Renderer } from 'takumi-js/node';
import { CoverArt } from '../src/components/cover';
import { Logo } from '../src/components/logo';
import { LOGO_BLACK, LOGO_WHITE, logoSvg } from '../src/lib/brand';

/*
 * The Play Store's graphics, drawn like the social cards (src/lib/og.server.tsx): the
 * 1024x500 feature graphic (the home card's words beside its dithered panel), the 512x512
 * icon, and the captioned phone screenshots. Play wants the graphic and the screenshots
 * without alpha (24-bit PNG) and the icon as a 32-bit PNG, so those are flattened and the
 * icon keeps an opaque alpha channel.
 * Run: bun run store:graphics. Output: docs/release/assets/ and
 * docs/release/screenshots/android/play/ (from the raw captures beside it, made by
 * scripts/store-screenshots.sh; the captions are in docs/release/store-listing.md).
 */
const assets = new URL('../../../docs/release/assets/', import.meta.url);
const screens = new URL('../../../docs/release/screenshots/android/', import.meta.url);
const captioned = new URL('play/', screens);
await mkdir(assets, { recursive: true });
await mkdir(captioned, { recursive: true });

const font = await readFile(
    fileURLToPath(
        import.meta.resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'),
    ),
);
const renderer = new Renderer();
await renderer.registerFont({ name: 'Geist', data: font });

const INK = '#17203a';
const MUTED = '#5a6380';
const RULE = '#e2e5ee';

async function render(element: Parameters<typeof fromJsx>[0], width: number, height: number) {
    const { node, css } = await fromJsx(element);
    return Buffer.from(await renderer.render(node, { width, height, format: 'png', css }));
}

function Mark({ size }: { size: number }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.32 }}>
            <div
                style={{
                    width: size,
                    height: size,
                    borderRadius: size * 0.3,
                    backgroundColor: '#000000',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Logo
                    width={Math.round(size * 0.41)}
                    height={Math.round(size * 0.57)}
                    style={{ color: '#ffffff' }}
                />
            </div>
            <div style={{ fontSize: size * 0.64, fontWeight: 700, letterSpacing: -0.5 }}>
                HushOS
            </div>
        </div>
    );
}

// The feature graphic: the home card's mark, heading and line, beside its dithered panel.
const feature = await render(
    <div
        style={{
            width: 1024,
            height: 500,
            backgroundColor: '#ffffff',
            color: INK,
            display: 'flex',
            fontFamily: 'Geist',
        }}
    >
        <div
            style={{
                width: 664,
                height: 500,
                padding: '52px 40px 52px 64px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
            }}
        >
            <Mark size={48} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div
                    style={{
                        fontSize: 64,
                        lineHeight: 1.03,
                        letterSpacing: -2.6,
                        fontWeight: 800,
                        whiteSpace: 'pre-line',
                    }}
                >
                    {'Nobody else can\nlook inside.'}
                </div>
                <div style={{ fontSize: 24, lineHeight: 1.4, color: MUTED }}>
                    End-to-end encrypted cloud storage. Open source.
                </div>
            </div>
        </div>
        <CoverArt
            word="HUSH"
            tone="blue"
            seed="play-feature"
            cols={36}
            rows={50}
            dither
            pattern="play-feature"
            width={360}
            height={500}
        />
    </div>,
    1024,
    500,
);

/*
 * The phone screenshots in Play's order, each under one short line. The first two carry
 * the message; every caption is something the Android app does today.
 */
const shots: [file: string, caption: string][] = [
    ['01-home', 'End-to-end encrypted\ncloud storage'],
    ['02-folder', 'We store your files.\nWe can’t open them.'],
    ['03-share', 'Share with the people\nyou choose'],
    ['07-words', 'Check it’s really them,\nwith twelve words'],
    ['04-shared', 'See everything\nyou share'],
    ['05-phone', 'Keep folders on your\nphone for offline'],
    ['08-files', 'Open and save\nfrom any app'],
    ['06-devices', 'See every device\nthat’s signed in'],
];
// The capture sits below the line at this width, rounded and ruled, cut off at the foot.
const SHOT_WIDTH = 880;
const SHOT_HEIGHT = Math.round((SHOT_WIDTH * 1920) / 1080);
const written: string[] = [];
for (const [index, [file, caption]] of shots.entries()) {
    const source = fileURLToPath(new URL(`${file}.png`, screens));
    if (!existsSync(source)) {
        console.warn(`No ${file}.png in docs/release/screenshots/android; skipped.`);
        continue;
    }
    const capture = `data:image/png;base64,${(await readFile(source)).toString('base64')}`;
    const image = await render(
        <div
            style={{
                width: 1080,
                height: 1920,
                backgroundColor: '#ffffff',
                color: INK,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                fontFamily: 'Geist',
            }}
        >
            <div
                style={{
                    width: SHOT_WIDTH,
                    height: 400,
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 76,
                    lineHeight: 1.06,
                    letterSpacing: -2.4,
                    fontWeight: 800,
                    whiteSpace: 'pre-line',
                }}
            >
                {caption}
            </div>
            <div
                style={{
                    width: SHOT_WIDTH + 4,
                    height: SHOT_HEIGHT + 4,
                    border: `2px solid ${RULE}`,
                    borderRadius: 44,
                    overflow: 'hidden',
                    display: 'flex',
                }}
            >
                <img src={capture} alt="" width={SHOT_WIDTH} height={SHOT_HEIGHT} />
            </div>
        </div>,
        1080,
        1920,
    );
    const name = `${String(index + 1).padStart(2, '0')}-${file.slice(3)}.png`;
    await sharp(image)
        .flatten({ background: '#ffffff' })
        .png()
        .toFile(fileURLToPath(new URL(name, captioned)));
    written.push(name);
}

await Promise.all([
    sharp(feature)
        .flatten({ background: '#ffffff' })
        .png()
        .toFile(fileURLToPath(new URL('google-feature-graphic.png', assets))),
    // The app icon as the launcher shows it: the white mark on black, square; Play rounds it.
    sharp(Buffer.from(logoSvg(LOGO_WHITE, LOGO_BLACK, 0, 0.8)), { density: 300 })
        .resize(512, 512)
        .flatten({ background: LOGO_BLACK })
        .ensureAlpha()
        .png()
        .toFile(fileURLToPath(new URL('google-play-icon.png', assets))),
]);
console.log(
    `Wrote ${fileURLToPath(assets)}google-feature-graphic.png, google-play-icon.png and ${written.length} screenshots in ${fileURLToPath(captioned)}`,
);
