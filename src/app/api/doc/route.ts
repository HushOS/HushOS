import { NextResponse } from 'next/server';

import { generateAPIDoc } from '@/server/generate-api-doc';

export function GET() {
    return NextResponse.json(generateAPIDoc());
}
