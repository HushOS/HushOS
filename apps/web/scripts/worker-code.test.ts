import { describe, expect, test } from 'vitest';
import { scanSource, scanWorkers, workerUrls } from './worker-code';

/*
 * The build's check for dynamic code in workers. A guard that stops seeing a form of eval
 * lets a tool ship that the policy then breaks in production; one that flags strings or
 * method names fails builds for nothing. Both are held here, on minified shapes the bundler
 * really writes.
 */

const found = (source: string) => scanSource('/assets/w.js', source).findings.map((f) => f.what);

describe('dynamic code in a worker', () => {
    test('every way to reach eval or Function is found', () => {
        expect(found('eval(e)')).toEqual(['eval(']);
        expect(found('let f=new Function(`a`,`return a`)')).toEqual(['new Function(']);
        expect(found('function g(t){return Function(t)()}')).toEqual(['Function(']);
        expect(found('(0,eval)(s)')).toEqual(['eval(']);
        expect(found('self.eval(s);globalThis[`Function`](s)')).toEqual([
            'self.eval(',
            'globalThis.Function(',
        ]);
        expect(found('const g=()=>{if(x)window.Function(`return this`)()}')).toEqual([
            'window.Function(',
        ]);
    });

    test('words that only look like it are not', () => {
        expect(found('const s=`eval(x) and new Function(y)`;// eval(z)')).toEqual([]);
        expect(found('class P{eval(e){return e}}new P().eval(1);a.Function(2)')).toEqual([]);
        expect(found('function parseShadingFunction(e){}parseShadingFunction(1)')).toEqual([]);
    });

    test('wasm-bindgen’s never-called js-sys shim is the one exception, and only inside it', () => {
        const shim =
            'const imports={__wbg_new_no_args_1c7c842f08d00ebb:function(e,t){return Function(jo(e,t))}};';
        expect(found(shim)).toEqual([]);
        expect(found(shim + 'Function(`x`)')).toEqual(['Function(']);
        expect(found('const i={__wbg_other_1c7c:function(e){return Function(e)}}')).toEqual([
            'Function(',
        ]);
    });
});

describe('what a worker reaches', () => {
    test('imports are followed, so a chunk a worker loads is checked too', () => {
        const files: Record<string, string> = {
            '/assets/tool.worker-a.js': 'import{x}from"./shared-b.js";import(`./lazy-c.js`);',
            '/assets/shared-b.js': 'export const x=1;',
            '/assets/lazy-c.js': 'export * from "/assets/deep-d.js"',
            '/assets/deep-d.js': 'export const y=eval(`1`)',
        };
        const result = scanWorkers(['/assets/tool.worker-a.js'], (path) => files[path] ?? null);
        expect(result.scanned.sort()).toEqual(Object.keys(files).sort());
        expect(result.findings.map((f) => [f.file, f.what])).toEqual([
            ['/assets/deep-d.js', 'eval('],
        ]);
    });

    test('a worker importing a file that is not there is reported, not skipped', () => {
        const result = scanWorkers(['/assets/w.js'], (path) =>
            path === '/assets/w.js' ? 'import "./gone.js"' : null,
        );
        expect(result.missing).toEqual(['/assets/gone.js']);
    });

    test('workers started from a chunk are found by the URL Vite writes', () => {
        expect(
            workerUrls(
                'U=new Worker(new URL(`/assets/json.worker-DSHp7M8s.js`,``+import.meta.url),{type:`module`})',
            ),
        ).toEqual(['/assets/json.worker-DSHp7M8s.js']);
    });
});
