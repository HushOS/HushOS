import { ReactNode } from 'react';

export default function BlogLayout({ children }: { children: ReactNode }) {
    return <div className='mx-auto max-w-screen-md space-y-8 px-4 pt-32'>{children}</div>;
}
