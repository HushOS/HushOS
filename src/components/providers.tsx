'use client';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ThemeProvider } from 'next-themes';

import { ToastProvider } from '@/components/ui/toast';

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider attribute='class'>
                <ToastProvider>{children}</ToastProvider>
                <ReactQueryDevtools />
            </ThemeProvider>
        </QueryClientProvider>
    );
}
