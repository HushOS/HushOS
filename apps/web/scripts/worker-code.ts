import { parseAst } from 'vite';

/*
 * Finds code in the shipped workers that would need the Content Security Policy's
 * `unsafe-eval`: a call to `eval` or `Function`, plain or through the global object, in any
 * worker script or any chunk a worker imports (docs/file-tools-design.md, "Content Security
 * Policy"). The policy would refuse such code at run time anyway; this fails the build first,
 * so a tool that depends on it never ships broken.
 *
 * Calls are found in the parsed program, not by text, so a method named `eval` or the word
 * in a string or a comment is not mistaken for one. The one known exception is the import
 * shim wasm-bindgen writes for js-sys's `Function` (`__wbg_new_no_args_*`), which OPAQUE's
 * WebAssembly imports to detect the global object and never calls.
 */

export type Finding = { file: string; what: string; excerpt: string };

const GLOBALS = new Set(['globalThis', 'self', 'window', 'global']);
const DYNAMIC = new Set(['eval', 'Function']);
const INERT_SHIM = /^__wbg_new_no_args_[0-9a-f]+$/;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/* The name a callee reaches, if it is eval or Function: `eval`, `self.eval`, `(0, eval)`. */
function dynamicCallee(callee: Node): string | null {
    if (callee.type === 'Identifier' && DYNAMIC.has(callee.name as string))
        return callee.name as string;
    if (callee.type === 'MemberExpression') {
        const object = callee.object as Node;
        const property = callee.property as Node;
        const name =
            !callee.computed && property.type === 'Identifier'
                ? (property.name as string)
                : property.type === 'Literal'
                  ? String(property.value)
                  : property.type === 'TemplateLiteral' &&
                      (property.expressions as Node[]).length === 0
                    ? (property.quasis as { value: { cooked: string } }[])[0]!.value.cooked
                    : null;
        if (
            name &&
            DYNAMIC.has(name) &&
            object.type === 'Identifier' &&
            GLOBALS.has(object.name as string)
        )
            return `${object.name as string}.${name}`;
    }
    if (callee.type === 'SequenceExpression') {
        const expressions = callee.expressions as Node[];
        return dynamicCallee(expressions[expressions.length - 1]!);
    }
    if (callee.type === 'ParenthesizedExpression') return dynamicCallee(callee.expression as Node);
    return null;
}

function propertyKey(node: Node) {
    const key = node.key as Node | undefined;
    if (!key) return null;
    if (key.type === 'Identifier') return key.name as string;
    if (key.type === 'Literal') return String(key.value);
    return null;
}

/* Dynamic code in one file, and the relative specifiers it imports. */
export function scanSource(file: string, source: string) {
    const program = parseAst(source) as unknown as Node;
    const findings: Finding[] = [];
    const imports: string[] = [];
    const visit = (node: Node, inShim: boolean) => {
        let shim = inShim;
        if (node.type === 'Property' || node.type === 'MethodDefinition') {
            const key = propertyKey(node);
            if (key && INERT_SHIM.test(key)) shim = true;
        }
        if (
            (node.type === 'ImportDeclaration' ||
                node.type === 'ExportAllDeclaration' ||
                node.type === 'ExportNamedDeclaration' ||
                node.type === 'ImportExpression') &&
            isNode(node.source)
        ) {
            const spec = node.source as Node;
            if (spec.type === 'Literal' && typeof spec.value === 'string') imports.push(spec.value);
            if (spec.type === 'TemplateLiteral' && (spec.expressions as Node[]).length === 0)
                imports.push((spec.quasis as { value: { cooked: string } }[])[0]!.value.cooked);
        }
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            const callee = node.callee as Node;
            if (callee.type === 'Identifier' && callee.name === 'importScripts')
                for (const arg of node.arguments as Node[])
                    if (arg.type === 'Literal' && typeof arg.value === 'string')
                        imports.push(arg.value);
            const name = dynamicCallee(callee);
            if (name && !shim)
                findings.push({
                    file,
                    what: `${node.type === 'NewExpression' ? 'new ' : ''}${name}(`,
                    excerpt: source.slice(Math.max(0, node.start - 40), node.end + 20),
                });
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const child of value) if (isNode(child)) visit(child, shim);
            } else if (isNode(value)) visit(value, shim);
        }
    };
    visit(program, false);
    return { findings, imports };
}

/* Worker scripts the page starts: `new Worker(new URL("/assets/x.js", ...))` in any chunk. */
export function workerUrls(source: string) {
    const urls: string[] = [];
    for (const match of source.matchAll(
        /new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]/g,
    ))
        urls.push(match[1]!);
    return urls;
}

/*
 * Every file a worker reaches, from its entries, through relative and root imports, and
 * what dynamic code each holds. `read` answers a path under the public root ("/assets/x.js")
 * or null when there is no such file.
 */
export function scanWorkers(entries: string[], read: (path: string) => string | null) {
    const seen = new Set<string>();
    const findings: Finding[] = [];
    const missing: string[] = [];
    const queue = [...entries];
    while (queue.length) {
        const path = queue.shift()!;
        if (seen.has(path)) continue;
        seen.add(path);
        const source = read(path);
        if (source === null) {
            missing.push(path);
            continue;
        }
        const scanned = scanSource(path, source);
        findings.push(...scanned.findings);
        for (const spec of scanned.imports) {
            if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
            queue.push(new URL(spec, `https://app${path}`).pathname);
        }
    }
    return { scanned: [...seen], findings, missing };
}
