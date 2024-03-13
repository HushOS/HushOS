import { Metadata } from 'next';

import { OtpForm } from '@/app/(marketing)/playground/otp/otp-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';

export const metadata: Metadata = {
    title: 'Otp Playground',
    keywords: ['HushOS', 'Otp Playground'],
    description: 'Just testing...',
    openGraph: {
        title: 'Otp Playground',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}${Routes.verify()}`,
        description: 'Just testing...',
        type: 'website',
    },
    twitter: {
        title: 'Otp Playground',
        description: 'Just testing...',
        card: 'summary_large_image',
    },
};

export default function OtpPlaygroundPage() {
    return (
        <div className='flex h-full items-center'>
            <Card className='mx-auto w-[32rem] max-w-lg'>
                <CardHeader>
                    <CardTitle>Otp Playground</CardTitle>
                    <CardDescription>Just testing...</CardDescription>
                </CardHeader>
                <CardContent>
                    <OtpForm />
                </CardContent>
            </Card>
        </div>
    );
}
