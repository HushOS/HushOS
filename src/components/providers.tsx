'use client';

import { ReactNode } from 'react';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ThemeProvider } from 'next-themes';

import { ToastProvider } from '@/components/ui/toast';
import { TRPCReactProvider } from '@/trpc/react';

export function Providers({ children }: { children: ReactNode }) {
    return (
        <TRPCReactProvider>
            <ThemeProvider attribute='class'>
                <ToastProvider>{children}</ToastProvider>
                <ReactQueryDevtools />
            </ThemeProvider>
        </TRPCReactProvider>
    );
}
