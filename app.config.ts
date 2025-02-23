import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from '@tanstack/start/config';
import { cloudflare } from 'unenv';
import tsConfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    vite: {
        plugins: [
            tsConfigPaths({
                projects: ['./tsconfig.json'],
            }),
            tailwindcss(),
        ],
    },
    server: {
        preset: 'cloudflare-pages',
        unenv: cloudflare,
    },
});
