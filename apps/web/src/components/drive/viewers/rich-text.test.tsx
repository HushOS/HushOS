import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MarkdownView } from '@/components/drive/viewers/rich-text';
import { DIAGRAMS_PER_DOCUMENT, diagramWords } from '@/lib/viewers/markdown/mermaid-svg';

/*
 * A file with more Mermaid fences than the renderer draws. Fails if the diagrams past the bound are
 * drawn (or start drawing) anyway, or if the ones within it are told they won't be.
 */
describe('diagrams per file', () => {
    test(`past the first ${DIAGRAMS_PER_DOCUMENT} diagrams, a fence stays code and says why`, () => {
        const fence = (at: number) => `\`\`\`mermaid\nflowchart LR\n  A${at} --> B${at}\n\`\`\`\n`;
        const text = Array.from({ length: DIAGRAMS_PER_DOCUMENT + 2 }, (_, at) => fence(at)).join(
            '\n',
        );
        render(<MarkdownView text={text} />);
        expect(screen.getAllByText(diagramWords['too-many'])).toHaveLength(2);
        // The last two fences are the ones told; the first stays code, untold, until it is drawn.
        const notes = screen.getAllByText(diagramWords['too-many']);
        expect(notes[0]!.previousElementSibling?.textContent).toContain(
            `A${DIAGRAMS_PER_DOCUMENT}`,
        );
        expect(screen.getByText(/A0 --> B0/)).toBeInTheDocument();
        expect(screen.queryAllByRole('img')).toHaveLength(0);
    });
});
