import { describe, expect, test } from 'vitest';
import { scanSource, scanWorkers, toolWorkerImports, workerUrls } from './worker-code';

/*
 * The build's check for dynamic code in workers. A guard that stops seeing a form of eval
 * lets a tool ship that the policy then breaks in production; one that flags strings or
 * method names fails builds for nothing. Both are held here, on minified shapes bundlers and
 * Emscripten really write.
 */

const found = (source: string) =>
    scanSource('/assets/w.js', source)
        .findings.filter((f) => f.kind === 'code')
        .map((f) => f.what);

describe('dynamic code in a worker', () => {
    test('calls and constructions of eval and Function, bare or through the global object', () => {
        expect(found('eval(e)')).toEqual(['eval']);
        expect(found('let f=new Function(`a`,`return a`)')).toEqual(['Function']);
        expect(found('function g(t){return Function(t)()}')).toEqual(['Function']);
        expect(found('(0,eval)(s)')).toEqual(['eval']);
        expect(found('self.eval(s);globalThis[`Function`](s)')).toEqual([
            'eval through the global object',
            'Function through the global object',
        ]);
        expect(found('self.self.eval(s);window.globalThis.Function(s)')).toEqual([
            'eval through the global object',
            'Function through the global object',
        ]);
    });

    test('Function or eval handed on as a value', () => {
        // Embind's newFunc, an alias, apply, Reflect and a tagged template.
        expect(found('function newFunc(c,a){return new c(...a)}newFunc(Function,["x"])')).toEqual([
            'Function',
        ]);
        expect(found('const F=Function;new F(`x`)')).toEqual(['Function']);
        expect(found('Function.apply(null,[`x`])')).toEqual(['Function']);
        expect(found('Reflect.construct(Function,[`x`])')).toEqual(['Function']);
        expect(found('Function`return 1`')).toEqual(['Function']);
        expect(found('const e=self.eval;e(`1`)')).toEqual(['eval through the global object']);
    });

    test('the constructor of a function, and timers given a string', () => {
        expect(found('(function(){}).constructor(`x`)()')).toEqual([
            'the constructor of a function',
        ]);
        expect(found('Object.getPrototypeOf(async function(){}).constructor(`x`)')).toEqual([
            'the constructor of a function',
        ]);
        expect(found('(()=>{}).constructor')).toEqual(['the constructor of a function']);
        expect(found('setTimeout(`tick()`,10);self.setInterval("a"+b,5)')).toEqual([
            'setTimeout(string)',
            'setInterval(string)',
        ]);
        expect(found('setTimeout(()=>tick(),10);setInterval(f,5)')).toEqual([]);
    });

    test('uses that run no code, and words that only look like it', () => {
        expect(
            found('typeof Function;x instanceof Function;Function.prototype.toString.call(f)'),
        ).toEqual([]);
        expect(found('const s=`eval(x) and new Function(y)`;// eval(z)')).toEqual([]);
        expect(
            found('class P{eval(e){return e}}new P().eval(1);a.Function(2);a.constructor(3)'),
        ).toEqual([]);
        expect(found('function parseShadingFunction(e){}parseShadingFunction(1)')).toEqual([]);
        expect(found('const o={eval:1,Function:2};o.eval')).toEqual([]);
    });

    test('wasm-bindgen’s never-called js-sys shim is the one exception, and only inside it', () => {
        const shim =
            'const imports={__wbg_new_no_args_1c7c842f08d00ebb:function(e,t){return Function(jo(e,t))}};';
        expect(found(shim)).toEqual([]);
        expect(found(shim + 'Function(`x`)')).toEqual(['Function']);
        expect(found('const i={__wbg_other_1c7c:function(e){return Function(e)}}')).toEqual([
            'Function',
        ]);
    });
});

describe('what a worker reaches', () => {
    test('imports are followed, so a chunk a worker loads is checked too', () => {
        const files: Record<string, string> = {
            '/assets/tool.worker-a.js':
                'import{x}from"./shared-b.js";import(`./lazy-c.js`);importScripts("/assets/old-e.js")',
            '/assets/shared-b.js': 'export const x=1;',
            '/assets/lazy-c.js': 'export * from "/assets/deep-d.js"',
            '/assets/deep-d.js': 'export const y=eval(`1`)',
            '/assets/old-e.js': 'new Function(`x`)',
        };
        const result = scanWorkers(['/assets/tool.worker-a.js'], (path) => files[path] ?? null);
        expect(result.scanned.sort()).toEqual(Object.keys(files).sort());
        expect(
            result.findings.map((f) => `${f.file} ${f.what}`).sort((a, b) => a.localeCompare(b)),
        ).toEqual(['/assets/deep-d.js eval', '/assets/old-e.js Function']);
    });

    test('an import of a computed target is reported, since it cannot be followed', () => {
        const { findings } = scanSource('/assets/w.js', 'await import(base+name);importScripts(u)');
        expect(findings.map((f) => [f.kind, f.excerpt])).toEqual([
            ['unfollowed', 'base+name'],
            ['unfollowed', 'u'],
        ]);
    });

    test('a worker importing a file that is not there is reported, not skipped', () => {
        const result = scanWorkers(['/assets/w.js'], (path) =>
            path === '/assets/w.js' ? 'import "./gone.js"' : null,
        );
        expect(result.missing).toEqual(['/assets/gone.js']);
    });

    test('workers started from a chunk are found by the URL, with or without new URL', () => {
        expect(
            workerUrls(
                'U=new Worker(new URL(`/assets/json.worker-DSHp7M8s.js`,``+import.meta.url),{type:`module`});V=new Worker("/assets/x-1.js")',
            ),
        ).toEqual(['/assets/json.worker-DSHp7M8s.js', '/assets/x-1.js']);
    });
});

describe('a tools worker', () => {
    test('must load nothing at run time: every kind of import is listed', () => {
        const file = '/assets/archive.tool-worker-a1.js';
        expect(toolWorkerImports(file, 'const x=1;self.onmessage=()=>{}')).toEqual([]);
        expect(
            toolWorkerImports(
                file,
                'import{a}from"./chunk-b.js";export*from"/assets/c.js";await import(`./d.js`);await import(u);importScripts("/assets/e.js")',
            ),
        ).toEqual(['./chunk-b.js', '/assets/c.js', './d.js', '/assets/e.js', 'u']);
    });
});
