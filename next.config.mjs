import createJiti from 'jiti';

const jiti = createJiti(new URL(import.meta.url).pathname);

jiti('./src/env/server');
jiti('./src/env/client');

/** @type {import('next').NextConfig} */
const nextConfig = {
    swcMinify: true,
    reactStrictMode: true,
    images: {
        remotePatterns: [
            {
                hostname: process.env.NEXT_PUBLIC_DOMAIN ?? 'hushos.com',
            },
        ],
        formats: ['image/avif', 'image/webp'],
    },
};

export default nextConfig;
