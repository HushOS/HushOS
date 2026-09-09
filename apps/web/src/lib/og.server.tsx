import '@/lib/server-only';
import geistFont from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import { Renderer } from 'takumi-js/node';
import { fromJsx } from 'takumi-js/helpers/jsx';
import { prepareImages } from 'takumi-js/helpers';
import { Logo } from '@/components/logo';

const cards = {
    home: {
        title: 'A private place\nfor your work.',
        description: 'Open source. Easy to self-host.',
        label: 'HushOS',
    },
};
const rendered = new Map<keyof typeof cards, Promise<Uint8Array>>();

// Only fixed public copy. A crawler never receives private filenames, keys, or share tokens.
export async function socialImage(kind: keyof typeof cards) {
    let image = rendered.get(kind);
    if (!image) {
        const card = cards[kind];
        image = fromJsx(
            <div
                style={{
                    width: 1200,
                    height: 630,
                    padding: '58px 72px',
                    backgroundColor: '#f4f3ee',
                    color: '#1f1f1d',
                    display: 'flex',
                    flexDirection: 'column',
                    fontFamily: 'Geist',
                    justifyContent: 'space-between',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                        fontSize: 32,
                        fontWeight: 600,
                        letterSpacing: -1,
                    }}
                >
                    <Logo width={30} height={42} style={{ color: '#1f1f1d' }} />
                    hushos
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    <div
                        style={{
                            fontSize: 86,
                            lineHeight: 1.05,
                            letterSpacing: -4,
                            fontWeight: 500,
                            whiteSpace: 'pre-line',
                        }}
                    >
                        {card.title}
                    </div>
                    <div style={{ fontSize: 26, color: '#6b6a63' }}>{card.description}</div>
                </div>
                <div
                    style={{
                        borderTop: '1px solid #1f1f1d',
                        paddingTop: 20,
                        fontSize: 20,
                        color: '#6b6a63',
                    }}
                >
                    {card.label}
                </div>
            </div>,
        )
            .then(async ({ node, css }) => {
                const renderer = new Renderer();
                await renderer.registerFont({
                    name: 'Geist',
                    data: Buffer.from(geistFont.slice(geistFont.indexOf(',') + 1), 'base64'),
                });
                return renderer.render(node, {
                    width: 1200,
                    height: 630,
                    format: 'jpeg',
                    quality: 85,
                    css,
                    images: await prepareImages({ node, allowUrl: () => false }),
                });
            })
            .then((value) => new Uint8Array(value))
            .catch((error) => {
                rendered.delete(kind);
                throw error;
            });
        rendered.set(kind, image);
    }
    return new Response(new Uint8Array(await image), {
        headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
