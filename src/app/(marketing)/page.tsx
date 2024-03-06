import { Waitlist } from '@/app/(marketing)/waitlist';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';

export default function Page() {
    return (
        <div className='container h-full'>
            <div className='grid max-w-prose gap-4'>
                <div className='flex items-center justify-between pt-24'>
                    <div className='flex items-center gap-2'>
                        <Logo className='size-12' />
                        <h1 className='text-4xl font-semibold'>HushOS</h1>
                    </div>
                    <ThemeToggle />
                </div>
                <div className='my-4 space-y-4 leading-relaxed'>
                    <p>An open source, privacy first, end-to-end encrypted productivity OS!</p>
                    <p>
                        Join the waitlist and be ready to take control of your privacy, as we launch
                        our first offering, HushDrive, an E2EE cloud storage.
                    </p>
                </div>
                <Waitlist />
            </div>
        </div>
    );
}
