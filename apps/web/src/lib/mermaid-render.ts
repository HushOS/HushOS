import { PeleError, register, render } from 'pele/core';
import classDiagram from 'pele/diagrams/class';
import er from 'pele/diagrams/er';
import flowchart from 'pele/diagrams/flowchart';
import gantt from 'pele/diagrams/gantt';
import gitGraph from 'pele/diagrams/gitGraph';
import journey from 'pele/diagrams/journey';
import mindmap from 'pele/diagrams/mindmap';
import pie from 'pele/diagrams/pie';
import quadrantChart from 'pele/diagrams/quadrantChart';
import sequence from 'pele/diagrams/sequence';
import state from 'pele/diagrams/state';
import timeline from 'pele/diagrams/timeline';
import {
    DIAGRAM_EDGE_LIMIT,
    DIAGRAM_OUTPUT_LIMIT,
    DIAGRAM_SOURCE_LIMIT,
    type DiagramFailure,
    safeDiagramSvg,
} from '@/lib/mermaid-svg';

/*
 * pele (MIT, github.com/obsidianmd/pele) with a fixed set of twelve diagram types, the owner's choice
 * (docs/editing-design.md, "Diagrams"): flowchart, sequence, class, state, entity relationship,
 * Gantt, pie, user journey, Git graph, mind map, timeline and quadrant chart. About 138 KB gzipped,
 * all of it in the diagram worker (lib/mermaid.worker.ts), one file fetched with the viewers'
 * post-unlock preload: never per type, so which code a device fetched never says what kind of
 * diagram, or that there was one. Any other type is "unsupported": the code stays, with a sentence.
 * Only the worker imports this module.
 */
register(
    flowchart,
    sequence,
    classDiagram,
    state,
    er,
    gantt,
    pie,
    journey,
    gitGraph,
    mindmap,
    timeline,
    quadrantChart,
);

export type DiagramOutcome =
    | { svg: string; width: number; height: number }
    | { failure: Exclude<DiagramFailure, 'too-many'> };

/*
 * A diagram's SVG, or why there is none. No links and no images (pele leaves out every `click` and
 * image directive), bounded in source, edges and output, and refused unless the SVG passes the
 * allowlist (lib/mermaid-svg.ts). Synchronous and DOM-free: text is measured in the system's sans
 * serif, the font the image is drawn in (an image never sees the page's fonts).
 */
export function drawDiagram(source: string): DiagramOutcome {
    if (source.length > DIAGRAM_SOURCE_LIMIT) return { failure: 'too-large' };
    try {
        const drawn = render(source, {
            links: false,
            images: false,
            maxEdges: DIAGRAM_EDGE_LIMIT,
            outputLimit: DIAGRAM_OUTPUT_LIMIT,
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        });
        if (!safeDiagramSvg(drawn.svg)) return { failure: 'failed' };
        return { svg: drawn.svg, width: drawn.width, height: drawn.height };
    } catch (error) {
        if (error instanceof PeleError && error.code === 'unsupported-diagram')
            return { failure: 'unsupported' };
        if (error instanceof PeleError && error.code === 'limit') return { failure: 'too-large' };
        return { failure: 'failed' };
    }
}
