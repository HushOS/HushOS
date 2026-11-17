import { parseAst } from 'vite';

/*
 * Finds code in the shipped workers that would need the Content Security Policy's
 * `unsafe-eval`, in any worker script or any chunk a worker imports
 * (docs/file-tools-design.md, "Content Security Policy"). The policy would refuse such code at
 * run time anyway; this fails the build first, so a tool that depends on it never ships broken.
 *
 * What counts, found in the parsed program rather than by text, so a method named `eval` or
 * the word in a string is not mistaken for one:
 * - `eval` or `Function`, bare or through the global object (`self.eval`, `self.self.Function`,
 *   `globalThis['Function']`), used as a value at all: called, constructed, tagged, passed
 *   (`newFunc(Function, args)`), stored (`const F = Function`) or applied (`Function.apply`).
 *   `typeof Function`, `x instanceof Function` and `Function.prototype` are allowed;
 * - the constructor of a function reached from one (`(function(){}).constructor(...)`,
 *   `Object.getPrototypeOf(async function(){}).constructor`);
 * - setTimeout or setInterval given a string;
 * - an import or importScripts whose target is not written out, which this cannot follow.
 *
 * The one known exception is the import shim wasm-bindgen writes for js-sys's `Function`
 * (`__wbg_new_no_args_*`), which OPAQUE's WebAssembly imports to detect the global object and
 * never calls.
 */

/* `code`: dynamic code. `unfollowed`: an import this cannot follow, which a reviewed list may allow when its target is scanned another way. */
export type Finding = { file: string; kind: 'code' | 'unfollowed'; what: string; excerpt: string };

const GLOBALS = new Set(['globalThis', 'self', 'window', 'global']);
const DYNAMIC = new Set(['eval', 'Function']);
const TIMERS = new Set(['setTimeout', 'setInterval']);
const FUNCTION_LIKE = new Set([
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ClassExpression',
    'FunctionDeclaration',
]);
const INERT_SHIM = /^__wbg_new_no_args_[0-9a-f]+$/;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/* The name a member expression's property spells, when it spells one. */
function memberName(member: Node) {
    const property = member.property as Node;
    if (!member.computed && property.type === 'Identifier') return property.name as string;
    if (property.type === 'Literal') return String(property.value);
    if (property.type === 'TemplateLiteral' && (property.expressions as Node[]).length === 0)
        return (property.quasis as { value: { cooked: string } }[])[0]!.value.cooked;
    return null;
}

/* `self`, `globalThis`, `self.self`, `window.globalThis`… */
function isGlobal(node: Node): boolean {
    if (node.type === 'Identifier') return GLOBALS.has(node.name as string);
    if (node.type === 'MemberExpression') {
        const name = memberName(node);
        return name !== null && GLOBALS.has(name) && isGlobal(node.object as Node);
    }
    return false;
}

/* A name the node reaches among `names`: bare, or through the global object. */
function reaches(node: Node, names: Set<string>): string | null {
    if (node.type === 'Identifier' && names.has(node.name as string)) return node.name as string;
    if (node.type === 'MemberExpression') {
        const name = memberName(node);
        if (name && names.has(name) && isGlobal(node.object as Node)) return name;
    }
    return null;
}

/* Whether an identifier in `parent` under `key` is read as a value rather than named. */
function isReference(parent: Node | null, key: string) {
    if (!parent) return true;
    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
    if (
        (parent.type === 'Property' ||
            parent.type === 'MethodDefinition' ||
            parent.type === 'PropertyDefinition') &&
        key === 'key' &&
        !parent.computed
    )
        return false;
    if (parent.type === 'Property' && parent.shorthand && key === 'value') return true;
    if (
        key === 'id' ||
        parent.type === 'LabeledStatement' ||
        parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement' ||
        parent.type.startsWith('Import') ||
        parent.type === 'ExportSpecifier'
    )
        return false;
    return true;
}

/* Uses of Function that run no code: `typeof Function`, `x instanceof Function`, `Function.prototype`. */
function isHarmless(parent: Node | null, key: string) {
    if (!parent) return false;
    if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
    if (parent.type === 'BinaryExpression' && parent.operator === 'instanceof' && key === 'right')
        return true;
    return (
        parent.type === 'MemberExpression' && key === 'object' && memberName(parent) === 'prototype'
    );
}

