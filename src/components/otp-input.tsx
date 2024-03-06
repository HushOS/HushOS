'use client';

import React, { ComponentProps } from 'react';
import { OTPInput as OtpInput } from 'input-otp';

import { cn } from '@/lib/utils';

type InputProps = Pick<ComponentProps<typeof OtpInput>, 'value' | 'onChange'>;

const OTPInput = React.forwardRef<HTMLInputElement, InputProps>(({ onChange, value }, ref) => {
    return (
        <OtpInput
            maxLength={6}
            containerClassName='group flex items-center has-[:disabled]:opacity-30'
            render={({ slots }) => (
                <>
                    <div className='flex'>
                        {slots.slice(0, 3).map((slot, idx) => (
                            <Slot key={idx} {...slot} />
                        ))}
                    </div>

                    <FakeDash />

                    <div className='flex'>
                        {slots.slice(3).map((slot, idx) => (
                            <Slot key={idx} {...slot} />
                        ))}
                    </div>
                </>
            )}
            ref={ref}
            value={value}
            onChange={onChange}
        />
    );
});

OTPInput.displayName = 'OTPInput';

export { OTPInput };

function Slot(props: { char: string | null; isActive: boolean }) {
    return (
        <div
            className={cn(
                'relative h-14 w-10 text-[2rem]',
                'flex items-center justify-center',
                'transition-all duration-300',
                'border-y border-r border-border first:rounded-l-md first:border-l last:rounded-r-md',
                'group-focus-within:border-accent-foreground/20 group-hover:border-accent-foreground/20',
                'outline outline-0 outline-accent-foreground/20',
                { 'z-10 outline-4 outline-accent-foreground': props.isActive }
            )}>
            {props.char !== null && <div>{props.char}</div>}
            {props.char === null && props.isActive && <FakeCaret />}
        </div>
    );
}

function FakeCaret() {
    return (
        <div className='pointer-events-none absolute inset-0 flex animate-caret-blink items-center justify-center'>
            <div className='h-8 w-px bg-foreground' />
        </div>
    );
}

function FakeDash() {
    return (
        <div className='flex w-10 items-center justify-center'>
            <div className='h-1 w-3 rounded-full bg-border' />
        </div>
    );
}
