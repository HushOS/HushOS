import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { registry } from '@/server/routes';

export function generateAPIDoc() {
    const generator = new OpenApiGeneratorV31(registry.definitions);
    return generator.generateDocument({
        openapi: '3.1.0',
        info: {
            version: '1.0.0',
            title: 'HushOS API',
        },
    });
}
