'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Routes } from '@/lib/routes';
import { sendRegistrationCodeInput } from '@/server/api/schemas/auth';
import { api } from '@/trpc/react';
import { RouterInputs } from '@/trpc/shared';

type SendRegistrationCodeInput = RouterInputs['auth']['sendRegistrationCode'];

export function RegisterForm() {
    const { push } = useRouter();
    const { mutate } = api.auth.sendRegistrationCode.useMutation({
        onSuccess: (_data, { email }) => {
            push(
                Routes.verify(
                    {},
                    {
                        search: {
                            email,
                        },
                    }
                )
            );
        },
        onError: () => {
            toast.error('Failed to send verification code');
        },
    });

    const form = useForm<SendRegistrationCodeInput>({
        resolver: zodResolver(sendRegistrationCodeInput),
        defaultValues: {
            email: '',
        },
    });

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(values => mutate(values))} className='space-y-4'>
                <FormField
                    control={form.control}
                    name='email'
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormDescription>
                                We will send you a verification link at the following email.
                            </FormDescription>
                            <FormControl>
                                <Input placeholder='hey@hushos.com' {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name='agree'
                    render={({ field }) => (
                        <FormItem className='flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4'>
                            <FormControl>
                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                            </FormControl>
                            <div className='space-y-1 leading-none'>
                                <FormLabel>By checking this box: </FormLabel>
                                <FormDescription>
                                    You are agreeing to our{' '}
                                    <Link href={Routes.terms()} className='text-blue-600 underline'>
                                        Terms of Service
                                    </Link>{' '}
                                    and{' '}
                                    <Link
                                        href={Routes.privacy()}
                                        className='text-blue-600 underline'>
                                        Privacy Policy
                                    </Link>
                                    .
                                </FormDescription>
                                <FormMessage />
                            </div>
                        </FormItem>
                    )}
                />
                <Button type='submit'>Continue</Button>
            </form>
        </Form>
    );
}
