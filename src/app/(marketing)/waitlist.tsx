'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Terminal } from 'lucide-react';
import { ofetch } from 'ofetch';

import { trackEvent } from '@/components/analytics';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiRoutes } from '@/lib/routes';
import { WaitlistInput } from '@/schemas/waitlist';

export function Waitlist() {
    const [email, setEmail] = useState('');

    const { mutate, isPending, isSuccess } = useMutation({
        mutationKey: ['waitlist'],
        mutationFn: async () => {
            await ofetch(ApiRoutes.waitlist(), {
                method: 'POST',
                body: { email } satisfies WaitlistInput,
            });
        },
        onSuccess: () => {
            trackEvent('Joined Waitlist');
        },
    });

    if (isSuccess) {
        return (
            <div className='flex items-center gap-2 rounded-md bg-muted p-4 font-semibold'>
                Thanks for joining the waitlist! We will be in touch.
            </div>
        );
    }

    return (
        <div className='space-y-4'>
            <form
                onSubmit={e => {
                    e.preventDefault();
                    mutate();
                }}
                className='flex items-center gap-2'>
                <Input
                    name='email'
                    id='email'
                    type='email'
                    placeholder='hey@hushos.com'
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                />
                <Button disabled={isPending}>
                    {isPending ? (
                        <>
                            <Loader2 className='mr-2 size-4 animate-spin' /> Joining
                        </>
                    ) : (
                        'Join'
                    )}
                </Button>
            </form>
            <Alert variant='info'>
                <Terminal className='size-4' />
                <AlertTitle>Note</AlertTitle>
                <AlertDescription>
                    We will only use your email to notify you when we launch. We will never spam
                    you.
                </AlertDescription>
            </Alert>
        </div>
    );
}
