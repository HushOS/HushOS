'use client';

import { useState } from 'react';
import { Loader2, Terminal } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/trpc/react';

export function Waitlist() {
    const { mutate, isPending, isSuccess } = api.waitlist.join.useMutation();
    const [email, setEmail] = useState('');

    if (isSuccess) {
        return (
            <div className='flex max-w-prose items-center gap-2 rounded-md bg-muted p-4 font-semibold'>
                Thanks for joining the waitlist! We will be in touch.
            </div>
        );
    }

    return (
        <div className='max-w-prose space-y-4'>
            <form
                onSubmit={e => {
                    e.preventDefault();
                    mutate({
                        email,
                    });
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
                    We only use your email to notify you when we launch. We will not spam you.
                </AlertDescription>
            </Alert>
        </div>
    );
}
