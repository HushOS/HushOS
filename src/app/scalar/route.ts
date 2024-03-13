import { ApiReference } from '@scalar/nextjs-api-reference';

import { generateAPIDoc } from '@/server/generate-api-doc';

export const GET = ApiReference({
    spec: {
        content: () => {
            return generateAPIDoc();
        },
    },
});
