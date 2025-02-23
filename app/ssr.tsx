import { createRouter } from '@/router';
import { getRouterManifest } from '@tanstack/start/router-manifest';
import { createStartHandler, defaultStreamHandler } from '@tanstack/start/server';

export default createStartHandler({
    createRouter,
    getRouterManifest,
})(defaultStreamHandler);
