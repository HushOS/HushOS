import { ReactNode } from 'react';

import { Container, Main } from '@/components/craft';

export default function PageLayout({ children }: { children: ReactNode }) {
    return (
        <Main>
            <Container>{children}</Container>
        </Main>
    );
}
