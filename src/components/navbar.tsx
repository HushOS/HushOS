'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';

import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
    NavigationMenu,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
} from '@/components/ui/navigation-menu';
import { Separator } from '@/components/ui/separator';
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { Routes } from '@/lib/routes';

const routeList = [
    {
        href: Routes.login(),
        label: 'Login',
    },
    {
        href: Routes.getStarted(),
        label: 'Get Started',
    },
];

export function Navbar() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <header className='sticky top-5 z-40 mx-auto flex w-[90%] items-center justify-between rounded-2xl border border-secondary bg-card/15 p-2 shadow-inner md:w-[70%] lg:w-3/4 lg:max-w-5xl'>
            <Link href='/' className='flex items-center text-lg font-bold'>
                <Logo className='mr-2 size-6' />
                HushOS
            </Link>

            {/* <!-- Mobile --> */}
            <div className='flex items-center lg:hidden'>
                <Sheet open={isOpen} onOpenChange={setIsOpen}>
                    <SheetTrigger>
                        <Menu
                            onClick={() => setIsOpen(!isOpen)}
                            className='cursor-pointer lg:hidden'
                        />
                    </SheetTrigger>

                    <SheetContent className='flex flex-col justify-between rounded-r-2xl border-secondary bg-card'>
                        <div>
                            <SheetHeader className='mb-4 ml-4'>
                                <SheetTitle className='flex items-center'>
                                    <Link href='/' className='flex items-center'>
                                        <Logo className='mr-2 size-6' />
                                        HushOS
                                    </Link>
                                </SheetTitle>
                            </SheetHeader>

                            <div className='flex flex-col gap-2'>
                                {routeList.map(({ href, label }) => (
                                    <Button
                                        key={href}
                                        onClick={() => setIsOpen(false)}
                                        asChild
                                        variant='ghost'
                                        className='justify-start text-base'>
                                        <Link href={href}>{label}</Link>
                                    </Button>
                                ))}
                            </div>
                        </div>

                        <SheetFooter className='flex-col items-start justify-start sm:flex-col'>
                            <Separator className='mb-2' />

                            <ThemeToggle />
                        </SheetFooter>
                    </SheetContent>
                </Sheet>
            </div>

            {/* <!-- Desktop --> */}
            <div className='hidden items-center gap-4 lg:flex'>
                <NavigationMenu>
                    <NavigationMenuList>
                        <NavigationMenuItem>
                            {routeList.map(({ href, label }) => (
                                <NavigationMenuLink key={href} asChild>
                                    <Link href={href} className='px-2 text-base'>
                                        {label}
                                    </Link>
                                </NavigationMenuLink>
                            ))}
                        </NavigationMenuItem>
                    </NavigationMenuList>
                </NavigationMenu>

                <ThemeToggle />
            </div>
        </header>
    );
}
