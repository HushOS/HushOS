/*
 * Adds `export const headings` to every compiled MDX document: the id and text
 * of each `##` heading, in order, after rehype-slug has given them ids. The
 * page draws its contents list from it, so the list is in the server render
 * rather than collected from the page after it loads.
 */

type Node = {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: Node[];
    data?: Record<string, unknown>;
};

function textOf(node: Node): string {
    if (node.type === 'text') return node.value ?? '';
    return (node.children ?? []).map(textOf).join('');
}

function collect(node: Node, found: { id: string; title: string }[]) {
    if (node.type === 'element' && node.tagName === 'h2') {
        const id = node.properties?.id;
        if (typeof id === 'string') found.push({ id, title: textOf(node).trim() });
        return;
    }
    for (const child of node.children ?? []) collect(child, found);
}

const literal = (value: string) => ({ type: 'Literal', value });

export function rehypeHeadings() {
    return (tree: Node) => {
        const found: { id: string; title: string }[] = [];
        collect(tree, found);
        const declaration = {
            type: 'ExportNamedDeclaration',
            specifiers: [],
            source: null,
            declaration: {
                type: 'VariableDeclaration',
                kind: 'const',
                declarations: [
                    {
                        type: 'VariableDeclarator',
                        id: { type: 'Identifier', name: 'headings' },
                        init: {
                            type: 'ArrayExpression',
                            elements: found.map((heading) => ({
                                type: 'ObjectExpression',
                                properties: (['id', 'title'] as const).map((key) => ({
                                    type: 'Property',
                                    kind: 'init',
                                    method: false,
                                    shorthand: false,
                                    computed: false,
                                    key: { type: 'Identifier', name: key },
                                    value: literal(heading[key]),
                                })),
                            })),
                        },
                    },
                ],
            },
        };
        tree.children = [
            ...(tree.children ?? []),
            {
                type: 'mdxjsEsm',
                value: '',
                data: {
                    estree: { type: 'Program', sourceType: 'module', body: [declaration] },
                },
            },
        ];
    };
}
