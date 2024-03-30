import withBundleAnalyzer from '@next/bundle-analyzer';
import createJiti from 'jiti';

const jiti = createJiti(new URL(import.meta.url).pathname);

const {
    serverEnvs: { ANALYZE, DEPLOY_TARGET },
} = jiti('./src/env/server');
const {
    clientEnvs: { NEXT_PUBLIC_DOMAIN },
} = jiti('./src/env/client');

/** @type {import('next').NextConfig} */
const nextConfig = {
    output: DEPLOY_TARGET === 'standalone' ? 'standalone' : undefined,
    swcMinify: true,
    reactStrictMode: true,
    images: {
        remotePatterns: [
            {
                hostname: NEXT_PUBLIC_DOMAIN ?? 'hushos.com',
            },
        ],
        formats: ['image/avif', 'image/webp'],
    },
};

export default withBundleAnalyzer({
    enabled: ANALYZE,
})(nextConfig);
