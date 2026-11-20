import { z } from 'zod';

/*
 * Zod decides whether it may JIT-compile object schemas by probing `new Function`
 * the first time an object schema is built, which happens at module scope in
 * route files. Under this site's Content Security Policy the probe throws, Zod
 * catches it, and the browser still reports the attempt as a violation.
 * `jitless` skips the probe; the interpreted path is what runs either way.
 * Imported first by the router, so it runs before any route module is evaluated.
 */
z.config({ jitless: true });
