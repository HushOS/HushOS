import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/drop')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <div className='grid h-full place-items-center'>
            <header className='container flex flex-col gap-1 text-center'>
                <h1 className='font-mono text-2xl font-bold'>HushDrop</h1>
                <p className='text-muted-foreground text-lg'>Secure drops, simplified.</p>
            </header>
        </div>
    );
}
