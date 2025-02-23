import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
    component: Home,
});

function Home() {
    return (
        <div className='grid h-full place-items-center'>
            <header className='container flex flex-col gap-2 text-center'>
                <h1 className='font-mono text-4xl font-bold'>HushOS</h1>
                <p className='animate-wiggle text-6xl'>😴</p>
            </header>
        </div>
    );
}