/* `(function(){}).constructor`, `Object.getPrototypeOf(async () => {}).constructor`. */
function isFunctionConstructor(node: Node) {
    if (node.type !== 'MemberExpression' || memberName(node) !== 'constructor') return false;
    let object = node.object as Node;
    if (
        object.type === 'CallExpression' &&
        (object.arguments as Node[]).length === 1 &&
        isNode(object.callee) &&
        object.callee.type === 'MemberExpression' &&
        memberName(object.callee) === 'getPrototypeOf'
    )
        object = (object.arguments as Node[])[0]!;
    return FUNCTION_LIKE.has(object.type);
}

function isStringy(node: Node | undefined): boolean {
    if (!node) return false;
    if (node.type === 'Literal') return typeof node.value === 'string';
    if (node.type === 'TemplateLiteral') return true;
    if (node.type === 'BinaryExpression' && node.operator === '+')
        return isStringy(node.left as Node) || isStringy(node.right as Node);
    return false;
}

function propertyKey(node: Node) {
    const key = node.key as Node | undefined;
    if (!key) return null;
    if (key.type === 'Identifier') return key.name as string;
    if (key.type === 'Literal') return String(key.value);
    return null;
}

function literal(node: Node | undefined) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && (node.expressions as Node[]).length === 0)
        return (node.quasis as { value: { cooked: string } }[])[0]!.value.cooked;
    return null;
}

/* Dynamic code in one file, and the relative specifiers it imports. */
export function scanSource(file: string, source: string) {
    const program = parseAst(source) as unknown as Node;
    const findings: Finding[] = [];
    const imports: string[] = [];
    const found = (node: Node, what: string, kind: Finding['kind'] = 'code') =>
        findings.push({
            file,
            kind,
            what,
            excerpt:
                kind === 'unfollowed'
                    ? source.slice(node.start, node.end)
                    : source.slice(Math.max(0, node.start - 40), node.end + 20),
        });
    const visit = (node: Node, parent: Node | null, key: string, inShim: boolean) => {
        let shim = inShim;
        if (node.type === 'Property' || node.type === 'MethodDefinition') {
            const name = propertyKey(node);
            if (name && INERT_SHIM.test(name)) shim = true;
        }
        if (
            node.type === 'ImportDeclaration' ||
            node.type === 'ExportAllDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ImportExpression'
        ) {
            if (isNode(node.source)) {
                const spec = literal(node.source);
                if (spec !== null) imports.push(spec);
                else found(node.source, 'import(…) of a target not written out', 'unfollowed');
            }
        }
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            const callee = node.callee as Node;
            const args = node.arguments as Node[];
            if (reaches(callee, new Set(['importScripts']))) {
                for (const arg of args) {
                    const spec = literal(arg);
                    if (spec !== null) imports.push(spec);
                    else found(arg, 'importScripts(…) of a target not written out', 'unfollowed');
                }
            }
            const timer = reaches(callee, TIMERS);
            if (timer && isStringy(args[0])) found(node, `${timer}(string)`);
        }
        if (isFunctionConstructor(node)) found(node, 'the constructor of a function');
        const name = reaches(node, DYNAMIC);
        if (
            name &&
            !shim &&
            (node.type !== 'Identifier' || isReference(parent, key)) &&
            !isHarmless(parent, key)
        )
            found(node, node.type === 'Identifier' ? name : `${name} through the global object`);
        // A member reaching eval or Function is reported once, not again for its parts.
        if (name && node.type === 'MemberExpression') return;
        for (const [childKey, value] of Object.entries(node)) {
            if (Array.isArray(value)) {
                for (const child of value) if (isNode(child)) visit(child, node, childKey, shim);
            } else if (isNode(value)) visit(value, node, childKey, shim);
        }
    };
    visit(program, null, '', false);
    return { findings, imports };
}

/* Worker scripts the page starts: `new Worker(new URL("/assets/x.js", ...))` or `new Worker("/assets/x.js")`, in any chunk. */
export function workerUrls(source: string) {
    const urls: string[] = [];
    for (const match of source.matchAll(
        /new\s+(?:Shared)?Worker\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`]+)["'`]/g,
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
