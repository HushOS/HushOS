import { Waitlist } from '@/app/(marketing)/waitlist';
import { Logo } from '@/components/logo';

export default function Page() {
    return (
        <div className='container h-full'>
            <div className='grid gap-4'>
                <div className='flex items-center gap-2 pt-24'>
                    <Logo className='size-12' />
                    <h1 className='text-4xl font-semibold'>HushOS</h1>
                </div>
                <div className='my-4 max-w-prose space-y-4 leading-relaxed'>
                    <p>An open source, privacy first, end-to-end encrypted productivity OS!</p>
                    <p>
                        We are building HushOS with self-hosting in mind, so that anyone can issue a
                        few commands and have their own personal productivity cloud up and running.
                    </p>
                    <p>
                        So join the waitlist and be ready to take control of your privacy, as we
                        launch our first offering, HushDrive, an E2EE cloud storage service.
                    </p>
                </div>
                <Waitlist />
            </div>
        </div>
    );
}
