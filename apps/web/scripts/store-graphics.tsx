import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fromJsx } from 'takumi-js/helpers/jsx';
import { Renderer } from 'takumi-js/node';
import { BRAND_WORDMARK_SIZE, brandWordmarkSvg, logoSvg } from '../src/lib/brand';

/*
 * The Play Store's graphics from the same mark and type as the social cards
 * (src/lib/og.server.tsx): the 1024x500 feature graphic and the 512x512 icon.
 * Play wants the graphic as a 24-bit PNG (no alpha) and the icon as a 32-bit
 * PNG, so the graphic is flattened and the icon keeps an opaque alpha channel.
 * Run: bun run store:graphics. Output: docs/release/assets/.
 */
const out = new URL('../../../docs/release/assets/', import.meta.url);
await mkdir(out, { recursive: true });

const font = await readFile(
    fileURLToPath(
        import.meta.resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'),
    ),
);
const wordmark = `data:image/svg+xml;base64,${Buffer.from(brandWordmarkSvg()).toString('base64')}`;
const wordmarkHeight = 44;
const wordmarkWidth = Math.round(
    (BRAND_WORDMARK_SIZE.width / BRAND_WORDMARK_SIZE.height) * wordmarkHeight,
);

// A white page, the colour wordmark, the home page's heading and one line under it.
const { node, css } = await fromJsx(
    <div
        style={{
            width: 1024,
            height: 500,
            padding: '56px 72px',
            backgroundColor: '#ffffff',
            color: '#17203a',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontFamily: 'Geist',
        }}
    >
        <img src={wordmark} alt="HushOS" width={wordmarkWidth} height={wordmarkHeight} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div
                style={{
                    fontSize: 76,
                    lineHeight: 1.02,
                    letterSpacing: -3,
                    fontWeight: 800,
                    whiteSpace: 'pre-line',
                }}
            >
                {'Nobody else can\nlook inside.'}
            </div>
            <div style={{ fontSize: 26, lineHeight: 1.4, color: '#5a6380' }}>
                Private storage that works like the drive you already use.
            </div>
        </div>
    </div>,
);
const renderer = new Renderer();
await renderer.registerFont({ name: 'Geist', data: font });
const feature = await renderer.render(node, { width: 1024, height: 500, format: 'png', css });

await Promise.all([
    sharp(Buffer.from(feature))
        .flatten({ background: '#ffffff' })
        .png()
        .toFile(fileURLToPath(new URL('google-feature-graphic.png', out))),
    // The app icon as the launcher shows it: the white mark on Hush blue, square; Play rounds it.
    sharp(Buffer.from(logoSvg('#ffffff', '#2c428e', 0, 0.8)), { density: 300 })
        .resize(512, 512)
        .flatten({ background: '#2c428e' })
        .ensureAlpha()
        .png()
        .toFile(fileURLToPath(new URL('google-play-icon.png', out))),
]);
console.log(`Wrote ${fileURLToPath(out)}google-feature-graphic.png and google-play-icon.png`);
