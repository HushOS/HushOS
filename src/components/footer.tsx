import Link from 'next/link';
import { FacebookIcon, GithubIcon, TwitterIcon } from 'lucide-react';

import { Container, Section } from '@/components/craft';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Routes } from '@/lib/routes';

export function Footer() {
    return (
        <footer>
            <Section>
                <Container className='grid gap-6'>
                    <div className='not-prose flex flex-col gap-6'>
                        <Link href='/'>
                            <h3 className='sr-only'>HushOS</h3>
                            <Logo className='size-8 transition-all hover:opacity-75' />
                        </Link>
                        <p className='text-pretty'>
                            HushOS is an open source, privacy first, end-to-end encrypted
                            productivity OS!
                        </p>
                        <div className='flex gap-2'>
                            <Button variant='outline' size='icon'>
                                <GithubIcon />
                            </Button>
                            <Button variant='outline' size='icon'>
                                <TwitterIcon />
                            </Button>
                            <Button variant='outline' size='icon'>
                                <FacebookIcon />
                            </Button>
                        </div>
                    </div>
                </Container>
                <Container className='not-prose items-center justify-between border-t text-sm md:flex'>
                    <div className='mb-6 flex flex-col gap-4 underline decoration-muted underline-offset-4 md:mb-0 md:flex-row'>
                        <Link href={Routes.privacy()}>Privacy</Link>
                        <Link href={Routes.terms()}>Terms</Link>
                        <Link href={Routes.gdpr()}>GDPR</Link>
                    </div>
                    <p className='text-muted-foreground'>
                        © <a href='https://github.com/brijr/components'>HushOS, Inc.</a> All rights
                        reserved. 2024-present.
                    </p>
                </Container>
            </Section>
        </footer>
    );
}
