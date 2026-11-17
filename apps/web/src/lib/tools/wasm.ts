/*
 * WebAssembly for a tools worker, compiled on the page: the worker's policy lets it fetch
 * nothing, so the page fetches the module from this origin, compiles it, and hands the
 * Module over in the run's start message (`modules`). A Module is shared with the worker,
 * not copied byte for byte, and the page may keep it for the next run.
 */
export async function compileWasm(url: string | URL) {
    if (typeof WebAssembly.compileStreaming === 'function') {
        try {
            return await WebAssembly.compileStreaming(fetch(url));
        } catch {
            // A server that labels it something other than application/wasm: compiled from bytes.
        }
    }
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
}
