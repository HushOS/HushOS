import { describe, expect, test } from 'vitest';
import { drawDiagram } from '@/lib/mermaid-render';
import {
    DIAGRAM_EDGE_LIMIT,
    DIAGRAM_SOURCE_LIMIT,
    type DiagramPalette,
    safeDiagramSvg,
    themedSvg,
} from '@/lib/mermaid-svg';

/*
 * A Mermaid fence is someone's file, drawn by pele into an image. Fails if a hostile diagram's
 * script, script URL, link or remote image reaches the SVG, if an SVG carrying any of them would
 * be shown, if a colour could break out of the style it is written into, or if a diagram past the
 * size bounds, or of a type outside the twelve, is drawn anyway.
 */

const hostile = `flowchart LR
  A["Start <script>alert(1)</script>"] --> B{Choice}
  B -->|yes| C["<img src=https://tracker.example/pixel.png onerror=alert(1)>"]
  click A "javascript:alert(1)"
  click B href "https://tracker.example/track"
  C --> D
`;

describe('a diagram from a file', () => {
    test('a hostile diagram is drawn with none of its script, links or images', () => {
        const drawn = drawDiagram(hostile);
        if ('failure' in drawn) throw new Error(`not drawn: ${drawn.failure}`);
        expect(drawn.svg.startsWith('<svg')).toBe(true);
        // Its words stay, as text.
        expect(drawn.svg).toContain('Choice');
        expect(drawn.svg).not.toMatch(/<script/i);
        expect(drawn.svg).not.toMatch(/javascript:/i);
        expect(drawn.svg).not.toMatch(/href/i);
        expect(drawn.svg).not.toMatch(/<image|<img|<foreignObject/i);
        expect(drawn.svg).not.toMatch(/onerror\s*=\s*"/i);
        expect(drawn.svg).not.toContain('tracker.example/track');
    });

    test('an SVG carrying a script, a link, an image, a handler or a remote URL is never shown', () => {
        const good =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g fill="red"><path d="M0,0L1,1"/></g></svg>';
        expect(safeDiagramSvg(good)).toBe(true);
        // pele's own forms pass: its custom properties, var() with a fallback, a fragment url.
        expect(
            safeDiagramSvg(
                '<svg xmlns="http://www.w3.org/2000/svg" style="max-width:100%;--_bg:var(--pele-bg,#fff);font:16px sans-serif"><rect fill="var(--pele-series-1,#4e79a7)" stroke="url(#grad)"/></svg>',
            ),
        ).toBe(true);
        for (const bad of [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://x.example"><path d="M0,0"/></a></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.example/p.png"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://x.example/f.svg#a)"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><path d=M0,0 /></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><!-- x --><g/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#a"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><g style="background:url(javascript:alert(1))"/></svg>',
            // Character references an SVG reader decodes: url(https://...) once read.
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="&#117;&#x72;l(https://x.example/f.svg#a)"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u&#114;l(https://x.example/f.svg#a)"/></svg>',
            // CSS escapes the style parser decodes: url(https://...) once read.
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:\\75 rl(https://x.example/f.svg#a)"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\rl(https://x.example/f.svg#a)"/></svg>',
            // A property pele never writes.
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background-image:none"/></svg>',
            // A named entity XML doesn't define.
            '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="&nbsp;red"/></svg>',
        ])
            expect(safeDiagramSvg(bad), bad).toBe(false);
    });

    test('colours that could break out of their style are left out', () => {
        const palette: DiagramPalette = {
            background: 'oklch(0.99 0 0)',
            foreground: '#111}svg{background:url(https://x.example/p)',
            muted: 'red;--x:url(https://x.example)',
            surface: '#fff',
            surfaceAlt: '#eee',
            border: '#ccc',
            accent: 'rgb(10 20 30)',
        };
        const svg = themedSvg('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>', palette);
        expect(svg).toContain('--pele-bg:oklch(0.99 0 0)');
        expect(svg).toContain('--pele-accent:rgb(10 20 30)');
        expect(svg).not.toContain('x.example');
        // The style closes once, where it was opened.
        expect(svg.match(/}/g)).toHaveLength(1);
    });

    test('past the source and edge bounds, or of another type, a diagram is not drawn', () => {
        const long = `flowchart LR\n  A["${'x'.repeat(DIAGRAM_SOURCE_LIMIT)}"] --> B\n`;
        expect(drawDiagram(long)).toEqual({ failure: 'too-large' });
        const chain = Array.from(
            { length: DIAGRAM_EDGE_LIMIT + 10 },
            (_, at) => `  n${at} --> n${at + 1}`,
        );
        expect(drawDiagram(`flowchart LR\n${chain.join('\n')}\n`)).toEqual({
            failure: 'too-large',
        });
        // Just inside the edge bound, it is drawn.
        const fewer = chain.slice(0, 20).join('\n');
        expect('svg' in drawDiagram(`flowchart LR\n${fewer}\n`)).toBe(true);
        // A type outside the twelve (pele knows it, but it isn't fetched).
        expect(drawDiagram('sankey-beta\nA,B,1\n')).toEqual({ failure: 'unsupported' });
        expect(drawDiagram('flowchart LR\n  A[unclosed\n')).toEqual({ failure: 'failed' });
    });
});
