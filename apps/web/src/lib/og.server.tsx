import '@/lib/server-only';
import sansFont from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import { Renderer } from 'takumi-js/node';
import { fromJsx } from 'takumi-js/helpers/jsx';
import { prepareImages } from 'takumi-js/helpers';
import { CoverArt } from '@/components/cover';
import { Logo } from '@/components/logo';
import { getAffiliateOffer } from '@hushos/billing/growth';
import { comparisons } from '@/lib/compare';
import { formatDate, posts, type CoverTone } from '@/lib/content';
import { describeDiscount, discountAmount, ticketWord } from '@/lib/growth';

/*
 * The social card for each public page, drawn on the server with Takumi from
 * fixed public copy: this site's own titles and summaries, never anything a
 * visitor typed. The one exception is a creator's offer card, which carries the
 * name the operator gave the creator, as its page does. A page asks for
 * `/og/<key>.jpg`; an unknown key is a 404.
 */

/*
 * A card is the page's words on its identity's ground, beside a panel of the
 * blog-cover art: a word in dots over an ordered-dither wash (DESIGN.md → Dither).
 */
type Art = { word: string; tone: CoverTone };
type Card = { title: string; description: string; label: string; ground: string; art: Art };

const fixed: Record<string, Card> = {
    home: {
        title: 'Nobody else can\nlook inside.',
        description: 'Private storage that works like the drive you already use. Open source.',
        label: 'HushOS Drive',
        ground: '#ffffff',
        art: { word: 'HUSH', tone: 'blue' },
    },
    about: {
        title: 'Make the private choice\nthe easy choice.',
        description: 'What HushOS is, why it exists, and what it promises.',
        label: 'HushOS · About',
        ground: '#f6f1e8',
        art: { word: 'HELLO', tone: 'sun' },
    },
    security: {
        title: 'How HushOS\nprotects you.',
        description:
            'Sign-in, keys, files, sharing and reports, explained so you can check each claim against the code.',
        label: 'HushOS · Security',
        ground: '#eaeef8',
        art: { word: 'KEYS', tone: 'graphite' },
    },
    pricing: {
        title: 'Start free.\nPay only for space.',
        description: 'Every plan is protected the same way. Self-hosting is free.',
        label: 'HushOS · Pricing',
        ground: '#f1efff',
        art: { word: 'FREE', tone: 'lime' },
    },
    teams: {
        title: 'Private files\nfor small teams.',
        description:
            'Share folders with the people you work with. Locked on your devices first, so nobody outside the team can open it.',
        label: 'HushOS · For teams',
        ground: '#eef3f0',
        art: { word: 'TEAMS', tone: 'sage' },
    },
    blog: {
        title: 'The HushOS blog.',
        description: 'Notes on how HushOS protects your data, and what is being built next.',
        label: 'HushOS · Blog',
        ground: '#e8e9ed',
        art: { word: 'NOTES', tone: 'orange' },
    },
    register: {
        title: 'Your private drive\nstarts here.',
        description: 'Everything is locked on your device first. We can’t open it.',
        label: 'HushOS · Create an account',
        ground: '#ffffff',
        art: { word: 'START', tone: 'lime' },
    },
    login: {
        title: 'Sign in to\nHushOS.',
        description: 'Your drive, unlocked on your own device.',
        label: 'HushOS · Sign in',
        ground: '#ffffff',
        art: { word: 'DRIVE', tone: 'blue' },
    },
    // Every invite gets this one card: it names nobody, the inviter included.
    invite: {
        title: 'You’re invited\nto HushOS.',
        // Neutral: the card cannot know whether this server gives a bonus.
        description: 'Join HushOS through the link. Private storage, simple to use.',
        label: 'HushOS · An invitation',
        ground: '#fbf0ea',
        art: { word: 'INVITE', tone: 'orange' },
    },
    // A discount code made at Polar: one card for all, since only Polar knows its terms.
    offer: {
        title: 'An offer on\nHushOS.',
        description: 'A discount on private storage that is simple to use.',
        label: 'HushOS · Offer',
        ground: '#f4f7e4',
        art: { word: 'OFFER', tone: 'lime' },
    },
    // Every shared link gets this one card: nothing about what is behind it.
    shared: {
        title: 'Someone shared\nsomething with you.',
        description: 'Open it in your browser. It was locked on their device before it was sent.',
        label: 'HushOS · Shared with a link',
        ground: '#ffffff',
        art: { word: 'OPEN', tone: 'mint' },
    },
    privacy: {
        title: 'Privacy Policy',
        description: 'Exactly what is stored, what is never stored, and how long it is kept.',
        label: 'HushOS · Legal',
        ground: '#ffffff',
        art: { word: 'PRIVACY', tone: 'graphite' },
    },
    terms: {
        title: 'Terms of Service',
        description: 'Written to be read in a few minutes.',
        label: 'HushOS · Legal',
        ground: '#ffffff',
        art: { word: 'TERMS', tone: 'graphite' },
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
    if (Object.hasOwn(fixed, key)) return fixed[key]!;
    if (key.startsWith('vs-')) {
        const entry = comparisons.find((item) => item.slug === key.slice(3));
        return entry
            ? {
                  title: `HushOS vs\n${entry.name}`,
                  description: shorten(entry.summary, 150),
                  label: 'HushOS · Compared',
                  ground: '#e9f5f7',
                  art: { word: 'VS', tone: 'mint' },
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
                  ground: '#e8e9ed',
                  // `quiet` reads the page's variables, which a card does not have.
                  art: {
                      word: post.meta.cover ?? 'HUSH',
                      tone: post.meta.tone && post.meta.tone !== 'quiet' ? post.meta.tone : 'blue',
                  },
              }
            : null;
    }
    return null;
}

/*
 * A creator's offer card, from the database only (a Polar code has the fixed
 * `offer` card): a live creator, so a paused one has no card. Returns the card
 * and a cache key that changes with the terms and the name, so an edited offer
 * draws afresh.
 */
async function offerCard(key: string): Promise<{ card: Card; cacheKey: string } | null> {
    if (!key.startsWith('go-')) return null;
    const landing = await getAffiliateOffer(key.slice(3));
    if (!landing) return null;
    const amount = discountAmount(landing.terms);
    return {
        cacheKey: `go:${landing.code}:${amount}:${describeDiscount(landing.terms)}:${landing.name}`,
        card: {
            title: `${amount} off\nHushOS.`,
            description: `${describeDiscount(landing.terms)}. Private storage, simple to use.`,
            label: shorten(`HushOS · Offer · ${landing.name}`, 60),
            ground: '#f4f7e4',
            art: { word: ticketWord(landing.terms), tone: 'lime' },
        },
    };
}

const rendered = new Map<string, Promise<Uint8Array>>();
// Offers come and go and change their terms; their drawings are capped, oldest out first.
const OFFER_CARDS = 64;

// Only fixed public copy and an offer's own terms. A crawler never receives private filenames, keys, or share tokens.
export async function socialImage(key: string) {
    const fixedCard = cardFor(key);
    const offer = fixedCard ? null : await offerCard(key);
    const card = fixedCard ?? offer?.card;
    if (!card) return new Response('Not found', { status: 404 });
    const cacheKey = offer?.cacheKey ?? key;
    let image = rendered.get(cacheKey);
    if (!image) {
        if (offer) {
            const offers = [...rendered.keys()].filter((entry) => entry.startsWith('go:'));
            if (offers.length >= OFFER_CARDS) rendered.delete(offers[0]!);
        }
        // A title the copy did not break by hand wraps by itself; long ones set smaller.
        const long = Math.max(...card.title.split('\n').map((line) => line.length)) > 16;
        image = fromJsx(
            // The page's own ground and words on the left, its dithered panel on the right.
            <div
                style={{
                    width: 1200,
                    height: 630,
                    backgroundColor: card.ground,
                    color: '#17203a',
                    display: 'flex',
                    fontFamily: 'Geist',
                }}
            >
                <div
                    style={{
                        width: 740,
                        height: 630,
                        padding: '60px 56px 52px 72px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                        <div
                            style={{
                                width: 56,
                                height: 56,
                                borderRadius: 17,
                                backgroundColor: '#000000',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Logo width={23} height={32} style={{ color: '#ffffff' }} />
                        </div>
                        <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: -0.5 }}>
                            HushOS
                        </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                        <div
                            style={{
                                fontSize: long ? 54 : 74,
                                lineHeight: 1.03,
                                letterSpacing: long ? -1.8 : -3,
                                fontWeight: 800,
                                whiteSpace: 'pre-line',
                            }}
                        >
                            {card.title}
                        </div>
                        <div style={{ fontSize: 26, lineHeight: 1.4, color: '#5a6380' }}>
                            {card.description}
                        </div>
                    </div>
                    <div
                        style={{
                            borderTop: '1px solid rgba(23, 32, 58, 0.14)',
                            paddingTop: 20,
                            fontSize: 20,
                            color: '#5a6380',
                        }}
                    >
                        {card.label}
                    </div>
                </div>
                <CoverArt
                    word={card.art.word}
                    tone={card.art.tone}
                    seed={key}
                    cols={46}
                    rows={63}
                    dither
                    pattern={`og-${key}`}
                    width={460}
                    height={630}
                />
            </div>,
        )
            .then(async ({ node, css }) => {
                const renderer = new Renderer();
                await renderer.registerFont({
                    name: 'Geist',
                    data: Buffer.from(sansFont.slice(sansFont.indexOf(',') + 1), 'base64'),
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
                rendered.delete(cacheKey);
                throw error;
            });
        rendered.set(cacheKey, image);
    }
    return new Response(new Uint8Array(await image), {
        headers: {
            'Content-Type': 'image/jpeg',
            // An offer can end or change, so its card is kept an hour rather than a day.
            'Cache-Control': offer
                ? 'public, max-age=3600'
                : 'public, max-age=86400, stale-while-revalidate=604800',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
