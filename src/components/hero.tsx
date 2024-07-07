import Link from 'next/link';

import { Container, Section } from '@/components/craft';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Routes } from '@/lib/routes';

export function Hero() {
    return (
        <Section>
            <Container className='flex flex-col items-center text-center'>
                <Logo className='not-prose mb-6 size-20 md:mb-8' />
                <h1 className='!mb-0 text-balance'>End-to-end encrypted productivity OS!</h1>
                <h3 className='text-balance text-muted-foreground'>
                    HushOS is an open source, privacy first, end-to-end encrypted productivity OS!
                    We are building HushOS with self-hosting in mind, so that anyone can issue a few
                    commands and have their own personal productivity cloud up and running.
                </h3>
                <div className='not-prose mt-6 flex gap-2 md:mt-12'>
                    <Button asChild>
                        <Link href={Routes.getStarted()}>Get Started</Link>
                    </Button>
                    <Button variant={'ghost'} asChild>
                        <Link href='https://github.com/HushOS' target='_blank' rel='noreferrer'>
                            Contribue -{'>'}
                        </Link>
                    </Button>
                </div>
            </Container>
        </Section>
    );
}
