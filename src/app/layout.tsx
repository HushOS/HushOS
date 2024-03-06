import { ReactNode } from 'react';
import { Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';

import { Providers } from '@/components/providers';
import { clientEnvs } from '@/env/client';
import { serverEnvs } from '@/env/server';

import '@/styles/globals.css';

const inter = Inter({
    variable: '--font-sans',
    subsets: ['latin'],
});

const jb = JetBrains_Mono({
    subsets: ['latin'],
    variable: '--font-mono',
});

export const viewport: Viewport = {
    themeColor: '#4f46e5',
    initialScale: 1.0,
    maximumScale: 1.0,
    minimumScale: 1.0,
    userScalable: false,
    width: 'device-width',
};

export const metadata = {
    title: {
        default: 'HushOS',
        template: '%s',
    },
    keywords: 'HushOS',
    description: 'Your privacy operating system!',
    metadataBase: new URL(`https://${clientEnvs.NEXT_PUBLIC_DOMAIN}`),
    robots: {
        index: true,
        follow: true,
    },
    openGraph: {
        description: 'Your privacy operating system!',
        type: 'website',
        title: {
            default: 'HushOS',
            template: '%s',
        },
        images: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/icon.png`,
    },
    twitter: {
        description: 'Your privacy operating system!',
        title: {
            default: 'HushOS',
            template: '%s',
        },
        card: 'summary',
        creator: '@81NARY',
        images: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}/android-icon-192x192.png`,
    },
    icons: {
        icon: '/apple-icon.png',
        shortcut: '/favicon-96x96.png',
        apple: '/apple-icon.png',
        other: {
            rel: 'apple-touch-icon-precomposed',
            url: '/apple-touch-icon-precomposed.png',
        },
    },
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang='en' dir='ltr' suppressHydrationWarning>
            <body
                className={`${inter.variable} ${jb.variable} ${serverEnvs.NODE_ENV === 'development' ? 'debug-screens' : ''}`}>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
