import '@/lib/server-only';
import geistFont from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import { Renderer } from 'takumi-js/node';
import { fromJsx } from 'takumi-js/helpers/jsx';
import { prepareImages } from 'takumi-js/helpers';
import { Logo } from '@/components/logo';
import { comparisons } from '@/lib/compare';
import { formatDate, posts } from '@/lib/content';

/*
 * The social card for each public page, drawn on the server with Takumi from
 * fixed public copy: this site's own titles and summaries, never anything a
 * person typed. A page asks for `/og/<key>.jpg`; an unknown key is a 404.
 */

type Card = { title: string; description: string; label: string };

const fixed: Record<string, Card> = {
    home: {
        title: 'Your files, private.\nWithout the homework.',
        description: 'Private storage that is simple to use. Open source. Yours to run.',
        label: 'HushOS',
    },
    about: {
        title: 'Make the private choice\nthe easy choice.',
        description: 'What HushOS is, why it exists, and what it promises.',
        label: 'HushOS · About',
    },
    security: {
        title: 'How HushOS\nprotects you.',
        description:
            'Sign-in, keys, files, sharing and reports, explained so you can check each claim against the code.',
        label: 'HushOS · Security',
    },
    pricing: {
        title: 'Start free.\nPay only for space.',
        description: 'Every plan is protected the same way. Self-hosting is free.',
        label: 'HushOS · Pricing',
    },
    blog: {
        title: 'The HushOS blog.',
        description: 'Notes on how HushOS protects your data, and what is being built next.',
        label: 'HushOS · Blog',
    },
    privacy: {
        title: 'Privacy Policy',
        description: 'Exactly what is stored, what is never stored, and how long it is kept.',
        label: 'HushOS · Legal',
    },
    terms: {
        title: 'Terms of Service',
        description: 'Written to be read in a few minutes.',
        label: 'HushOS · Legal',
    },
};

/* Cut a summary to fit, at the end of a sentence when one lands past the first third. */
function shorten(text: string, max: number) {
    if (text.length <= max) return text;
    const head = text.slice(0, max);
    const sentence = head.lastIndexOf('. ');
    if (sentence > max / 3) return head.slice(0, sentence + 1);
    return `${head.slice(0, max - 1).trimEnd()}…`;
}

export function cardFor(key: string): Card | null {
    if (fixed[key]) return fixed[key];
    if (key.startsWith('vs-')) {
        const entry = comparisons.find((item) => item.slug === key.slice(3));
        return entry
            ? {
                  title: `HushOS vs\n${entry.name}`,
                  description: shorten(entry.summary, 150),
                  label: 'HushOS · Compared',
              }
            : null;
    }
    if (key.startsWith('blog-')) {
        const post = posts.find((item) => item.slug === key.slice(5));
        return post
            ? {
                  title: post.meta.title,
                  description: shorten(post.meta.description, 150),
                  label: `HushOS · Blog · ${formatDate(post.meta.date)}`,
              }
            : null;
    }
    return null;
}

const rendered = new Map<string, Promise<Uint8Array>>();

// Only fixed public copy. A crawler never receives private filenames, keys, or share tokens.
export async function socialImage(key: string) {
    const card = cardFor(key);
    if (!card) return new Response('Not found', { status: 404 });
    let image = rendered.get(key);
    if (!image) {
        // A title the copy did not break by hand wraps by itself; long ones set smaller.
        const long = Math.max(...card.title.split('\n').map((line) => line.length)) > 22;
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
                            fontSize: long ? 64 : 86,
                            lineHeight: 1.05,
                            letterSpacing: long ? -2.5 : -4,
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
                rendered.delete(key);
                throw error;
            });
        rendered.set(key, image);
    }
    return new Response(new Uint8Array(await image), {
        headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
