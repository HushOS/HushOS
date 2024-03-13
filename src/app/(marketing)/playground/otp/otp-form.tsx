'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Clipboard } from 'lucide-react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { z } from '@/server/zod';

export function OtpForm() {
    const form = useForm<{ code: string }>({
        resolver: zodResolver(z.object({ code: z.string().length(8) })),
        defaultValues: {
            code: '',
        },
        criteriaMode: 'all',
    });

    const [testCode, setTestCode] = useState(42424242);
    const [copied, copyAction] = useCopyToClipboard(testCode.toString());

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(console.log)} className='space-y-4'>
                <Input
                    type='number'
                    autoComplete='off'
                    data-1p-ignore
                    value={testCode}
                    onChange={e => setTestCode(Number(e.target.value))}
                />
                <Button
                    type='button'
                    className='gap-2'
                    variant='secondary'
                    onClick={copyAction}
                    disabled={copied}>
                    {copied ? (
                        <>
                            Copied {testCode} <Check className='size-4' />
                        </>
                    ) : (
                        <>
                            Copy {testCode} <Clipboard className='size-4' />
                        </>
                    )}
                </Button>
                <FormField
                    control={form.control}
                    name='code'
                    render={({ field }) => (
                        <FormItem>
                            <div className='space-y-2 leading-none'>
                                <div className='space-y-1'>
                                    <FormLabel>Code</FormLabel>
                                    <FormDescription>Try playing around with this.</FormDescription>
                                </div>
                                <FormControl>
                                    <InputOTP
                                        data-1p-ignore
                                        maxLength={8}
                                        render={({ slots }) => (
                                            <InputOTPGroup>
                                                {slots.map((slot, index) => (
                                                    <InputOTPSlot key={index} {...slot} />
                                                ))}{' '}
                                            </InputOTPGroup>
                                        )}
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage />
                            </div>
                        </FormItem>
                    )}
                />
            </form>
        </Form>
    );
}
